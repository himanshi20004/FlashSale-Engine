import Redis from 'ioredis';
import { cfg } from './config.js';
import { redisOperationDurationSeconds, redisErrorsTotal } from './metrics.js';

const opts = {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false, // fail fast while Redis is down instead of piling up requests
  retryStrategy: (n) => Math.min(n * 100, 1000),
};
export const redis = new Redis(cfg.redisUrl, opts);
export const bus = new Redis(cfg.busUrl, { ...opts, enableOfflineQueue: true, maxRetriesPerRequest: 3 });
redis.on('error', () => {});
bus.on('error', () => {});

export const K = {
  free: (i) => `free:{${i}}`,
  hold: (i, id) => `hold:{${i}}:${id}`,
  holdData: (i, id) => `holddata:{${i}}:${id}`,
  holdsExp: (i) => `holdsexp:{${i}}`,
  userHold: (i, u) => `uh:{${i}}:${u}`,
  queue: (i) => `queue:{${i}}`,
  admitted: (i) => `admitted:{${i}}`,
  qseq: (i) => `queueseq:{${i}}`,
  qjoined: (i) => `qjoined:{${i}}`,
};

/* ---------------- Lua scripts (each runs atomically inside Redis) ---------------- */

// HOLD: check user has no hold, check stock, pop N seats, create hold key (TTL) + data + expiry index.
// KEYS: free, hold, holddata, holdsexp, userhold   ARGV: qty, ttl_ms, holdId, expiry_ms, item, user
redis.defineCommand('flashHold', {
  numberOfKeys: 5,
  lua: `
if redis.call('EXISTS', KEYS[5]) == 1 then return {-1} end
local qty = tonumber(ARGV[1])
if redis.call('SCARD', KEYS[1]) < qty then return {-2} end
local seats = redis.call('SPOP', KEYS[1], qty)
local csv = table.concat(seats, ',')
redis.call('SET', KEYS[2], '1', 'PX', ARGV[2])
redis.call('HSET', KEYS[3], 'user', ARGV[6], 'seats', csv, 'item', ARGV[5])
redis.call('ZADD', KEYS[4], ARGV[4], ARGV[3])
redis.call('SET', KEYS[5], ARGV[3], 'PX', ARGV[2])
return {1, csv}
`,
});

// RELEASE: return seats to the free set. Idempotent: no hold data => no-op.
// KEYS: free, hold, holddata, holdsexp   ARGV: holdId, item
redis.defineCommand('flashRelease', {
  numberOfKeys: 4,
  lua: `
local csv = redis.call('HGET', KEYS[3], 'seats')
if not csv then
  redis.call('ZREM', KEYS[4], ARGV[1]); redis.call('DEL', KEYS[2])
  return 0
end
local user = redis.call('HGET', KEYS[3], 'user')
for s in string.gmatch(csv, '[^,]+') do redis.call('SADD', KEYS[1], s) end
redis.call('DEL', KEYS[2], KEYS[3])
redis.call('ZREM', KEYS[4], ARGV[1])
local uk = 'uh:{' .. ARGV[2] .. '}:' .. user
if redis.call('GET', uk) == ARGV[1] then redis.call('DEL', uk) end
return 1
`,
});

// CONFIRM (seat side): hold alive => consume it (return 1).
// hold gone (expired/failover) => try to re-claim the SAME seats from the free set, all-or-nothing (return 2) else 0.
// KEYS: free, hold, holddata, holdsexp   ARGV: holdId, item, user, seatsCsv
redis.defineCommand('flashConfirm', {
  numberOfKeys: 4,
  lua: `
local csv = redis.call('HGET', KEYS[3], 'seats')
if csv then
  redis.call('DEL', KEYS[2], KEYS[3])
  redis.call('ZREM', KEYS[4], ARGV[1])
  local uk = 'uh:{' .. ARGV[2] .. '}:' .. ARGV[3]
  if redis.call('GET', uk) == ARGV[1] then redis.call('DEL', uk) end
  return 1
end
for s in string.gmatch(ARGV[4], '[^,]+') do
  if redis.call('SISMEMBER', KEYS[1], s) == 0 then return 0 end
end
for s in string.gmatch(ARGV[4], '[^,]+') do redis.call('SREM', KEYS[1], s) end
return 2
`,
});

