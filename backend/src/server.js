import express from 'express';
import crypto from 'node:crypto';
import { cfg } from './config.js';
import { connectDb, col } from './db.js';
import { redis, bus, K, freeCount, activeHoldCount } from './redis.js';
import { gate } from './gate.js';
import * as booking from './booking.js';
import { Bucket, joinQueue, queueStatus, isSoldOut, verifyToken, startAdmissionController } from './admission.js';
import { startExpiry } from './expiry.js';
import { startReconciler, rebuildItem } from './reconcile.js';
import { startRelay, startConsumer } from './relay.js';

const app = express();
app.use(express.json({ limit: '100kb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  if (err instanceof booking.BookingError) return res.status(err.status).json({ error: err.code });
  const redisDown = /Stream isn't writeable|Connection is closed|ECONNREFUSED|READONLY/.test(String(err.message));
  if (redisDown) { gate.open = false; return res.set('Retry-After', '2').status(503).json({ error: 'system_warming_up' }); }
  console.error(err);
  res.status(500).json({ error: 'internal' });
});

const needGate = (_req, res, next) =>
  gate.open ? next() : res.set('Retry-After', '2').status(503).json({ error: 'system_warming_up' });

const needToken = (req, res, next) => {
  const c = verifyToken((req.headers.authorization || '').replace(/^Bearer /, ''));
  if (!c) return res.status(401).json({ error: 'invalid_or_expired_queue_token' });
  req.claims = c; next();
};
const needAdmin = (req, res, next) =>
  req.headers['x-admin-token'] === cfg.adminToken ? next() : res.status(401).json({ error: 'admin_only' });

const joinBucket = new Bucket(cfg.joinRps, cfg.joinRps);

/* ---------------- public ---------------- */
app.get('/healthz', (_req, res) => res.json({ ok: true, admissionOpen: gate.open }));

app.get('/api/items/:id', wrap(async (req, res) => {
  const item = await col.items.findOne({ _id: req.params.id });
  if (!item) return res.status(404).json({ error: 'not_found' });
  const [free, holds, qlen] = await Promise.all([freeCount(item._id), activeHoldCount(item._id), redis.zcard(K.queue(item._id))]);
  res.json({ itemId: item._id, name: item.name, totalSeats: item.totalSeats, pricePaise: item.pricePaise,
    available: free, activeHolds: holds, queueLength: qlen, admissionOpen: gate.open });
}));

/* ---------------- waiting room ---------------- */
app.post('/api/queue/join', needGate, wrap(async (req, res) => {
  if (!joinBucket.allow()) return res.set('Retry-After', '1').status(429).json({ error: 'busy' });
  const { itemId, userId } = req.body || {};
  if (!itemId || !userId || String(userId).length > 64) return res.status(400).json({ error: 'itemId_and_userId_required' });
  if (await isSoldOut(itemId)) return res.status(410).json({ error: 'sold_out' });
  const rank = await joinQueue(itemId, String(userId));
  res.json(rank === -1 ? { state: 'admitted' } : { state: 'waiting', position: rank, etaSeconds: Math.ceil(rank / cfg.admitRate) });
}));

app.get('/api/queue/status', wrap(async (req, res) => {
  res.json(await queueStatus(String(req.query.itemId), String(req.query.userId)));
}));

app.get('/api/queue/events', async (req, res) => { // SSE
  const itemId = String(req.query.itemId), userId = String(req.query.userId);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  let closed = false; req.on('close', () => { closed = true; });
  const t0 = Date.now();
  while (!closed && Date.now() - t0 < 30 * 60 * 1000) {
    let st;
    try { st = gate.open ? await queueStatus(itemId, userId) : { state: 'paused' }; } catch { st = { state: 'paused' }; }
    res.write(`data: ${JSON.stringify(st)}\n\n`);
    if (st.state === 'admitted' || st.state === 'sold_out') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  res.end();
});

/* ---------------- booking (admitted tokens only) ---------------- */
app.post('/api/holds', needToken, needGate, wrap(async (req, res) => {
  res.status(201).json(await booking.createHold(req.claims.i, req.claims.u, Number(req.body?.qty ?? 1)));
}));
app.get('/api/holds/:id', needToken, wrap(async (req, res) => {
  const h = await booking.getHold(req.params.id);
  if (!h || h.userId !== req.claims.u) return res.status(404).json({ error: 'not_found' });
  res.json({ holdId: h._id, status: h.status, seats: h.seatIds, expiresAt: h.expiresAt });
}));
app.delete('/api/holds/:id', needToken, needGate, wrap(async (req, res) => {
  res.json(await booking.cancelHold(req.params.id, req.claims.u));
}));

/* ---------------- payment webhook (HMAC-signed, idempotent) ---------------- */
const sign = (buf) => crypto.createHmac('sha256', cfg.webhookSecret).update(buf).digest('hex');

app.post('/webhooks/payment', wrap(async (req, res) => {
  const given = String(req.headers['x-signature'] || '');
  const good = sign(req.rawBody || Buffer.from(''));
  if (given.length !== good.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(good)))
    return res.status(401).json({ error: 'bad_signature' });
  const { status, body } = await booking.handlePayment(req.body);
  res.status(status).json(body);
}));

/* Mock payment provider (zero cost). Sends signed webhooks, optionally repeated concurrently = retry storm. */
if (cfg.mockPsp) {
  app.post('/dev/pay', wrap(async (req, res) => {
    const { holdId, eventId = crypto.randomUUID(), status = 'succeeded', repeat = 1 } = req.body || {};
    let amountPaise = req.body?.amountPaise;
    if (amountPaise === undefined) {
      const h = await booking.getHold(holdId);
      if (!h) return res.status(404).json({ error: 'unknown_hold' });
      const it = await col.items.findOne({ _id: h.itemId });
      amountPaise = it.pricePaise * h.seatIds.length;
    }
    const raw = JSON.stringify({ eventId, holdId, status, amountPaise });
    const out = await Promise.all(Array.from({ length: Math.min(Number(repeat), 50) }, async () => {
      const r = await fetch(cfg.selfUrl + '/webhooks/payment', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': sign(Buffer.from(raw)) }, body: raw });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    }));
    res.json({ eventId, results: out });
  }));
}

/* ---------------- admin ---------------- */
app.post('/admin/items', needAdmin, wrap(async (req, res) => {
  const { id, name = id, totalSeats, pricePaise = 100000 } = req.body || {};
  if (!id || !Number.isInteger(totalSeats) || totalSeats < 1) return res.status(400).json({ error: 'id_and_totalSeats_required' });
  if (req.query.reset === 'true') { // test convenience: wipe a previous run
    await Promise.all([col.bookings.deleteMany({ itemId: id }), col.holds.deleteMany({ itemId: id }),
      col.outbox.deleteMany({}), col.idem.deleteMany({}),
      redis.del(K.queue(id), K.admitted(id), K.qseq(id))]);
  }
  await col.items.updateOne({ _id: id }, { $set: { name, totalSeats, pricePaise } }, { upsert: true });
  booking.invalidateItems();
  res.json(await rebuildItem(id));
}));

app.get('/admin/verify/:id', needAdmin, wrap(async (req, res) => {
  const id = req.params.id;
  const item = await col.items.findOne({ _id: id });
  if (!item) return res.status(404).json({ error: 'not_found' });
  const [booked, dupes, outOfRange, held, byStatus, redisFree] = await Promise.all([
    col.bookings.countDocuments({ itemId: id }),
    col.bookings.aggregate([{ $match: { itemId: id } }, { $group: { _id: '$seatId', n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }]).toArray(),
    col.bookings.countDocuments({ itemId: id, $or: [{ seatId: { $lt: 1 } }, { seatId: { $gt: item.totalSeats } }] }),
    col.holds.aggregate([{ $match: { itemId: id, status: 'HELD', expiresAt: { $gt: new Date() } } },
      { $group: { _id: null, seats: { $sum: { $size: '$seatIds' } } } }]).toArray(),
    col.holds.aggregate([{ $match: { itemId: id } }, { $group: { _id: '$status', n: { $sum: 1 } } }]).toArray(),
    freeCount(id),
  ]);
  const heldSeats = held[0]?.seats ?? 0;
  const noOversell = booked <= item.totalSeats && dupes.length === 0 && outOfRange === 0;
  const conserved = booked + redisFree + heldSeats === item.totalSeats; // true when system is quiescent
  res.json({ itemId: id, totalSeats: item.totalSeats, booked, redisFree, heldSeats, duplicateSeats: dupes.length,
    outOfRange, noOversell, conserved, ok: noOversell && conserved,
    holdsByStatus: Object.fromEntries(byStatus.map((s) => [s._id, s.n])),
    analytics: await bus.hgetall('analytics:counts').catch(() => ({})),
    recentNotifications: await bus.lrange('notifications:recent', 0, 4).catch(() => []) });
}));

/* ---------------- boot ---------------- */
async function main() {
  await connectDb();
  startReconciler();
  startAdmissionController();
  await startExpiry();
  startRelay();
  if (cfg.runConsumer) await startConsumer();
  app.listen(cfg.port, () => console.log(`flashsale listening on :${cfg.port}`));
}
main().catch((e) => { console.error(e); process.exit(1); });
