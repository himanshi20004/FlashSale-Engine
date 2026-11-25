// Validates Prometheus metric registration, label hygiene, and (when backend is running) live /metrics + /admin/metrics/summary parity with /admin/verify/:id.
import assert from 'node:assert/strict';
import {
  register,
  recordHttpSample,
  recordAdmissions,
  holdAttemptsTotal,
  bookingsConfirmedTotal,
  inventoryOversellViolations,
} from '../src/metrics.js';

// 1. Offline registry & label-cardinality check
recordHttpSample('POST', '/api/holds', 201, 0.012, false);
recordHttpSample('POST', '/api/holds', 410, 0.004, false);
recordHttpSample('GET', '/api/queue/events', 200, 120.5, true); // SSE excluded from latency histogram
recordAdmissions('test-item', [1.25, 2.5]);
holdAttemptsTotal.inc({ item_id: 'test-item', outcome: 'created' });
bookingsConfirmedTotal.inc({ item_id: 'test-item' });
inventoryOversellViolations.set({ item_id: 'test-item' }, 0);

const text = await register.metrics();
const requiredMetrics = [
  'flashsale_http_requests_total',
  'flashsale_http_request_duration_seconds',
  'flashsale_http_errors_total',
  'flashsale_sse_active_connections',
  'flashsale_hold_attempts_total',
  'flashsale_booking_attempts_total',
  'flashsale_bookings_confirmed_total',
  'flashsale_bookings_refunded_total',
  'flashsale_holds_expired_total',
  'flashsale_holds_cancelled_total',
  'flashsale_active_holds',
  'flashsale_hold_create_duration_seconds',
  'flashsale_hold_confirm_duration_seconds',
  'flashsale_inventory_total',
  'flashsale_inventory_available',
  'flashsale_inventory_held',
  'flashsale_inventory_booked',
  'flashsale_inventory_sold_out_rejections_total',
  'flashsale_inventory_consistency_violations',
  'flashsale_inventory_oversell_violations',
  'flashsale_redis_up',
  'flashsale_redis_connected_clients',
  'flashsale_redis_memory_used_bytes',
  'flashsale_redis_active_holds',
  'flashsale_redis_queue_length',
  'flashsale_redis_operation_duration_seconds',
  'flashsale_redis_errors_total',
  'flashsale_backend_admission_open',
  'flashsale_queue_waiting_users',
  'flashsale_queue_admitted_active',
  'flashsale_queue_admitted_total',
  'flashsale_queue_rejected_total',
  'flashsale_queue_wait_duration_seconds',
];

for (const m of requiredMetrics) {
  assert.ok(text.includes(m), `Missing Prometheus metric: ${m}`);
}
assert.ok(!text.includes('user_id='), 'High-cardinality user_id label must not exist');
assert.ok(!text.includes('hold_id='), 'High-cardinality hold_id label must not exist');
assert.ok(!text.includes('booking_id='), 'High-cardinality booking_id label must not exist');
assert.ok(
  !text.includes('flashsale_http_request_duration_seconds_bucket{le="+Inf",method="GET",route="/api/queue/events"'),
  'SSE stream should be excluded from HTTP duration histogram',
);
console.log('ok  offline Prometheus metrics & cardinality assertions');

// 2. Live server checks (runs when backend is reachable or REQUIRE_LIVE=true)
const BASE = process.env.BASE || 'http://127.0.0.1:8080';
const ADMIN = process.env.ADMIN_TOKEN || 'admin-secret';
const ITEM = process.env.ITEM || 'concert-1';

let liveUp = false;
try {
  const hz = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(1500) });
  liveUp = hz.ok;
} catch {
  liveUp = false;
}

if (!liveUp) {
  if (process.env.REQUIRE_LIVE === 'true') {
    throw new Error(`Backend not reachable at ${BASE}`);
  }
  console.log(`skip live endpoint checks (backend not running at ${BASE})`);
  process.exit(0);
}

const metricsRes = await fetch(`${BASE}/metrics`);
assert.equal(metricsRes.status, 200);
const metricsBody = await metricsRes.text();
assert.ok(metricsBody.includes('flashsale_http_requests_total'));
assert.ok(metricsBody.includes('flashsale_backend_admission_open'));
console.log('ok  live GET /metrics');

const unauth = await fetch(`${BASE}/admin/metrics/summary`);
assert.equal(unauth.status, 401, 'Admin metrics summary must reject missing token');
console.log('ok  GET /admin/metrics/summary enforces admin auth (401)');

const summaryRes = await fetch(`${BASE}/admin/metrics/summary?itemId=${encodeURIComponent(ITEM)}`, {
  headers: { 'x-admin-token': ADMIN },
});
assert.equal(summaryRes.status, 200);
const summary = await summaryRes.json();
assert.ok(summary.http && summary.bookings && summary.queue && summary.health && Array.isArray(summary.history));

const verifyRes = await fetch(`${BASE}/admin/verify/${encodeURIComponent(ITEM)}`, {
  headers: { 'x-admin-token': ADMIN },
});
if (verifyRes.status === 200 && summary.inventory) {
  const verify = await verifyRes.json();
  assert.equal(summary.inventory.totalSeats, verify.totalSeats);
  assert.equal(summary.inventory.booked, verify.booked);
  assert.equal(summary.inventory.noOversell, verify.noOversell);
  console.log(`ok  inventory summary matches /admin/verify/${ITEM}`);
}

console.log('ALL METRICS TESTS PASSED');
process.exit(0);
