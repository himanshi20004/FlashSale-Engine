import { redis, dueHolds } from './redis.js';
import { col } from './db.js';
import { gate } from './gate.js';
import { itemIds, releaseHold } from './booking.js';

let inflight = 0;
async function safeRelease(item, id) {
  if (!gate.open) return;
  inflight++;
  try { await releaseHold(item, id, 'EXPIRED'); } catch (e) { console.error('release failed', id, e.message); } finally { inflight--; }
}

export async function startExpiry() {
  // 1) fast path: Redis keyspace notification when hold:{item}:id TTL fires (fire-and-forget => not trusted alone)
  try { await redis.config('SET', 'notify-keyspace-events', 'Ex'); } catch { /* set via redis-server flag */ }
  const sub = redis.duplicate({ enableOfflineQueue: true, maxRetriesPerRequest: null });
  sub.on('error', () => {});
  await sub.subscribe('__keyevent@0__:expired').catch(() => {});
  sub.on('message', (_ch, key) => {
    if (!key.startsWith('hold:{') || inflight > 200) return; // sweepers pick up any overflow
    const rest = key.slice(6);
    const i = rest.indexOf('}:');
    if (i > 0) safeRelease(rest.slice(0, i), rest.slice(i + 2));
  });

  // 2) Redis sweeper: ZSET of expiry times is the authoritative index (handles missed notifications)
  setInterval(async () => {
    if (!gate.open) return;
    try {
      for (const item of await itemIds()) {
        const ids = await dueHolds(item, Date.now());
        await Promise.all(ids.map((id) => safeRelease(item, id)));
      }
    } catch { /* redis down */ }
  }, 1000).unref();

  // 3) Mongo sweeper: heals holds whose Redis state vanished or whose DB update failed
  setInterval(async () => {
    if (!gate.open) return;
    try {
      const stale = await col.holds.find({ status: 'HELD', expiresAt: { $lt: new Date(Date.now() - 10000) } })
        .limit(500).project({ itemId: 1 }).toArray();
      await Promise.all(stale.map((h) => safeRelease(h.itemId, h._id)));
    } catch { /* ignore */ }
  }, 5000).unref();
}