// QUEUE JOIN: strictly FIFO via a monotonic sequence as ZSET score. Idempotent per user.
// KEYS: queue, admitted, seq   ARGV: user      returns rank (1-based) or -1 if already admitted
redis.defineCommand('flashJoin', {
  numberOfKeys: 3,
  lua: `
if redis.call('ZSCORE', KEYS[2], ARGV[1]) then return -1 end
if redis.call('ZSCORE', KEYS[1], ARGV[1]) then return redis.call('ZRANK', KEYS[1], ARGV[1]) + 1 end
local seq = redis.call('INCR', KEYS[3])
redis.call('ZADD', KEYS[1], seq, ARGV[1])
return redis.call('ZRANK', KEYS[1], ARGV[1]) + 1
`,
});

// ADMIT: pop up to N from queue head, bounded by MAX_ACTIVE concurrently admitted users.
// KEYS: queue, admitted   ARGV: n, now_ms, ttl_ms, max_active
redis.defineCommand('flashAdmit', {
  numberOfKeys: 2,
  lua: `
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[2])
local room = tonumber(ARGV[4]) - redis.call('ZCARD', KEYS[2])
local n = math.min(tonumber(ARGV[1]), room)
if n <= 0 then return {} end
local popped = redis.call('ZPOPMIN', KEYS[1], n)
local users = {}
for i = 1, #popped, 2 do
  redis.call('ZADD', KEYS[2], tonumber(ARGV[2]) + tonumber(ARGV[3]), popped[i])
  users[#users + 1] = popped[i]
end
return users
`,
});

/* ---------------- typed wrappers ---------------- */

async function timedRedisOp(operation, fn) {
  const t0 = process.hrtime.bigint();
  try {
    return await fn();
  } catch (e) {
    redisErrorsTotal.inc({ role: 'hot', operation });
    throw e;
  } finally {
    const dur = Number(process.hrtime.bigint() - t0) / 1e9;
    redisOperationDurationSeconds.observe({ operation }, dur);
  }
}

export async function holdSeats(item, user, holdId, qty, expMs) {
  const ttl = Math.max(1, expMs - Date.now());
  const r = await timedRedisOp('flashHold', () =>
    redis.flashHold(K.free(item), K.hold(item, holdId), K.holdData(item, holdId),
      K.holdsExp(item), K.userHold(item, user), qty, ttl, holdId, expMs, item, user));
  return { code: r[0], seats: r[0] === 1 ? String(r[1]).split(',').map(Number) : [] };
}
export const releaseHoldSeats = (item, id) =>
  timedRedisOp('flashRelease', () =>
    redis.flashRelease(K.free(item), K.hold(item, id), K.holdData(item, id), K.holdsExp(item), id, item));
export const confirmSeats = (item, id, user, seats) =>
  timedRedisOp('flashConfirm', () =>
    redis.flashConfirm(K.free(item), K.hold(item, id), K.holdData(item, id), K.holdsExp(item), id, item, user, seats.join(',')));
export const restoreSeats = (item, seats) =>
  (seats.length ? timedRedisOp('restoreSeats', () => redis.sadd(K.free(item), ...seats.map(String))) : 0);
export const removeAdmitted = (item, user) =>
  timedRedisOp('removeAdmitted', () => redis.zrem(K.admitted(item), user));
export const freeCount = (item) =>
  timedRedisOp('freeCount', () => redis.scard(K.free(item)));
export const activeHoldCount = (item) =>
  timedRedisOp('activeHoldCount', () => redis.zcard(K.holdsExp(item)));
export const dueHolds = (item, nowMs) =>
  timedRedisOp('dueHolds', () => redis.zrangebyscore(K.holdsExp(item), '-inf', nowMs, 'LIMIT', 0, 500));

export async function runId() {
  const info = await timedRedisOp('info_server', () => redis.info('server'));
  const m = /run_id:(\w+)/.exec(info);
  return m ? m[1] : 'unknown';
}
