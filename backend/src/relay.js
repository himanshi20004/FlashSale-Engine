import { bus } from './redis.js';
import { col } from './db.js';
import crypto from 'node:crypto';

export const STREAM = 'events:booking';
const GROUP = 'notifier';
const me = crypto.randomUUID();

/* Transactional-outbox relay: Mongo outbox -> durable Redis Stream (AOF Redis). At-least-once; consumers dedupe. */
async function leader() {
  if (await bus.set('relay:leader', me, 'PX', 3000, 'NX')) return true;
  if ((await bus.get('relay:leader')) === me) { await bus.pexpire('relay:leader', 3000); return true; }
  return false;
}

async function flush() {
  if (!(await leader())) return 0;
  const docs = await col.outbox.find({ publishedAt: null }).sort({ _id: 1 }).limit(200).toArray();
  if (!docs.length) return 0;
  const p = bus.pipeline();
  for (const d of docs)
    p.xadd(STREAM, 'MAXLEN', '~', 1000000, '*', 'id', String(d._id), 'type', d.type, 'agg', String(d.aggregateId), 'payload', JSON.stringify(d.payload));
  const res = await p.exec();
  if (res.some(([err]) => err)) throw new Error('xadd failed'); // not marked published => retried
  await col.outbox.updateMany({ _id: { $in: docs.map((d) => d._id) } }, { $set: { publishedAt: new Date() } });
  return docs.length;
}

export function startRelay() {
  (async function loop() {
    for (;;) {
      let n = 0;
      try { n = await flush(); } catch (e) { console.error('[relay]', e.message); }
      await new Promise((r) => setTimeout(r, n ? 20 : 250));
    }
  })();
}

/* Consumer: notifications + analytics. Idempotent via a seen-set; ack after processing. */
export async function startConsumer() {
  const c = bus.duplicate({ enableOfflineQueue: true, maxRetriesPerRequest: null });
  c.on('error', () => {});
  await c.xgroup('CREATE', STREAM, GROUP, '0', 'MKSTREAM').catch((e) => { if (!String(e.message).includes('BUSYGROUP')) throw e; });
  const name = 'c-' + me.slice(0, 8);

  async function handle(entries) {
    for (const [id, f] of entries) {
      const m = {}; for (let i = 0; i < f.length; i += 2) m[f[i]] = f[i + 1];
      if (await bus.set('seen:' + m.id, 1, 'EX', 86400, 'NX')) {
        const p = JSON.parse(m.payload);
        const line = `[notify] ${m.type} user=${p.userId} hold=${p.holdId}${p.reason ? ' reason=' + p.reason : ''}`;
        await bus.lpush('notifications:recent', line);
        await bus.ltrim('notifications:recent', 0, 99);
        await bus.hincrby('analytics:counts', m.type, 1);
      }
      await bus.xack(STREAM, GROUP, id);
    }
  }

  (async function loop() {
    let start = '0'; // first drain our own pending entries, then switch to new ones
    for (;;) {
      try {
        const r = await c.xreadgroup('GROUP', GROUP, name, 'COUNT', 100, 'BLOCK', 2000, 'STREAMS', STREAM, start);
        const entries = r?.[0]?.[1] ?? [];
        if (start === '0' && entries.length === 0) start = '>';
        if (entries.length) await handle(entries);
      } catch (e) {
        if (String(e.message).includes('NOGROUP'))
          await c.xgroup('CREATE', STREAM, GROUP, '0', 'MKSTREAM').catch(() => {});
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  })();
}
