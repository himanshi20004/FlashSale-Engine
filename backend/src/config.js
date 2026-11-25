const e = process.env;
const num = (k, d) => (e[k] !== undefined && e[k] !== '' ? Number(e[k]) : d);
const port = num('PORT', 8080);

export const cfg = {
  port,
  mongoUrl: e.MONGO_URL || 'mongodb://localhost:27017/?replicaSet=rs0',
  dbName: e.DB_NAME || 'flashsale',
  redisUrl: e.REDIS_URL || 'redis://localhost:6379',      // hot path: counters, holds, queue (may be lost)
  busUrl: e.BUS_URL || 'redis://localhost:6380',          // durable (AOF) event bus: Redis Streams
  tokenSecret: e.TOKEN_SECRET || 'dev-token-secret',
  webhookSecret: e.WEBHOOK_SECRET || 'dev-webhook-secret',
  adminToken: e.ADMIN_TOKEN || 'admin-secret',
  selfUrl: e.SELF_URL || `http://127.0.0.1:${port}`,
  holdTtlMs: num('HOLD_TTL_SEC', 300) * 1000,
  admitRate: num('ADMIT_RATE', 200),        // users admitted per second per item (token-bucket refill)
  admitBurst: num('ADMIT_BURST', 400),      // token-bucket capacity
  maxActive: num('MAX_ACTIVE', 2000),       // max concurrently admitted users per item
  admitTtlMs: num('ADMIT_TTL_SEC', 180) * 1000,
  joinRps: num('JOIN_RPS', 5000),           // per-instance shield on /queue/join
  mockPsp: (e.MOCK_PSP ?? 'true') === 'true',
  runConsumer: (e.RUN_CONSUMER ?? 'true') === 'true',
};
