import { randomUUID } from 'node:crypto';
import { col, inTx } from './db.js';
import * as R from './redis.js';
import { gate } from './gate.js';
import { cfg } from './config.js';
import {
  holdAttemptsTotal,
  bookingAttemptsTotal,
  bookingsConfirmedTotal,
  bookingsRefundedTotal,
  holdsExpiredTotal,
  holdsCancelledTotal,
  holdCreateDurationSeconds,
  holdConfirmDurationSeconds,
  inventorySoldOutRejectionsTotal,
} from './metrics.js';

export class BookingError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}
class ConcurrentConfirm extends Error {}

/* ---------- item catalogue cache (ids only) ---------- */
let itemCache = { at: 0, ids: [] };
export async function itemIds() {
  if (Date.now() - itemCache.at > 5000) {
    const docs = await col.items.find({}, { projection: { _id: 1 } }).toArray();
    itemCache = { at: Date.now(), ids: docs.map((d) => d._id) };
  }
  return itemCache.ids;
}
export const invalidateItems = () => { itemCache.at = 0; };

const outboxDoc = (aggregateId, type, payload) =>
  ({ aggregateId, type, payload, createdAt: new Date(), publishedAt: null });

/* ---------- HOLD ---------- */
export async function createHold(itemId, userId, qty) {
  const t0 = process.hrtime.bigint();
  let outcome = 'error';
  try {
    if (!gate.open) {
      outcome = 'warming_up';
      throw new BookingError('system_warming_up', 503);
    }
    if (!Number.isInteger(qty) || qty < 1 || qty > 4) {
      outcome = 'bad_quantity';
      throw new BookingError('bad_quantity', 400);
    }
    const id = randomUUID();
    const exp = Date.now() + cfg.holdTtlMs;
    const { code, seats } = await R.holdSeats(itemId, userId, id, qty, exp);
    if (code === -1) {
      outcome = 'already_holding';
      throw new BookingError('already_holding', 409);
    }
    if (code === -2) {
      outcome = 'sold_out';
      inventorySoldOutRejectionsTotal.inc({ item_id: itemId, stage: 'hold' });
      throw new BookingError('sold_out', 410);
    }
    try {
      await col.holds.insertOne({
        _id: id, itemId, userId, seatIds: seats, status: 'HELD',
        expiresAt: new Date(exp), createdAt: new Date(),
      });
    } catch (e) {
      await R.releaseHoldSeats(itemId, id).catch(() => {}); // compensate
      throw e;
    }
    outcome = 'created';
    return { holdId: id, itemId, seats, expiresAt: new Date(exp).toISOString() };
  } finally {
    const dur = Number(process.hrtime.bigint() - t0) / 1e9;
    holdAttemptsTotal.inc({ item_id: itemId, outcome });
    holdCreateDurationSeconds.observe({ item_id: itemId, outcome }, dur);
  }
}

export const getHold = (id) => col.holds.findOne({ _id: id });

export async function cancelHold(holdId, userId) {
  const h = await getHold(holdId);
  if (!h) throw new BookingError('not_found', 404);
  if (h.userId !== userId) throw new BookingError('forbidden', 403);
  if (h.status === 'HELD') await releaseHold(h.itemId, holdId, 'CANCELLED');
  return { holdId, status: (await getHold(holdId)).status };
}

/* ---------- RELEASE (TTL expiry, sweeper, explicit cancel). Idempotent. ---------- */
export async function releaseHold(itemId, holdId, newStatus = 'EXPIRED') {
  await R.releaseHoldSeats(itemId, holdId);
  let transitioned = false;
  await inTx(async (s) => {
    transitioned = false;
    const doc = await col.holds.findOneAndUpdate(
      { _id: holdId, status: 'HELD' },
      { $set: { status: newStatus, updatedAt: new Date() } },
      { session: s, returnDocument: 'after' });
    if (doc) {
      transitioned = true;
      await col.outbox.insertOne(outboxDoc(holdId,
        newStatus === 'EXPIRED' ? 'HoldExpired' : 'HoldCancelled',
        { holdId, itemId: doc.itemId, userId: doc.userId, seats: doc.seatIds }), { session: s });
    }
  });
  if (transitioned) {
    if (newStatus === 'EXPIRED') holdsExpiredTotal.inc({ item_id: itemId });
    else if (newStatus === 'CANCELLED') holdsCancelledTotal.inc({ item_id: itemId });
  }
}

