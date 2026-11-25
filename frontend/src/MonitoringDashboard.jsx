import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './MonitoringDashboard.css';

const TOKEN_KEY = 'flashsale_admin_token';
const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/+$/, '');

function LineChart({ data, series, unit = '', height = 170 }) {
  const width = 520;
  const padL = 36;
  const padR = 12;
  const padT = 12;
  const padB = 22;

  const maxVal = useMemo(() => {
    let m = 1;
    for (const row of data) {
      for (const s of series) {
        const v = Number(row[s.key] ?? 0);
        if (v > m) m = v;
      }
    }
    return m;
  }, [data, series]);

  if (!data || data.length < 2) {
    return (
      <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b', fontSize: '0.84rem' }}>
        Collecting live samples... (charts populate after 2 polling intervals)
      </div>
    );
  }

  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const toX = (idx) => padL + (idx / (data.length - 1)) * innerW;
  const toY = (val) => padT + innerH - (Math.max(0, Number(val || 0)) / maxVal) * innerH;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="mon-svg" role="img" aria-label="Time series chart">
      {[0, 0.5, 1].map((frac) => {
        const y = padT + innerH * (1 - frac);
        const label = Math.round(maxVal * frac);
        return (
          <g key={frac}>
            <line x1={padL} y1={y} x2={width - padR} y2={y} stroke="#1e293b" strokeWidth="1" />
            <text x={padL - 6} y={y + 3} textAnchor="end" fill="#64748b" fontSize="10">
              {label}{unit}
            </text>
          </g>
        );
      })}
      {series.map((s) => {
        const pts = data.map((d, i) => `${toX(i).toFixed(1)},${toY(d[s.key]).toFixed(1)}`).join(' ');
        return (
          <polyline
            key={s.key}
            fill="none"
            stroke={s.color}
            strokeWidth="2.2"
            strokeLinejoin="round"
            strokeLinecap="round"
            points={pts}
          />
        );
      })}
    </svg>
  );
}

