// How the home screen sorts agents. Pure, so it can be tested in node.
//
// marks: { [agentId]: { seen?: turnKey, done?: turnKey } }, saved per user on the
// server. A mark only counts for the turn it was made on, so an agent that ends
// a new turn shows up as new again.

export const RECENT_MS = 24 * 3600 * 1000;

const when = a => (a.endedAt ? Date.parse(a.endedAt) : 0);
const byRecent = (x, y) => when(y) - when(x);

export const turnKey = a => a.endedAt || a.lastPrompt || '';
export const isSeen = (a, marks) => a.status === 'idle' || marks[a.id]?.seen === turnKey(a);
export const isDone = (a, marks) => marks[a.id]?.done === turnKey(a);

export function groupAgents(agents, marks, now = Date.now()) {
  const asking = [], finished = [], working = [], earlier = [];
  for (const a of agents) {
    if (a.status === 'blocked') asking.push(a);
    else if (a.status === 'working') working.push(a);
    else if ((a.status === 'done' || a.status === 'idle') && now - when(a) < RECENT_MS && !isDone(a, marks)) finished.push(a);
    else earlier.push(a);
  }
  asking.sort(byRecent);
  working.sort(byRecent);
  earlier.sort(byRecent);
  finished.sort((x, y) => (isSeen(x, marks) - isSeen(y, marks)) || byRecent(x, y));
  return { asking, finished, working, earlier };
}
