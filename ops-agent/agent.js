// OPTIONAL post-incident "ops copilot" built with LangGraph. It is NOT on the booking path.
// Graph: collect -> (invariant violated? escalate : summarize) -> END
// LLM = local Ollama (free). If Ollama is unreachable, a deterministic report is used instead.
// Usage: ITEM=drop-1 API=http://localhost:8080 node agent.js
import { StateGraph, Annotation, START, END } from '@langchain/langgraph';
import { ChatOllama } from '@langchain/ollama';

const API = process.env.API || 'http://localhost:8080';
const ADMIN = process.env.ADMIN_TOKEN || 'admin-secret';
const ITEM = process.env.ITEM || 'drop-1';

const State = Annotation.Root({
  itemId: Annotation(),
  verify: Annotation(),
  severity: Annotation(),
  report: Annotation(),
});

async function collect(state) {
  const r = await fetch(`${API}/admin/verify/${state.itemId}`, { headers: { 'x-admin-token': ADMIN } });
  const verify = await r.json();
  const severity = !verify.noOversell ? 'CRITICAL' : !verify.conserved ? 'WARN' : 'OK';
  return { verify, severity };
}

async function llm(prompt, fallback) {
  try {
    const m = new ChatOllama({ model: process.env.OLLAMA_MODEL || 'llama3.2', baseUrl: process.env.OLLAMA_URL || 'http://localhost:11434' });
    const out = await Promise.race([m.invoke(prompt), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 30000))]);
    return String(out.content);
  } catch { return fallback; }
}

async function summarize(state) {
  const v = state.verify;
  const fallback = `Item ${v.itemId}: ${v.booked}/${v.totalSeats} booked, ${v.redisFree} free, ${v.heldSeats} held. ` +
    `No oversell. Holds by status: ${JSON.stringify(v.holdsByStatus)}. Refunds issued: ${v.holdsByStatus?.REFUNDED ?? 0}.` +
    (state.severity === 'WARN' ? ' Seats not yet conserved: holds may still be expiring; re-check after the hold TTL.' : '');
  const report = await llm(`You are an SRE assistant. Summarize this flash-sale health check in 4 sentences for a postmortem. Data: ${JSON.stringify(v)}`, fallback);
  return { report };
}

async function escalate(state) {
  const v = state.verify;
  return { report: `CRITICAL: invariant violated for ${v.itemId}. booked=${v.booked} total=${v.totalSeats} duplicateSeats=${v.duplicateSeats} outOfRange=${v.outOfRange}. Freeze sales and run reconciliation.` };
}

const graph = new StateGraph(State)
  .addNode('collect', collect)
  .addNode('summarize', summarize)
  .addNode('escalate', escalate)
  .addEdge(START, 'collect')
  .addConditionalEdges('collect', (s) => (s.severity === 'CRITICAL' ? 'escalate' : 'summarize'))
  .addEdge('summarize', END)
  .addEdge('escalate', END)
  .compile();

const out = await graph.invoke({ itemId: ITEM });
console.log(`[${out.severity}]\n${out.report}`);
