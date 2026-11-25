import crypto from 'node:crypto';
import { redis, K, freeCount, activeHoldCount } from './redis.js';
import { cfg } from './config.js';
import { gate } from './gate.js';
import { itemIds } from './booking.js';
import { recordAdmissions, redisOperationDurationSeconds, redisErrorsTotal } from './metrics.js';

/* ---------- token bucket ---------- */
export class Bucket {
  constructor(rate, burst) { this.rate = rate; this.burst = burst; this.tokens = burst; this.last = Date.now(); }
  _refill() {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
  }
  available() { this._refill(); return Math.floor(this.tokens); }
  consume(n) { this.tokens -= n; }
  allow() { this._refill(); if (this.tokens >= 1) { this.tokens -= 1; return true; } return false; }
}

/* ---------- signed queue tokens (stateless verification) ---------- */
const b64 = (b) => Buffer.from(b).toString('base64url');
const mac = (payload) => crypto.createHmac('sha256', cfg.tokenSecret).update(payload).digest('base64url');

export function signToken(claims) {
  const p = b64(JSON.stringify(claims));
  return `${p}.${mac(p)}`;
}
export function verifyToken(tok) {
  if (typeof tok !== 'string') return null;
  const [p, sig] = tok.split('.');
  if (!p || !sig) return null;
  const good = mac(p);
  const a = Buffer.from(sig), b = Buffer.from(good);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const c = JSON.parse(Buffer.from(p, 'base64url').toString());
    return c.e > Date.now() ? c : null;
  } catch { return null; }
}

/* ---------- queue operations ---------- */
export async function joinQueue(itemId, userId) {
  const t0 = process.hrtime.bigint();
  try {
    const r = await redis.flashJoin(K.queue(itemId), K.admitted(itemId), K.qseq(itemId), userId);
    if (r > 0) {
      await redis.hsetnx(K.qjoined(itemId), userId, String(Date.now())).catch(() => {});
    }
    return r;
  } catch (e) {
    redisErrorsTotal.inc({ role: 'hot', operation: 'flashJoin' });
    throw e;
  } finally {
    redisOperationDurationSeconds.observe({ operation: 'flashJoin' }, Number(process.hrtime.bigint() - t0) / 1e9);
  }
}

async function soldOut(itemId) {
  const [free, holds] = await Promise.all([freeCount(itemId), activeHoldCount(itemId)]);
  return free === 0 && holds === 0;
}

export async function queueStatus(itemId, userId) {
  const exp = await redis.zscore(K.admitted(itemId), userId);
  if (exp) {
    return { state: 'admitted', token: signToken({ u: userId, i: itemId, e: Number(exp) }), expiresAt: Number(exp) };
  }
  const rank = await redis.zrank(K.queue(itemId), userId);
  if (rank === null) return { state: (await soldOut(itemId)) ? 'sold_out' : 'not_in_queue' };
  if (await soldOut(itemId)) return { state: 'sold_out' };
  const position = rank + 1;
  return { state: 'waiting', position, etaSeconds: Math.ceil(position / cfg.admitRate), queueLength: await redis.zcard(K.queue(itemId)) };
}

export const isSoldOut = soldOut;

/* ---------- admission controller (one leader across instances) ---------- */
const buckets = new Map();
const myId = crypto.randomUUID();

async function isLeader() {
  const ok = await redis.set('adm:leader', myId, 'PX', 2000, 'NX');
  if (ok) return true;
  if ((await redis.get('adm:leader')) === myId) { await redis.pexpire('adm:leader', 2000); return true; }
  return false;
}

export function startAdmissionController() {
  let busy = false;
  setInterval(async () => {
    if (busy || !gate.open) return; // paused while Redis is rebuilt: queue is not drained into a broken system
    busy = true;
    try {
      if (!(await isLeader())) return;
      for (const item of await itemIds()) {
        let b = buckets.get(item);
        if (!b) buckets.set(item, (b = new Bucket(cfg.admitRate, cfg.admitBurst)));
        const n = b.available();
        if (n < 1) continue;
        const now = Date.now();
        const t0 = process.hrtime.bigint();
        const users = await redis.flashAdmit(K.queue(item), K.admitted(item), n, now, cfg.admitTtlMs, cfg.maxActive);
        redisOperationDurationSeconds.observe({ operation: 'flashAdmit' }, Number(process.hrtime.bigint() - t0) / 1e9);
        b.consume(users.length);
        if (users.length) {
          const joinedTimes = await redis.hmget(K.qjoined(item), ...users).catch(() => []);
          await redis.hdel(K.qjoined(item), ...users).catch(() => {});
          const waitSecs = users.map((_, idx) => {
            const ts = Number(joinedTimes?.[idx]);
            return Number.isFinite(ts) && ts > 0 ? Math.max(0, (now - ts) / 1000) : 0;
          });
          recordAdmissions(item, waitSecs);
        }
      }
    } catch { /* redis down: gate/reconciler handle it */ } finally { busy = false; }
  }, 100).unref();
}
