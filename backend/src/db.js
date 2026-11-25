import { MongoClient } from 'mongodb';
import { cfg } from './config.js';

export let client;
export const col = {};

export async function connectDb() {
  client = new MongoClient(cfg.mongoUrl, { maxPoolSize: 100 });
  await client.connect();
  const db = client.db(cfg.dbName);
  Object.assign(col, {
    items: db.collection('inventory_items'),
    holds: db.collection('holds'),
    bookings: db.collection('bookings'),
    outbox: db.collection('outbox'),
    idem: db.collection('idempotency_keys'),
  });
  // LAST LINE OF DEFENSE: a seat can be booked at most once, no matter what Redis believes.
  await col.bookings.createIndex({ itemId: 1, seatId: 1 }, { unique: true });
  await col.holds.createIndex({ status: 1, expiresAt: 1 });
  await col.holds.createIndex({ itemId: 1, status: 1 });
  await col.outbox.createIndex({ publishedAt: 1, _id: 1 });
  await col.idem.createIndex({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });
}

// Run DB-only work in a transaction (safe to retry: no external side effects inside).
export async function inTx(fn) {
  const s = client.startSession();
  try {
    await s.withTransaction(() => fn(s));
  } finally {
    await s.endSession();
  }
}
