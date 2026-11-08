// Compares two polls of the agent list and says what moved.
const WATCHED = ['status', 'title'];

export function diffAgents(prev, next) {
  const events = [];
  const seen = new Set();
  for (const agent of next) {
    seen.add(agent.id);
    const old = prev.get(agent.id);
    if (!old) events.push({ type: 'added', agent });
    else if (WATCHED.some(k => old[k] !== agent[k])) events.push({ type: 'changed', agent, from: old.status });
  }
  for (const id of prev.keys()) if (!seen.has(id)) events.push({ type: 'removed', id });
  return events;
}
