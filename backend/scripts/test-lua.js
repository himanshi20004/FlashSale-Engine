// Tests the atomic Redis scripts against a real Redis (REDIS_URL, default localhost:6379).
// WARNING: flushes the selected Redis DB.
import assert from 'node:assert/strict';
import { redis, K, holdSeats, releaseHoldSeats, confirmSeats, restoreSeats } from '../src/redis.js';
import { randomUUID } from 'node:crypto';

const item = 'T';
async function reset(n) {
  await redis.flushdb();
  await redis.sadd(K.free(item), ...Array.from({ length: n }, (_, i) => String(i + 1)));
}
const exp = () => Date.now() + 60000;
await new Promise((r) => redis.once('ready', r));

// 1. basic hold / already-holding / sold-out
await reset(3);
let h1 = await holdSeats(item, 'alice', randomUUID(), 2, exp());
assert.equal(h1.code, 1); assert.equal(h1.seats.length, 2);
assert.equal((await holdSeats(item, 'alice', randomUUID(), 1, exp())).code, -1, 'one active hold per user');
assert.equal((await holdSeats(item, 'bob', randomUUID(), 2, exp())).code, -2, 'insufficient stock');
assert.equal((await holdSeats(item, 'bob', randomUUID(), 1, exp())).code, 1);
assert.equal((await holdSeats(item, 'carol', randomUUID(), 1, exp())).code, -2, 'sold out');
console.log('ok  hold basics');

// 2. release is idempotent and returns seats exactly once
await reset(2);
const id = randomUUID();
const h = await holdSeats(item, 'u1', id, 2, exp());
assert.equal(await releaseHoldSeats(item, id), 1);
assert.equal(await releaseHoldSeats(item, id), 0);
assert.equal(await redis.scard(K.free(item)), 2);
assert.equal((await holdSeats(item, 'u1', randomUUID(), 1, exp())).code, 1, 'user can hold again after release');
console.log('ok  release idempotent');

// 3. confirm: live hold consumed (1); expired hold re-claimed (2); seat taken -> 0
await reset(2);
const a = randomUUID(); const ha = await holdSeats(item, 'u1', a, 1, exp());
assert.equal(await confirmSeats(item, a, 'u1', ha.seats), 1);
assert.equal(await redis.scard(K.free(item)), 1, 'confirmed seat stays out of free set');
const b = randomUUID(); const hb = await holdSeats(item, 'u2', b, 1, exp());
await releaseHoldSeats(item, b);                                   // simulates TTL expiry
assert.equal(await confirmSeats(item, b, 'u2', hb.seats), 2, 'late payment re-claims free seat');
await reset(1);
const c = randomUUID(); const hc = await holdSeats(item, 'u3', c, 1, exp());
await releaseHoldSeats(item, c);
const d = await holdSeats(item, 'u4', randomUUID(), 1, exp());      // someone else grabs the seat
assert.equal(d.code, 1);
assert.equal(await confirmSeats(item, c, 'u3', hc.seats), 0, 'late payment, seat gone -> refund path');
console.log('ok  confirm paths (alive / late-reclaimed / late-lost)');

// 4. contention: 5000 concurrent users, 1000 seats -> exactly 1000 winners, zero duplicate seats
await reset(1000);
const results = await Promise.all(Array.from({ length: 5000 }, (_, i) => holdSeats(item, 'user' + i, randomUUID(), 1, exp())));
const wins = results.filter((r) => r.code === 1);
const seatSet = new Set(wins.flatMap((r) => r.seats));
assert.equal(wins.length, 1000);
assert.equal(seatSet.size, 1000, 'no seat handed out twice');
assert.equal(results.filter((r) => r.code === -2).length, 4000);
assert.equal(await redis.scard(K.free(item)), 0);
console.log(`ok  contention: 5000 concurrent -> ${wins.length} holds, ${seatSet.size} distinct seats, 0 oversell`);

// 5. queue: FIFO + token-bucket bounded admission
await redis.flushdb();
for (let i = 0; i < 10; i++) await redis.flashJoin(K.queue(item), K.admitted(item), K.qseq(item), 'q' + i);
assert.equal(await redis.flashJoin(K.queue(item), K.admitted(item), K.qseq(item), 'q3'), 4, 'join is idempotent, rank stable');
const adm = await redis.flashAdmit(K.queue(item), K.admitted(item), 4, Date.now(), 60000, 6);
assert.deepEqual(adm, ['q0', 'q1', 'q2', 'q3'], 'FIFO order');
const adm2 = await redis.flashAdmit(K.queue(item), K.admitted(item), 4, Date.now(), 60000, 6);
assert.equal(adm2.length, 2, 'MAX_ACTIVE caps concurrent admitted users');
assert.equal(await redis.flashJoin(K.queue(item), K.admitted(item), K.qseq(item), 'q0'), -1);
console.log('ok  queue FIFO + admission cap');

await redis.flushdb();
console.log('ALL LUA TESTS PASSED');
process.exit(0);
