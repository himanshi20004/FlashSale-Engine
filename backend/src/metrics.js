import client from 'prom-client';
import { cfg } from './config.js';
import { col } from './db.js';
import { gate } from './gate.js';

export const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: 'flashsale_node_' });

/* ---------------- HTTP Metrics ---------------- */
export const httpRequestsTotal = new client.Counter({
  name: 'flashsale_http_requests_total',
  help: 'Total HTTP requests processed by route and status code',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

export const httpRequestDurationSeconds = new client.Histogram({
  name: 'flashsale_http_request_duration_seconds',
  help: 'HTTP request latency in seconds (excludes long-lived SSE streams)',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

export const httpErrorsTotal = new client.Counter({
  name: 'flashsale_http_errors_total',
  help: 'HTTP 4xx/5xx responses separated by business rejections vs server errors',
  labelNames: ['method', 'route', 'status_class'],
  registers: [register],
});

export const sseActiveConnections = new client.Gauge({
  name: 'flashsale_sse_active_connections',
  help: 'Currently open SSE waiting-room streams',
  registers: [register],
});

/* ---------------- Booking Metrics ---------------- */
export const holdAttemptsTotal = new client.Counter({
  name: 'flashsale_hold_attempts_total',
  help: 'Total seat hold creation attempts by outcome',
  labelNames: ['item_id', 'outcome'],
  registers: [register],
});

export const bookingAttemptsTotal = new client.Counter({
  name: 'flashsale_booking_attempts_total',
  help: 'Total booking confirmation/payment webhook attempts by outcome',
  labelNames: ['item_id', 'outcome'],
  registers: [register],
});

export const bookingsConfirmedTotal = new client.Counter({
  name: 'flashsale_bookings_confirmed_total',
  help: 'Total confirmed bookings',
  labelNames: ['item_id'],
  registers: [register],
});

export const bookingsRefundedTotal = new client.Counter({
  name: 'flashsale_bookings_refunded_total',
  help: 'Total refunded or rejected duplicate/late payments by reason',
  labelNames: ['item_id', 'reason'],
  registers: [register],
});

export const holdsExpiredTotal = new client.Counter({
  name: 'flashsale_holds_expired_total',
  help: 'Total seat holds transitioned to EXPIRED',
  labelNames: ['item_id'],
  registers: [register],
});

export const holdsCancelledTotal = new client.Counter({
  name: 'flashsale_holds_cancelled_total',
  help: 'Total seat holds explicitly cancelled by users',
  labelNames: ['item_id'],
  registers: [register],
});

export const activeHoldsGauge = new client.Gauge({
  name: 'flashsale_active_holds',
  help: 'Current active HELD holds per item (sampled from MongoDB)',
  labelNames: ['item_id'],
  registers: [register],
});

export const holdCreateDurationSeconds = new client.Histogram({
  name: 'flashsale_hold_create_duration_seconds',
  help: 'End-to-end seat hold creation latency in seconds',
  labelNames: ['item_id', 'outcome'],
  buckets: [0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [register],
});

export const holdConfirmDurationSeconds = new client.Histogram({
  name: 'flashsale_hold_confirm_duration_seconds',
  help: 'End-to-end payment confirmation/webhook latency in seconds',
  labelNames: ['item_id', 'outcome'],
  buckets: [0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [register],
});

/* ---------------- Inventory Metrics ---------------- */
export const inventoryTotal = new client.Gauge({
  name: 'flashsale_inventory_total',
  help: 'Total configured seats per item',
  labelNames: ['item_id'],
  registers: [register],
});

export const inventoryAvailable = new client.Gauge({
  name: 'flashsale_inventory_available',
  help: 'Available seats in Redis free set per item',
  labelNames: ['item_id'],
  registers: [register],
});

export const inventoryHeld = new client.Gauge({
  name: 'flashsale_inventory_held',
  help: 'Seats currently held in unexpired HELD holds per item',
  labelNames: ['item_id'],
  registers: [register],
});

export const inventoryBooked = new client.Gauge({
  name: 'flashsale_inventory_booked',
  help: 'Confirmed booked seats in MongoDB per item',
  labelNames: ['item_id'],
  registers: [register],
});

export const inventorySoldOutRejectionsTotal = new client.Counter({
  name: 'flashsale_inventory_sold_out_rejections_total',
  help: 'Requests rejected due to sold-out inventory',
  labelNames: ['item_id', 'stage'],
  registers: [register],
});

export const inventoryConsistencyViolations = new client.Gauge({
  name: 'flashsale_inventory_consistency_violations',
  help: '1 if booked + available + held != total or oversell detected during sample, else 0',
  labelNames: ['item_id'],
  registers: [register],
});

export const inventoryOversellViolations = new client.Gauge({
  name: 'flashsale_inventory_oversell_violations',
  help: '1 if booked > total, duplicate seats, or out-of-range seats detected (must stay 0)',
  labelNames: ['item_id'],
  registers: [register],
});

/* ---------------- Redis & Backend Health Metrics ---------------- */
export const redisUp = new client.Gauge({
  name: 'flashsale_redis_up',
  help: 'Redis connection health (1 = ready, 0 = down)',
  labelNames: ['role'],
  registers: [register],
});

export const redisConnectedClients = new client.Gauge({
  name: 'flashsale_redis_connected_clients',
  help: 'Connected clients reported by Redis INFO clients',
  labelNames: ['role'],
  registers: [register],
});

export const redisMemoryUsedBytes = new client.Gauge({
  name: 'flashsale_redis_memory_used_bytes',
  help: 'Used memory in bytes reported by Redis INFO memory',
  labelNames: ['role'],
  registers: [register],
});

export const redisActiveHolds = new client.Gauge({
  name: 'flashsale_redis_active_holds',
  help: 'Active holds indexed in Redis holdsexp ZSET per item',
  labelNames: ['item_id'],
  registers: [register],
});

export const redisQueueLength = new client.Gauge({
  name: 'flashsale_redis_queue_length',
  help: 'Waiting room queue length in Redis per item',
  labelNames: ['item_id'],
  registers: [register],
});

export const redisOperationDurationSeconds = new client.Histogram({
  name: 'flashsale_redis_operation_duration_seconds',
  help: 'Redis and Lua script operation latency in seconds',
  labelNames: ['operation'],
  buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register],
});

export const redisErrorsTotal = new client.Counter({
  name: 'flashsale_redis_errors_total',
  help: 'Total Redis operation errors',
  labelNames: ['role', 'operation'],
  registers: [register],
});

export const backendAdmissionOpen = new client.Gauge({
  name: 'flashsale_backend_admission_open',
  help: 'Backend admission gate state (1 = open, 0 = paused/recovering)',
  registers: [register],
});

/* ---------------- Waiting Room Metrics ---------------- */
export const queueWaitingUsers = new client.Gauge({
  name: 'flashsale_queue_waiting_users',
  help: 'Users currently waiting in the queue per item',
  labelNames: ['item_id'],
  registers: [register],
});

export const queueAdmittedActive = new client.Gauge({
  name: 'flashsale_queue_admitted_active',
  help: 'Currently active admitted users in Redis admitted ZSET per item',
  labelNames: ['item_id'],
  registers: [register],
});

export const queueAdmittedTotal = new client.Counter({
  name: 'flashsale_queue_admitted_total',
  help: 'Cumulative users admitted from the waiting room',
  labelNames: ['item_id'],
  registers: [register],
});

export const queueRejectedTotal = new client.Counter({
  name: 'flashsale_queue_rejected_total',
  help: 'Waiting room join rejections by reason',
  labelNames: ['item_id', 'reason'],
  registers: [register],
});

export const queueAdmissionRateConfig = new client.Gauge({
  name: 'flashsale_queue_admission_rate_per_sec',
  help: 'Configured token-bucket admission rate per second per item',
  registers: [register],
});
queueAdmissionRateConfig.set(cfg.admitRate);

export const queueWaitDurationSeconds = new client.Histogram({
  name: 'flashsale_queue_wait_duration_seconds',
  help: 'Observed waiting room wait time in seconds from join to admission',
  labelNames: ['item_id'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300],
  registers: [register],
});

/* ---------------- Rolling Window & Snapshot State for /admin/metrics/summary ---------------- */
const MAX_SAMPLES = 4000;
const WINDOW_MS = 60_000;
const MAX_HISTORY = 60;

const recentHttp = []; // { ts, ms, status, cls }
const recentAdmits = []; // timestamps of admitted users
const waitStatsByItem = new Map(); // itemId -> { sumSec, count }
const itemSnapshots = new Map(); // itemId -> latest sampled inventory/queue snapshot
const redisHealth = {
  hot: { up: false, clients: 0, memoryBytes: 0, lastCheckedAt: null },
  bus: { up: false, clients: 0, memoryBytes: 0, lastCheckedAt: null },
};
const history = []; // up to 60 samples (every 5s)
let lastSampleAt = null;
let samplerStarted = false;

const classifyStatus = (status) => {
  if (status >= 500) return '5xx';
  if (status === 409 || status === 410 || status === 429) return '4xx_business';
  if (status >= 400) return '4xx_client';
  return 'ok';
};

export function recordHttpSample(method, route, status, durationSec, isSse = false) {
  const codeStr = String(status);
  httpRequestsTotal.inc({ method, route, status_code: codeStr });
  if (!isSse) {
    httpRequestDurationSeconds.observe({ method, route, status_code: codeStr }, durationSec);
  }
  const cls = classifyStatus(status);
  if (cls !== 'ok') {
    httpErrorsTotal.inc({ method, route, status_class: cls });
  }
  if (!isSse) {
    const now = Date.now();
    recentHttp.push({ ts: now, ms: durationSec * 1000, status, cls });
    if (recentHttp.length > MAX_SAMPLES) recentHttp.shift();
  }
}

export function recordAdmissions(itemId, waitSecList) {
  const count = waitSecList.length;
  if (!count) return;
  queueAdmittedTotal.inc({ item_id: itemId }, count);
  const now = Date.now();
  let st = waitStatsByItem.get(itemId);
  if (!st) {
    st = { sumSec: 0, count: 0 };
    waitStatsByItem.set(itemId, st);
  }
  for (const w of waitSecList) {
    const safe = Math.max(0, w);
    queueWaitDurationSeconds.observe({ item_id: itemId }, safe);
    st.sumSec += safe;
    st.count += 1;
    recentAdmits.push({ ts: now, itemId });
  }
  while (recentAdmits.length > MAX_SAMPLES) recentAdmits.shift();
}

function pruneWindow(arr, now) {
  const cutoff = now - WINDOW_MS;
  while (arr.length && arr[0].ts < cutoff) arr.shift();
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
}

function parseInfoNumber(info, field) {
  const m = new RegExp(`^${field}:(\\d+)`, 'm').exec(info);
  return m ? Number(m[1]) : 0;
}

async function sampleRedisRole(clientConn, role) {
  const t0 = process.hrtime.bigint();
  try {
    const [clientsInfo, memInfo] = await Promise.all([
      clientConn.info('clients'),
      clientConn.info('memory'),
    ]);
    const dur = Number(process.hrtime.bigint() - t0) / 1e9;
    redisOperationDurationSeconds.observe({ operation: `info_${role}` }, dur);
    const clients = parseInfoNumber(clientsInfo, 'connected_clients');
    const memoryBytes = parseInfoNumber(memInfo, 'used_memory');
    redisUp.set({ role }, 1);
    redisConnectedClients.set({ role }, clients);
    redisMemoryUsedBytes.set({ role }, memoryBytes);
    redisHealth[role] = { up: true, clients, memoryBytes, lastCheckedAt: new Date().toISOString() };
  } catch {
    redisUp.set({ role }, 0);
    redisErrorsTotal.inc({ role, operation: 'info' });
    redisHealth[role] = {
      up: false,
      clients: 0,
      memoryBytes: 0,
      lastCheckedAt: new Date().toISOString(),
    };
  }
}

export async function refreshMetricsSnapshot(deps) {
  const { redis, bus, K, freeCount, activeHoldCount } = deps;
  backendAdmissionOpen.set(gate.open ? 1 : 0);

  await Promise.all([sampleRedisRole(redis, 'hot'), sampleRedisRole(bus, 'bus')]);

  if (!col.items) return;
  const items = await col.items.find({}).toArray().catch(() => []);
  const nowDate = new Date();

  for (const item of items) {
    const id = item._id;
    try {
      const [booked, dupes, outOfRange, heldAgg, byStatus, free, rHolds, qLen, admActive] = await Promise.all([
        col.bookings.countDocuments({ itemId: id }),
        col.bookings.aggregate([
          { $match: { itemId: id } },
          { $group: { _id: '$seatId', n: { $sum: 1 } } },
          { $match: { n: { $gt: 1 } } },
        ]).toArray(),
        col.bookings.countDocuments({ itemId: id, $or: [{ seatId: { $lt: 1 } }, { seatId: { $gt: item.totalSeats } }] }),
        col.holds.aggregate([
          { $match: { itemId: id, status: 'HELD', expiresAt: { $gt: nowDate } } },
          { $group: { _id: null, seats: { $sum: { $size: '$seatIds' } }, count: { $sum: 1 } } },
        ]).toArray(),
        col.holds.aggregate([
          { $match: { itemId: id } },
          { $group: { _id: '$status', n: { $sum: 1 } } },
        ]).toArray(),
        freeCount(id).catch(() => 0),
        activeHoldCount(id).catch(() => 0),
        redis.zcard(K.queue(id)).catch(() => 0),
        redis.zcard(K.admitted(id)).catch(() => 0),
      ]);

      const heldSeats = heldAgg[0]?.seats ?? 0;
      const heldCount = heldAgg[0]?.count ?? 0;
      const statusMap = Object.fromEntries(byStatus.map((s) => [s._id, s.n]));
      const oversell = booked > item.totalSeats || dupes.length > 0 || outOfRange > 0;
      const conserved = booked + free + heldSeats === item.totalSeats;

      inventoryTotal.set({ item_id: id }, item.totalSeats);
      inventoryAvailable.set({ item_id: id }, free);
      inventoryHeld.set({ item_id: id }, heldSeats);
      inventoryBooked.set({ item_id: id }, booked);
      activeHoldsGauge.set({ item_id: id }, heldCount);
      redisActiveHolds.set({ item_id: id }, rHolds);
      redisQueueLength.set({ item_id: id }, qLen);
      queueWaitingUsers.set({ item_id: id }, qLen);
      queueAdmittedActive.set({ item_id: id }, admActive);
      inventoryOversellViolations.set({ item_id: id }, oversell ? 1 : 0);
      inventoryConsistencyViolations.set({ item_id: id }, !oversell && conserved ? 0 : 1);

      itemSnapshots.set(id, {
        itemId: id,
        name: item.name || id,
        pricePaise: item.pricePaise,
        totalSeats: item.totalSeats,
        available: free,
        heldSeats,
        activeHolds: heldCount,
        redisActiveHolds: rHolds,
        booked,
        queueLength: qLen,
        admittedActive: admActive,
        holdsByStatus: statusMap,
        duplicateSeats: dupes.length,
        outOfRange,
        noOversell: !oversell,
        conserved,
        ok: !oversell && conserved,
      });
    } catch {
      // Transient Redis/Mongo error during failover: keep previous snapshot & let health flags reflect outage
    }
  }

  // Record rolling history point for React charts
  const now = Date.now();
  pruneWindow(recentHttp, now);
  pruneWindow(recentAdmits, now);
  const windowSec = WINDOW_MS / 1000;
  const durations = recentHttp.map((s) => s.ms).sort((a, b) => a - b);
  const business4xx = recentHttp.filter((s) => s.cls === '4xx_business').length;
  const client4xx = recentHttp.filter((s) => s.cls === '4xx_client').length;
  const server5xx = recentHttp.filter((s) => s.cls === '5xx').length;

  let totalAvailable = 0;
  let totalHeld = 0;
  let totalBooked = 0;
  let totalQueue = 0;
  for (const snap of itemSnapshots.values()) {
    totalAvailable += snap.available;
    totalHeld += snap.heldSeats;
    totalBooked += snap.booked;
    totalQueue += snap.queueLength;
  }

  history.push({
    ts: new Date(now).toISOString(),
    rps: Number((recentHttp.length / windowSec).toFixed(2)),
    p50Ms: Number(quantile(durations, 0.5).toFixed(2)),
    p95Ms: Number(quantile(durations, 0.95).toFixed(2)),
    p99Ms: Number(quantile(durations, 0.99).toFixed(2)),
    errors5xx: server5xx,
    rejectionsBusiness: business4xx,
    errors4xxClient: client4xx,
    queueLength: totalQueue,
    admittedRate: Number((recentAdmits.length / windowSec).toFixed(2)),
    available: totalAvailable,
    held: totalHeld,
    booked: totalBooked,
  });
  if (history.length > MAX_HISTORY) history.shift();
  lastSampleAt = new Date(now).toISOString();
}

export function startMetricsSampler(deps) {
  if (samplerStarted) return;
  samplerStarted = true;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await refreshMetricsSnapshot(deps); } finally { busy = false; }
  };
  tick();
  setInterval(tick, 5000).unref();
}

async function queryPromScalar(promUrl, expr) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 800);
  try {
    const r = await fetch(`${promUrl}/api/v1/query?query=${encodeURIComponent(expr)}`, { signal: ctl.signal });
    if (!r.ok) return null;
    const body = await r.json();
    const val = body?.data?.result?.[0]?.value?.[1];
    return val !== undefined ? Number(val) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchK6Summary() {
  const promUrl = process.env.PROMETHEUS_URL;
  if (!promUrl) return { available: false, active: false };
  const [vus, rps, totalReqs, confirmed, soldOut, conflicts, holdP95Ms, serverErrRate] = await Promise.all([
    queryPromScalar(promUrl, 'max(k6_vus)'),
    queryPromScalar(promUrl, 'sum(rate(k6_http_reqs_total[30s]))'),
    queryPromScalar(promUrl, 'sum(k6_http_reqs_total)'),
    queryPromScalar(promUrl, 'sum(k6_flow_confirmed_total)'),
    queryPromScalar(promUrl, 'sum(k6_flow_sold_out_total)'),
    queryPromScalar(promUrl, 'sum(k6_flow_conflict_409_total)'),
    queryPromScalar(promUrl, 'max(k6_hold_latency_p95) * 1000'),
    queryPromScalar(promUrl, 'sum(rate(k6_flow_server_errors_total[30s]))'),
  ]);
  const hasAny = [vus, totalReqs, confirmed, soldOut, conflicts].some((v) => v !== null);
  if (!hasAny) return { available: true, active: false };
  return {
    available: true,
    active: (vus ?? 0) > 0,
    vus: vus ?? 0,
    rps: rps !== null ? Number(rps.toFixed(2)) : 0,
    totalRequests: totalReqs ?? 0,
    confirmedBookings: confirmed ?? 0,
    soldOutResponses: soldOut ?? 0,
    conflictResponses: conflicts ?? 0,
    holdLatencyP95Ms: holdP95Ms !== null ? Number(holdP95Ms.toFixed(2)) : null,
    serverErrorRatePerSec: serverErrRate !== null ? Number(serverErrRate.toFixed(3)) : 0,
  };
}

function sumCounterValues(counterObj, filterFn = () => true) {
  let sum = 0;
  for (const v of counterObj.values) {
    if (filterFn(v.labels)) sum += v.value;
  }
  return sum;
}

export async function getAdminMetricsSummary(requestedItemId, deps) {
  await refreshMetricsSnapshot(deps);
  const now = Date.now();
  pruneWindow(recentHttp, now);
  pruneWindow(recentAdmits, now);
  const windowSec = WINDOW_MS / 1000;
  const durations = recentHttp.map((s) => s.ms).sort((a, b) => a - b);

  const items = Array.from(itemSnapshots.values());
  const selected = requestedItemId
    ? itemSnapshots.get(requestedItemId) || null
    : items[0] || null;
  const itemId = selected?.itemId || requestedItemId || 'concert-1';

  const [
    holdMetric,
    bookingMetric,
    confirmedMetric,
    refundedMetric,
    expiredMetric,
    cancelledMetric,
    soldOutMetric,
    queueRejMetric,
    httpMetric,
    httpErrMetric,
    sseMetric,
    memMetric,
  ] = await Promise.all([
    holdAttemptsTotal.get(),
    bookingAttemptsTotal.get(),
    bookingsConfirmedTotal.get(),
    bookingsRefundedTotal.get(),
    holdsExpiredTotal.get(),
    holdsCancelledTotal.get(),
    inventorySoldOutRejectionsTotal.get(),
    queueRejectedTotal.get(),
    httpRequestsTotal.get(),
    httpErrorsTotal.get(),
    sseActiveConnections.get(),
    register.getSingleMetric('flashsale_node_process_resident_memory_bytes')?.get(),
  ]);

  const byItem = (labels) => !selected || labels.item_id === itemId;
  const waitStats = waitStatsByItem.get(itemId) || { sumSec: 0, count: 0 };
  const k6 = await fetchK6Summary();

  const totalRequests = sumCounterValues(httpMetric);
  const businessRejections = sumCounterValues(httpErrMetric, (l) => l.status_class === '4xx_business');
  const clientErrors = sumCounterValues(httpErrMetric, (l) => l.status_class === '4xx_client');
  const serverErrors = sumCounterValues(httpErrMetric, (l) => l.status_class === '5xx');

  const confirmedCount = sumCounterValues(confirmedMetric, byItem);
  const refundedCount = sumCounterValues(refundedMetric, byItem);
  const expiredCount = sumCounterValues(expiredMetric, byItem);
  const cancelledCount = sumCounterValues(cancelledMetric, byItem);
  const holdAttempts = sumCounterValues(holdMetric, byItem);
  const holdCreated = sumCounterValues(holdMetric, (l) => byItem(l) && l.outcome === 'created');
  const holdFailed = holdAttempts - holdCreated;

  return {
    timestamp: new Date(now).toISOString(),
    lastSampleAt,
    selectedItemId: itemId,
    items,
    inventory: selected,
    http: {
      totalRequests,
      rps: Number((recentHttp.length / windowSec).toFixed(2)),
      latencyMs: {
        p50: Number(quantile(durations, 0.5).toFixed(2)),
        p95: Number(quantile(durations, 0.95).toFixed(2)),
        p99: Number(quantile(durations, 0.99).toFixed(2)),
      },
      businessRejections4xx: businessRejections,
      clientErrors4xx: clientErrors,
      serverErrors5xx: serverErrors,
      serverErrorRatePct: totalRequests ? Number(((serverErrors / totalRequests) * 100).toFixed(3)) : 0,
      sseActiveConnections: sseMetric.values[0]?.value ?? 0,
    },
    bookings: {
      holdAttempts,
      holdsCreated: holdCreated,
      holdsFailed: holdFailed,
      bookingAttempts: sumCounterValues(bookingMetric, byItem),
      confirmed: confirmedCount,
      refunded: refundedCount,
      expired: expiredCount,
      cancelled: cancelledCount,
      soldOutRejections: sumCounterValues(soldOutMetric, byItem),
      successRatePct: holdAttempts
        ? Number(((confirmedCount / holdAttempts) * 100).toFixed(2))
        : 0,
    },
    queue: {
      waitingUsers: selected?.queueLength ?? 0,
      admittedActive: selected?.admittedActive ?? 0,
      admittedTotal: waitStats.count,
      rejectedTotal: sumCounterValues(queueRejMetric, byItem),
      configuredAdmitRate: cfg.admitRate,
      observedAdmitRatePerSec: Number((recentAdmits.filter((a) => !selected || a.itemId === itemId).length / windowSec).toFixed(2)),
      avgWaitSeconds: waitStats.count ? Number((waitStats.sumSec / waitStats.count).toFixed(2)) : 0,
    },
    health: {
      backendAdmissionOpen: gate.open,
      processMemoryMb: memMetric?.values?.[0]?.value
        ? Number((memMetric.values[0].value / (1024 * 1024)).toFixed(1))
        : Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(1)),
      uptimeSeconds: Math.round(process.uptime()),
      redisHot: redisHealth.hot,
      redisBus: redisHealth.bus,
    },
    k6,
    history,
  };
}