/* ---------- PAYMENT WEBHOOK (idempotent, single-flight per event id) ---------- */
const isDup = (e, coll) =>
  (e?.code === 11000 || e?.writeErrors?.some?.((w) => w.code === 11000)) && String(e.message).includes(coll);

async function claimKey(key) {
  const now = new Date();
  try {
    await col.idem.insertOne({ _id: key, state: 'processing', startedAt: now, createdAt: now });
    return { replay: false };
  } catch (e) {
    if (e.code !== 11000) throw e;
  }
  const d = await col.idem.findOne({ _id: key });
  if (!d) return claimKey(key);
  if (d.state === 'done') return { replay: true, value: { status: d.statusCode, body: d.response } };
  // another worker is processing: take over only if its lease went stale
  const t = await col.idem.findOneAndUpdate(
    { _id: key, state: 'processing', startedAt: { $lt: new Date(Date.now() - 30000) } },
    { $set: { startedAt: new Date() } });
  if (t) return { replay: false };
  return { replay: true, value: { status: 503, body: { error: 'in_progress' } } }; // PSP will retry
}

const markDone = (s, key, status, body) =>
  col.idem.updateOne({ _id: key },
    { $set: { state: 'done', statusCode: status, response: body, finishedAt: new Date() } }, { session: s });

async function finishPlain(key, status, body) {
  await markDone(undefined, key, status, body);
  return { status, body };
}

export async function handlePayment(ev) {
  if (!ev || typeof ev.eventId !== 'string' || typeof ev.holdId !== 'string')
    return { status: 400, body: { error: 'bad_request' } };
  const key = 'pay:' + ev.eventId;
  const claim = await claimKey(key);
  if (claim.replay) return claim.value;
  const t0 = process.hrtime.bigint();
  let metricItem = 'unknown';
  let metricOutcome = 'error';
  try {
    const res = await processPayment(ev, key);
    metricItem = res.itemId || 'unknown';
    metricOutcome = res.outcome || 'unknown';
    return { status: res.status, body: res.body };
  } catch (e) {
    await col.idem.deleteOne({ _id: key, state: 'processing' }).catch(() => {}); // let the PSP retry cleanly
    throw e;
  } finally {
    const dur = Number(process.hrtime.bigint() - t0) / 1e9;
    bookingAttemptsTotal.inc({ item_id: metricItem, outcome: metricOutcome });
    holdConfirmDurationSeconds.observe({ item_id: metricItem, outcome: metricOutcome }, dur);
  }
}

