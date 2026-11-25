import { redis, K, runId } from './redis.js';
import { col } from './db.js';
import { gate } from './gate.js';
import { itemIds } from './booking.js';

/* Rebuild Redis state for one item from MongoDB (the source of truth):
   free = all seats - booked seats - seats of live (unexpired) HELD holds. */
export async function rebuildItem(itemId) {
  const item = await col.items.findOne({ _id: itemId });
  if (!item) throw new Error('unknown item ' + itemId);
  const taken = new Set((await col.bookings.find({ itemId }).project({ seatId: 1 }).toArray()).map((b) => b.seatId));
  const live = await col.holds.find({ itemId, status: 'HELD', expiresAt: { $gt: new Date() } }).toArray();
  for (const h of live) h.seatIds.forEach((s) => taken.add(s));

  // purge stale hold keys that a promoted replica may carry
  for (const pat of [`hold:{${itemId}}:*`, `holddata:{${itemId}}:*`, `uh:{${itemId}}:*`]) {
    for await (const keys of redis.scanStream({ match: pat, count: 500 })) if (keys.length) await redis.del(...keys);
  }
  const tmp = K.free(itemId) + ':tmp';
  await redis.del(tmp, K.holdsExp(itemId));
  const free = [];
  for (let s = 1; s <= item.totalSeats; s++) if (!taken.has(s)) free.push(String(s));
  for (let i = 0; i < free.length; i += 1000) await redis.sadd(tmp, ...free.slice(i, i + 1000));
  if (free.length) await redis.rename(tmp, K.free(itemId)); else await redis.del(K.free(itemId));

  const p = redis.pipeline();
  for (const h of live) {
    const ms = Math.max(1, h.expiresAt.getTime() - Date.now());
    p.set(K.hold(itemId, h._id), '1', 'PX', ms);
    p.hset(K.holdData(itemId, h._id), 'user', h.userId, 'seats', h.seatIds.join(','), 'item', itemId);
    p.zadd(K.holdsExp(itemId), h.expiresAt.getTime(), h._id);
    p.set(K.userHold(itemId, h.userId), h._id, 'PX', ms);
  }
  await p.exec();
  return { itemId, free: free.length, liveHolds: live.length, booked: taken.size - live.reduce((n, h) => n + h.seatIds.length, 0) };
}

export async function rebuildAll() {
  const out = [];
  for (const id of await itemIds()) out.push(await rebuildItem(id));
  return out;
}

/* Detect Redis restart / failover via run_id; rebuild BEFORE re-opening admission. */
async function tick() {
  let id;
  try { id = await runId(); } catch { gate.open = false; return; }
  let ready = null;
  try { ready = await redis.get('sys:ready'); } catch { gate.open = false; return; }
  if (ready === id) { gate.open = true; return; }
  gate.open = false;
  const got = await redis.set('sys:rebuild', id, 'PX', 60000, 'NX').catch(() => null);
  if (!got) return; // another instance is rebuilding; we stay closed until sys:ready matches
  try {
    const t0 = Date.now();
    const res = await rebuildAll();
    await redis.set('sys:ready', id);
    console.log(`[reconcile] rebuilt ${res.length} item(s) in ${Date.now() - t0}ms (redis run_id ${id.slice(0, 8)})`, JSON.stringify(res));
  } catch (e) {
    console.error('[reconcile] failed:', e.message);
  } finally {
    await redis.del('sys:rebuild').catch(() => {});
  }
}

export function startReconciler() {
  let busy = false;
  const run = async () => { if (busy) return; busy = true; try { await tick(); } finally { busy = false; } };
  run();
  setInterval(run, 1000).unref();
}
