import React, { useEffect, useRef, useState } from 'react';
import MonitoringDashboard from './MonitoringDashboard.jsx';

const ITEM = 'concert-1';
const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/+$/, '');
const api = async (path, opts = {}, token) => {
  const r = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

export default function App() {
  const [view, setView] = useState(() => (window.location.hash === '#/monitor' ? 'monitor' : 'store'));
  const [userId] = useState(() => 'user-' + Math.random().toString(36).slice(2, 8));
  const [item, setItem] = useState(null);
  const [phase, setPhase] = useState('idle'); // idle | waiting | admitted | held | done | soldout
  const [queue, setQueue] = useState(null);
  const [token, setToken] = useState(null);
  const [hold, setHold] = useState(null);
  const [left, setLeft] = useState(0);
  const [msg, setMsg] = useState('');
  const [qty, setQty] = useState(1);
  const es = useRef(null);

  useEffect(() => {
    const t = setInterval(async () => {
      const r = await api(`/api/items/${ITEM}`);
      if (r.status === 200) setItem(r.body);
    }, 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!hold) return;
    const t = setInterval(() => setLeft(Math.max(0, Math.round((new Date(hold.expiresAt) - Date.now()) / 1000))), 250);
    return () => clearInterval(t);
  }, [hold]);

  const join = async () => {
    setMsg('');
    const r = await api('/api/queue/join', { method: 'POST', body: JSON.stringify({ itemId: ITEM, userId }) });
    if (r.status === 410) return setPhase('soldout');
    if (r.status !== 200) return setMsg(`Could not join (${r.status}): ${r.body.error}. Retry shortly.`);
    setPhase('waiting');
    es.current?.close();
    const src = new EventSource(`${API_BASE}/api/queue/events?itemId=${ITEM}&userId=${userId}`);
    es.current = src;
    src.onmessage = (e) => {
      const s = JSON.parse(e.data);
      setQueue(s);
      if (s.state === 'admitted') { setToken(s.token); setPhase('admitted'); src.close(); }
      if (s.state === 'sold_out') { setPhase('soldout'); src.close(); }
      if (s.state === 'not_in_queue') { src.close(); join(); } // queue state lost in a Redis failover: re-join
    };
  };

  const takeHold = async () => {
    const r = await api('/api/holds', { method: 'POST', body: JSON.stringify({ qty }) }, token);
    if (r.status === 201) { setHold(r.body); setPhase('held'); setMsg(''); }
    else if (r.status === 410) setPhase('soldout');
    else setMsg(`Hold failed (${r.status}): ${r.body.error}`);
  };

  const pay = async () => {
    const r = await api('/dev/pay', { method: 'POST', body: JSON.stringify({ holdId: hold.holdId }) });
    const res = r.body.results?.[0];
    setMsg(`Payment result: ${res?.body?.result} ${res?.body?.reason ? '(' + res.body.reason + ')' : ''}`);
    setPhase('done');
  };

  const cancel = async () => {
    await api(`/api/holds/${hold.holdId}`, { method: 'DELETE' }, token);
    setHold(null); setPhase('admitted'); setMsg('Hold released.');
  };

  const switchView = (next) => {
    setView(next);
    window.location.hash = next === 'monitor' ? '#/monitor' : '';
  };

  const navBar = {
    display: 'flex',
    justifyContent: 'center',
    gap: 8,
    padding: '10px 16px',
    background: view === 'monitor' ? '#0f172a' : '#f8fafc',
    borderBottom: view === 'monitor' ? '1px solid #1e293b' : '1px solid #e2e8f0',
    fontFamily: 'system-ui',
  };
  const navBtn = (active) => ({
    padding: '7px 14px',
    borderRadius: 8,
    border: '1px solid transparent',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
    background: active ? '#2563eb' : 'transparent',
    color: active ? '#ffffff' : view === 'monitor' ? '#94a3b8' : '#475569',
  });

  if (view === 'monitor') {
    return (
      <>
        <nav style={navBar}>
          <button style={navBtn(false)} onClick={() => switchView('store')}>Buyer Storefront</button>
          <button style={navBtn(true)} onClick={() => switchView('monitor')}>Monitoring &amp; Analytics</button>
        </nav>
        <MonitoringDashboard />
      </>
    );
  }

  const card = { maxWidth: 520, margin: '40px auto', fontFamily: 'system-ui', padding: 24, border: '1px solid #ddd', borderRadius: 12 };
  const btn = { padding: '10px 18px', marginRight: 8, borderRadius: 8, border: 0, background: '#2f6df6', color: '#fff', cursor: 'pointer' };

  return (
    <>
      <nav style={navBar}>
        <button style={navBtn(true)} onClick={() => switchView('store')}>Buyer Storefront</button>
        <button style={navBtn(false)} onClick={() => switchView('monitor')}>Monitoring &amp; Analytics</button>
      </nav>
      <div style={card}>
        <h2>Concert drop — flash sale</h2>
        {item && <p><b>{item.available}</b> of {item.totalSeats} seats left · {item.activeHolds} in checkout · {item.queueLength} in queue
          {!item.admissionOpen && <span style={{ color: '#c00' }}> · system recovering…</span>}</p>}
        <p style={{ color: '#666' }}>You are <code>{userId}</code></p>

        {phase === 'idle' && <button style={btn} onClick={join}>Join waiting room</button>}
        {phase === 'waiting' && queue && (
          <p>{queue.state === 'paused' ? 'Reconnecting…' : <>Position <b>{queue.position}</b> · about {queue.etaSeconds}s</>}</p>)}
        {phase === 'admitted' && (<>
          <p>You're in! Choose tickets (max 4):</p>
          <input type="number" min="1" max="4" value={qty} onChange={(e) => setQty(+e.target.value)} style={{ width: 60, marginRight: 8 }} />
          <button style={btn} onClick={takeHold}>Hold seats</button></>)}
        {phase === 'held' && hold && (<>
          <p>Seats <b>{hold.seats.join(', ')}</b> held for <b>{left}s</b></p>
          <button style={btn} onClick={pay}>Pay (mock PSP)</button>
          <button style={{ ...btn, background: '#888' }} onClick={cancel}>Cancel</button></>)}
        {phase === 'done' && <p>Done. Hold id {hold?.holdId}</p>}
        {phase === 'soldout' && <p><b>Sold out.</b></p>}
        {msg && <p style={{ color: '#a60' }}>{msg}</p>}
      </div>
    </>
  );
}