async function processPayment(ev, key) {
  const hold = await col.holds.findOne({ _id: ev.holdId });
  if (!hold) {
    const r = await finishPlain(key, 404, { result: 'unknown_hold' });
    return { ...r, itemId: 'unknown', outcome: 'unknown_hold' };
  }
  if (ev.status !== 'succeeded') {
    const r = await finishPlain(key, 200, { result: 'ignored', reason: 'payment_' + ev.status });
    return { ...r, itemId: hold.itemId, outcome: 'ignored' };
  }

  const item = await col.items.findOne({ _id: hold.itemId });
  if (ev.amountPaise !== item.pricePaise * hold.seatIds.length)
    return refund(key, ev, hold, 'AMOUNT_MISMATCH', 200, { markRefunded: false });
  if (hold.status === 'CONFIRMED' || hold.status === 'REFUNDED')
    return refund(key, ev, hold, 'DUPLICATE_PAYMENT', 200, { markRefunded: false });

  // Seat side. 1 = hold was alive and consumed, 2 = hold was gone but seats re-claimed (late payment OK), 0 = lost.
  const rc = await R.confirmSeats(hold.itemId, hold._id, hold.userId, hold.seatIds);
  if (rc === 0) return refund(key, ev, hold, 'LATE_PAYMENT_SEATS_UNAVAILABLE', 200, { markRefunded: true });

  try {
    return await commitConfirm(key, ev, hold);
  } catch (e) {
    if (isDup(e, 'bookings')) {
      // Postgres-style last line of defense fired: another booking owns a seat. Clean 409 + refund.
      return refund(key, ev, hold, 'SEAT_CONFLICT', 409, { markRefunded: true, restoreUnbooked: true });
    }
    if (e instanceof ConcurrentConfirm) return refund(key, ev, hold, 'DUPLICATE_PAYMENT', 200, { markRefunded: false });
    await R.restoreSeats(hold.itemId, hold.seatIds).catch(() => {}); // undo seat consumption, safe side = undersell
    throw e;
  }
}

async function commitConfirm(key, ev, hold) {
  const body = { result: 'confirmed', holdId: hold._id, seats: hold.seatIds };
  await inTx(async (s) => {
    await col.bookings.insertMany(hold.seatIds.map((seatId) => ({
      holdId: hold._id, itemId: hold.itemId, seatId, userId: hold.userId, createdAt: new Date(),
    })), { session: s });
    const u = await col.holds.updateOne(
      { _id: hold._id, status: { $in: ['HELD', 'EXPIRED', 'CANCELLED'] } },
      { $set: { status: 'CONFIRMED', updatedAt: new Date() } }, { session: s });
    if (u.matchedCount !== 1) throw new ConcurrentConfirm();
    await col.outbox.insertOne(outboxDoc(hold._id, 'BookingConfirmed', {
      holdId: hold._id, itemId: hold.itemId, userId: hold.userId, seats: hold.seatIds,
      eventId: ev.eventId, amountPaise: ev.amountPaise,
    }), { session: s });
    await markDone(s, key, 200, body);
  });
  bookingsConfirmedTotal.inc({ item_id: hold.itemId });
  await R.removeAdmitted(hold.itemId, hold.userId).catch(() => {});
  return { status: 200, body, itemId: hold.itemId, outcome: 'confirmed' };
}

async function refund(key, ev, hold, reason, status, { markRefunded, restoreUnbooked } = {}) {
  const body = { result: status === 409 ? 'conflict' : 'refunded', reason, holdId: hold._id };
  await inTx(async (s) => {
    if (markRefunded)
      await col.holds.updateOne({ _id: hold._id, status: { $ne: 'CONFIRMED' } },
        { $set: { status: 'REFUNDED', updatedAt: new Date() } }, { session: s });
    await col.outbox.insertOne(outboxDoc(hold._id, 'PaymentRefunded', {
      holdId: hold._id, itemId: hold.itemId, userId: hold.userId,
      eventId: ev.eventId, amountPaise: ev.amountPaise, reason,
    }), { session: s });
    await markDone(s, key, status, body);
  });
  bookingsRefundedTotal.inc({ item_id: hold.itemId, reason });
  if (restoreUnbooked) {
    // seats of this hold NOT owned by someone else go back to the free pool
    const owned = new Set((await col.bookings.find({ itemId: hold.itemId, seatId: { $in: hold.seatIds } })
      .project({ seatId: 1 }).toArray()).map((b) => b.seatId));
    await R.restoreSeats(hold.itemId, hold.seatIds.filter((s) => !owned.has(s))).catch(() => {});
  }
  return { status, body, itemId: hold.itemId, outcome: status === 409 ? 'conflict' : 'refunded' };
}
