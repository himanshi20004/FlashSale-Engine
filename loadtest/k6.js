// Burst test. Run: docker compose --profile load run --rm k6
import http from 'k6/http';
import { sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';

const BASE = __ENV.BASE || 'http://backend:8080';
const ADMIN = __ENV.ADMIN_TOKEN || 'admin-secret';
const ITEM = __ENV.ITEM || 'drop-1';
const SEATS = parseInt(__ENV.SEATS || '1000');
const VUS = parseInt(__ENV.VUS || '300');
const HOLD = { headers: { 'Content-Type': 'application/json' } };

const holdLatency = new Trend('hold_latency', true);
const confirmed = new Counter('flow_confirmed');
const refunded = new Counter('flow_refunded');
const conflicts = new Counter('flow_conflict_409');
const soldOutC = new Counter('flow_sold_out');
const dupHold = new Counter('flow_already_holding');

export const options = {
  scenarios: {
    burst: {
      executor: 'ramping-vus', startVUs: 0, gracefulRampDown: '30s',
      stages: [{ duration: '5s', target: VUS }, { duration: __ENV.HOLD_FOR || '60s', target: VUS }, { duration: '5s', target: 0 }],
    },
  },
};

export function setup() {
  const r = http.post(`${BASE}/admin/items?reset=true`,
    JSON.stringify({ id: ITEM, totalSeats: SEATS, pricePaise: 50000 }),
    { headers: { 'Content-Type': 'application/json', 'x-admin-token': ADMIN } });
  if (r.status !== 200) throw new Error('seed failed ' + r.status + ' ' + r.body);
}

export default function () {
  const user = `u-${__VU}-${__ITER}-${Math.random().toString(36).slice(2, 8)}`;
  let token = null;
  const deadline = Date.now() + 120000;

  while (!token && Date.now() < deadline) {
    const j = http.post(`${BASE}/api/queue/join`, JSON.stringify({ itemId: ITEM, userId: user }), HOLD);
    if (j.status === 410) { soldOutC.add(1); return; }
    if (j.status === 429 || j.status === 503) { sleep(1); continue; }
    for (let i = 0; i < 240 && !token; i++) {
      const s = http.get(`${BASE}/api/queue/status?itemId=${ITEM}&userId=${user}`);
      if (s.status === 200) {
        const b = s.json();
        if (b.state === 'admitted') token = b.token;
        else if (b.state === 'sold_out') { soldOutC.add(1); return; }
        else if (b.state === 'not_in_queue') break; // queue lost (failover) -> rejoin
      } else if (s.status === 503) sleep(1);
      if (!token) sleep(0.5 + Math.random() * 0.5);
    }
  }
  if (!token) return;

  const auth = { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } };
  let hold = null;
  for (let a = 0; a < 8 && !hold; a++) {
    const h = http.post(`${BASE}/api/holds`, JSON.stringify({ qty: 1 }), auth);
    holdLatency.add(h.timings.duration);
    if (h.status === 201) hold = h.json();
    else if (h.status === 410) { soldOutC.add(1); return; }
    else if (h.status === 409) { dupHold.add(1); return; }
    else sleep(1); // 503 during failover recovery
  }
  if (!hold) return;

  sleep(Math.random() * 2); // "user enters card details"
  // 3 identical webhook deliveries = payment retry storm; must still produce exactly one effect
  const p = http.post(`${BASE}/dev/pay`, JSON.stringify({ holdId: hold.holdId, repeat: 3 }), HOLD);
  if (p.status === 200) {
    const r = p.json().results;
    const first = r[0].body.result;
    if (first === 'confirmed') confirmed.add(1);
    else if (first === 'refunded') refunded.add(1);
    else if (first === 'conflict') conflicts.add(1);
  }
}

export function teardown() {
  sleep(parseInt(__ENV.SETTLE_SEC || '35')); // let un-paid holds expire so the invariant is checkable
  const v = http.get(`${BASE}/admin/verify/${ITEM}`, { headers: { 'x-admin-token': ADMIN } });
  console.log('VERIFY ' + v.body);
}