export default function MonitoringDashboard() {
  const [adminToken, setAdminToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) || '');
  const [tokenInput, setTokenInput] = useState('');
  const [selectedItem, setSelectedItem] = useState('');
  const [pollMs, setPollMs] = useState(2000);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [authError, setAuthError] = useState('');
  const hasLoadedRef = useRef(false);

  const fetchSummary = useCallback(async (tok, itemId) => {
    if (!tok) return;
    if (!hasLoadedRef.current) setLoading(true);
    try {
      const qs = itemId ? `?itemId=${encodeURIComponent(itemId)}` : '';
      const res = await fetch(`${API_BASE}/admin/metrics/summary${qs}`, {
        headers: { 'x-admin-token': tok },
      });
      if (res.status === 401) {
        sessionStorage.removeItem(TOKEN_KEY);
        hasLoadedRef.current = false;
        setAdminToken('');
        setSummary(null);
        setAuthError('Invalid admin token. Please enter a valid ADMIN_TOKEN.');
        return;
      }
      if (!res.ok) {
        throw new Error(`Metrics request failed (${res.status})`);
      }
      const data = await res.json();
      hasLoadedRef.current = true;
      setSummary(data);
      setError('');
      setAuthError('');
      if (!itemId && data.selectedItemId) {
        setSelectedItem(data.selectedItemId);
      }
    } catch (e) {
      setError(e.message || 'Unable to reach backend metrics API.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!adminToken) return;
    fetchSummary(adminToken, selectedItem);
    if (!pollMs) return;
    const t = setInterval(() => fetchSummary(adminToken, selectedItem), pollMs);
    return () => clearInterval(t);
  }, [adminToken, selectedItem, pollMs, fetchSummary]);

  const handleLogin = (e) => {
    e.preventDefault();
    const trimmed = tokenInput.trim();
    if (!trimmed) return;
    sessionStorage.setItem(TOKEN_KEY, trimmed);
    setAdminToken(trimmed);
    setTokenInput('');
    setAuthError('');
  };

  const handleSignOut = () => {
    sessionStorage.removeItem(TOKEN_KEY);
    hasLoadedRef.current = false;
    setAdminToken('');
    setSummary(null);
    setError('');
  };

  if (!adminToken) {
    return (
      <div className="mon-root">
        <div className="mon-auth-card">
          <h2>Operations &amp; Analytics Monitor</h2>
          <p>
            Protected business, queue, inventory, and k6 load-testing telemetry. Enter the backend
            <code> ADMIN_TOKEN</code> to authenticate via <code>x-admin-token</code>.
          </p>
          {authError && <div className="mon-banner mon-banner-error">{authError}</div>}
          <form onSubmit={handleLogin} className="mon-auth-form">
            <input
              type="password"
              className="mon-input"
              placeholder="Enter admin token..."
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              autoFocus
            />
            <button type="submit" className="mon-btn">Unlock</button>
          </form>
        </div>
      </div>
    );
  }

  const inv = summary?.inventory;
  const totalSeats = inv?.totalSeats || 0;
  const pct = (n) => (totalSeats > 0 ? ((n / totalSeats) * 100).toFixed(1) : '0.0');
  const bookings = summary?.bookings || {};
  const http = summary?.http || {};
  const queue = summary?.queue || {};
  const health = summary?.health || {};
  const k6 = summary?.k6 || { available: false, active: false };
  const history = summary?.history || [];

  const maxOutcome = Math.max(
    1,
    bookings.holdsCreated || 0,
    bookings.confirmed || 0,
    bookings.expired || 0,
    bookings.cancelled || 0,
    bookings.refunded || 0,
    bookings.soldOutRejections || 0,
  );

  return (
    <div className="mon-root">
      <div className="mon-container">
        <header className="mon-header">
          <div className="mon-title-wrap">
            <h1>Flash Sale Real-Time Observability</h1>
            <p className="mon-subtitle">
              Live Prometheus instrumentation, Redis/Mongo consistency audit, and k6 telemetry
            </p>
          </div>
          <div className="mon-controls">
            {summary?.items?.length > 0 && (
              <select
                className="mon-select"
                value={selectedItem || summary.selectedItemId}
                onChange={(e) => setSelectedItem(e.target.value)}
                aria-label="Select item"
              >
                {summary.items.map((it) => (
                  <option key={it.itemId} value={it.itemId}>{it.itemId} ({it.totalSeats} seats)</option>
                ))}
              </select>
            )}
            <select
              className="mon-select"
              value={pollMs}
              onChange={(e) => setPollMs(Number(e.target.value))}
              aria-label="Polling interval"
            >
              <option value={2000}>Poll: 2s</option>
              <option value={5000}>Poll: 5s</option>
              <option value={10000}>Poll: 10s</option>
              <option value={0}>Paused</option>
            </select>
            <button type="button" className="mon-btn mon-btn-ghost" onClick={() => fetchSummary(adminToken, selectedItem)}>
              Refresh
            </button>
            <button type="button" className="mon-btn mon-btn-ghost" onClick={handleSignOut}>
              Sign out
            </button>
            {summary?.timestamp && (
              <span className="mon-timestamp">
                Updated: {new Date(summary.timestamp).toLocaleTimeString()}
              </span>
            )}
          </div>
        </header>

        {error && (
          <div className="mon-banner mon-banner-error">
            <span>{error}</span>
            <button type="button" className="mon-btn mon-btn-ghost" onClick={() => fetchSummary(adminToken, selectedItem)}>
              Retry
            </button>
          </div>
        )}

        {loading && !summary ? (
          <div className="mon-kpi-grid">
            <div className="mon-skeleton" />
            <div className="mon-skeleton" />
            <div className="mon-skeleton" />
            <div className="mon-skeleton" />
          </div>
        ) : (
          <>
            {/* System Health Strip */}
            <section className="mon-health-strip">
              <div className="mon-health-pill">
                <div>
                  <div className="mon-health-label">Backend Admission Gate</div>
                  <div className="mon-health-meta">RSS {health.processMemoryMb ?? 0} MB · Up {health.uptimeSeconds ?? 0}s</div>
                </div>
                <span className={`mon-badge ${health.backendAdmissionOpen ? 'mon-badge-ok' : 'mon-badge-bad'}`}>
                  {health.backendAdmissionOpen ? 'OPEN' : 'PAUSED'}
                </span>
              </div>

              <div className="mon-health-pill">
                <div>
                  <div className="mon-health-label">Hot Redis (Inventory/Queue)</div>
                  <div className="mon-health-meta">
                    {health.redisHot?.clients ?? 0} clients · {((health.redisHot?.memoryBytes ?? 0) / (1024 * 1024)).toFixed(2)} MB
                  </div>
                </div>
                <span className={`mon-badge ${health.redisHot?.up ? 'mon-badge-ok' : 'mon-badge-bad'}`}>
                  {health.redisHot?.up ? 'UP' : 'DOWN'}
                </span>
              </div>

              <div className="mon-health-pill">
                <div>
                  <div className="mon-health-label">Durable Redis Stream Bus</div>
                  <div className="mon-health-meta">
                    {health.redisBus?.clients ?? 0} clients · {((health.redisBus?.memoryBytes ?? 0) / (1024 * 1024)).toFixed(2)} MB
                  </div>
                </div>
                <span className={`mon-badge ${health.redisBus?.up ? 'mon-badge-ok' : 'mon-badge-bad'}`}>
                  {health.redisBus?.up ? 'UP' : 'DOWN'}
                </span>
              </div>

              <div className="mon-health-pill">
                <div>
                  <div className="mon-health-label">Oversell &amp; Conservation Audit</div>
                  <div className="mon-health-meta">
                    {inv ? `${inv.booked} + ${inv.heldSeats} + ${inv.available} vs ${inv.totalSeats}` : 'No item seeded'}
                  </div>
                </div>
                <span className={`mon-badge ${!inv ? 'mon-badge-warn' : inv.noOversell ? (inv.conserved ? 'mon-badge-ok' : 'mon-badge-warn') : 'mon-badge-bad'}`}>
                  {!inv ? 'NO ITEM' : !inv.noOversell ? 'OVERSELL' : inv.conserved ? 'CONSISTENT' : 'IN-FLIGHT'}
                </span>
              </div>
            </section>

            {!inv && (
              <div className="mon-banner mon-banner-empty">
                <span>No inventory items found in MongoDB yet. Run <code>make seed</code> (or POST <code>/admin/items</code>) to populate live inventory metrics.</span>
              </div>
            )}

            {/* Summary KPI Cards */}
            <section className="mon-kpi-grid">
              <div className="mon-card">
                <div className="mon-kpi-title">Available Inventory</div>
                <div className="mon-kpi-value">{inv ? inv.available : '—'}</div>
                <div className="mon-kpi-sub">of {totalSeats} total · {inv ? inv.heldSeats : 0} held · {inv ? inv.booked : 0} booked</div>
              </div>
              <div className="mon-card">
                <div className="mon-kpi-title">Confirmed Bookings</div>
                <div className="mon-kpi-value">{bookings.confirmed ?? 0}</div>
                <div className="mon-kpi-sub">Success rate {bookings.successRatePct ?? 0}% · {bookings.refunded ?? 0} refunded</div>
              </div>
              <div className="mon-card">
                <div className="mon-kpi-title">Waiting Room Queue</div>
                <div className="mon-kpi-value">{queue.waitingUsers ?? 0}</div>
                <div className="mon-kpi-sub">{queue.admittedActive ?? 0} admitted active · {queue.observedAdmitRatePerSec ?? 0}/s · avg {queue.avgWaitSeconds ?? 0}s wait</div>
              </div>
              <div className="mon-card">
                <div className="mon-kpi-title">HTTP Throughput &amp; Latency</div>
                <div className="mon-kpi-value">{http.rps ?? 0} req/s</div>
                <div className="mon-kpi-sub">p50 {http.latencyMs?.p50 ?? 0}ms · p95 {http.latencyMs?.p95 ?? 0}ms · p99 {http.latencyMs?.p99 ?? 0}ms</div>
              </div>
              <div className="mon-card">
                <div className="mon-kpi-title">Expected Business Rejections</div>
                <div className="mon-kpi-value">{http.businessRejections4xx ?? 0}</div>
                <div className="mon-kpi-sub">409 conflict / 410 sold-out / 429 limit (healthy backpressure)</div>
              </div>
              <div className="mon-card">
                <div className="mon-kpi-title">Server Errors (5xx)</div>
                <div className="mon-kpi-value" style={{ color: (http.serverErrors5xx ?? 0) > 0 ? '#f87171' : '#34d399' }}>
                  {http.serverErrors5xx ?? 0}
                </div>
                <div className="mon-kpi-sub">Error rate {http.serverErrorRatePct ?? 0}% · {http.totalRequests ?? 0} total reqs</div>
              </div>
            </section>

            {/* Inventory Utilization + Booking Outcomes */}
            <section className="mon-grid-2">
              <div className="mon-card">
                <div className="mon-panel-head">
                  <h3 className="mon-panel-title">Inventory Utilization</h3>
                  <span className="mon-panel-note">{inv ? `${inv.itemId} · ${inv.activeHolds} active hold(s)` : 'Idle'}</span>
                </div>
                <div className="mon-stack-bar">
                  <div className="mon-seg-booked" style={{ width: `${pct(inv?.booked || 0)}%` }} title={`Booked: ${inv?.booked || 0}`} />
                  <div className="mon-seg-held" style={{ width: `${pct(inv?.heldSeats || 0)}%` }} title={`Held: ${inv?.heldSeats || 0}`} />
                  <div className="mon-seg-free" style={{ width: `${pct(inv?.available || 0)}%` }} title={`Available: ${inv?.available || 0}`} />
                </div>
                <div className="mon-legend">
                  <span><span className="mon-dot" style={{ background: '#10b981' }} />Booked: {inv?.booked ?? 0} ({pct(inv?.booked || 0)}%)</span>
                  <span><span className="mon-dot" style={{ background: '#f59e0b' }} />Held: {inv?.heldSeats ?? 0} ({pct(inv?.heldSeats || 0)}%)</span>
                  <span><span className="mon-dot" style={{ background: '#38bdf8' }} />Available: {inv?.available ?? 0} ({pct(inv?.available || 0)}%)</span>
                </div>
              </div>

              <div className="mon-card">
                <div className="mon-panel-head">
                  <h3 className="mon-panel-title">Booking Lifecycle &amp; Rejection Outcomes</h3>
                  <span className="mon-panel-note">Cumulative since backend boot</span>
                </div>
                <div className="mon-bars">
                  {[
                    { label: 'Holds Created', val: bookings.holdsCreated ?? 0, color: '#38bdf8' },
                    { label: 'Confirmed', val: bookings.confirmed ?? 0, color: '#10b981' },
                    { label: 'Expired Holds', val: bookings.expired ?? 0, color: '#f59e0b' },
                    { label: 'Cancelled Holds', val: bookings.cancelled ?? 0, color: '#94a3b8' },
                    { label: 'Refunded', val: bookings.refunded ?? 0, color: '#a855f7' },
                    { label: 'Sold-Out Rejects', val: bookings.soldOutRejections ?? 0, color: '#f43f5e' },
                  ].map((row) => (
                    <div key={row.label} className="mon-bar-row">
                      <span style={{ color: '#cbd5e1' }}>{row.label}</span>
                      <div className="mon-bar-track">
                        <div className="mon-bar-fill" style={{ width: `${(row.val / maxOutcome) * 100}%`, background: row.color }} />
                      </div>
                      <span className="mon-bar-num">{row.val}</span>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            {/* Time-Series Charts */}
            <section className="mon-grid-2">
              <div className="mon-card">
                <div className="mon-panel-head">
                  <h3 className="mon-panel-title">API Latency (p50 / p95 / p99 ms)</h3>
                  <span className="mon-panel-note">Rolling 60s window</span>
                </div>
                <LineChart
                  data={history}
                  unit="ms"
                  series={[
                    { key: 'p50Ms', color: '#34d399' },
                    { key: 'p95Ms', color: '#fbbf24' },
                    { key: 'p99Ms', color: '#f87171' },
                  ]}
                />
                <div className="mon-legend" style={{ marginTop: 8 }}>
                  <span><span className="mon-dot" style={{ background: '#34d399' }} />p50</span>
                  <span><span className="mon-dot" style={{ background: '#fbbf24' }} />p95</span>
                  <span><span className="mon-dot" style={{ background: '#f87171' }} />p99</span>
                </div>
              </div>

              <div className="mon-card">
                <div className="mon-panel-head">
                  <h3 className="mon-panel-title">Waiting Room Queue &amp; Admission Rate</h3>
                  <span className="mon-panel-note">Config max: {queue.configuredAdmitRate ?? 0}/s</span>
                </div>
                <LineChart
                  data={history}
                  series={[
                    { key: 'queueLength', color: '#38bdf8' },
                    { key: 'admittedRate', color: '#a855f7' },
                  ]}
                />
                <div className="mon-legend" style={{ marginTop: 8 }}>
                  <span><span className="mon-dot" style={{ background: '#38bdf8' }} />Users in Queue</span>
                  <span><span className="mon-dot" style={{ background: '#a855f7' }} />Admitted / sec</span>
                </div>
              </div>
            </section>

            {/* k6 Load Testing Integration */}
            <section className="mon-card">
              <div className="mon-panel-head">
                <h3 className="mon-panel-title">k6 Load Testing Telemetry (via Prometheus)</h3>
                <span className={`mon-badge ${k6.active ? 'mon-badge-ok' : 'mon-badge-warn'}`}>
                  {!k6.available ? 'PROMETHEUS NOT LINKED' : k6.active ? 'LOAD TEST RUNNING' : 'IDLE'}
                </span>
              </div>
              {!k6.available || (k6.totalRequests === undefined) ? (
                <p style={{ margin: 0, fontSize: '0.84rem', color: '#94a3b8' }}>
                  {!k6.available
                    ? 'Set PROMETHEUS_URL (enabled automatically in docker-compose.yml) to display live k6 metrics here.'
                    : 'No k6 metrics recorded in Prometheus yet. Run `make load` to stream live k6 Virtual Users, throughput, hold latency, and error classification.'}
                </p>
              ) : (
                <div className="mon-k6-grid">
                  <div className="mon-k6-cell"><div className="mon-k6-label">Virtual Users</div><div className="mon-k6-val">{k6.vus}</div></div>
                  <div className="mon-k6-cell"><div className="mon-k6-label">Requests / sec</div><div className="mon-k6-val">{k6.rps}</div></div>
                  <div className="mon-k6-cell"><div className="mon-k6-label">Total k6 Requests</div><div className="mon-k6-val">{k6.totalRequests}</div></div>
                  <div className="mon-k6-cell"><div className="mon-k6-label">Confirmed Bookings</div><div className="mon-k6-val">{k6.confirmedBookings}</div></div>
                  <div className="mon-k6-cell"><div className="mon-k6-label">Sold-Out (410)</div><div className="mon-k6-val">{k6.soldOutResponses}</div></div>
                  <div className="mon-k6-cell"><div className="mon-k6-label">Conflicts (409)</div><div className="mon-k6-val">{k6.conflictResponses}</div></div>
                  <div className="mon-k6-cell"><div className="mon-k6-label">Hold Latency p95</div><div className="mon-k6-val">{k6.holdLatencyP95Ms !== null ? `${k6.holdLatencyP95Ms} ms` : '—'}</div></div>
                  <div className="mon-k6-cell"><div className="mon-k6-label">5xx Error Rate /s</div><div className="mon-k6-val" style={{ color: k6.serverErrorRatePerSec > 0 ? '#f87171' : '#34d399' }}>{k6.serverErrorRatePerSec}</div></div>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
