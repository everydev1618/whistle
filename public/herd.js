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

const NEEDS = a => (a.status === 'blocked' ? 0 : a.status === 'working' ? 1 : 2);

// One tile per space: how many agents, and how many need you.
export function spaceTiles(spaces, agents, marks) {
  return spaces.map(space => {
    const mine = agents.filter(a => a.spaceId === space.id);
    const finished = mine.filter(a => (a.status === 'done' || a.status === 'idle'));
    const latest = mine.reduce((m, a) => (when(a) > when(m ?? {}) ? a : m), null);
    return {
      space,
      total: mine.length,
      asking: mine.filter(a => a.status === 'blocked').length,
      working: mine.filter(a => a.status === 'working').length,
      fresh: finished.filter(a => !isSeen(a, marks) && !isDone(a, marks)).length, // not opened yet, however old
      endedAt: latest?.endedAt ?? null,
    };
  });
}

// A space's agents: asking, working, new, the rest, then ones marked done; newest first.
export function spaceAgents(agents, spaceId, marks) {
  const rank = a => (NEEDS(a) < 2 ? NEEDS(a) : isDone(a, marks) ? 4 : isSeen(a, marks) ? 3 : 2);
  return agents.filter(a => a.spaceId === spaceId).sort((x, y) => rank(x) - rank(y) || byRecent(x, y));
}

// Home layout: spaces that need you or are running go on top (asking, then
// working, then new; newest first), the rest below by when they were last used.
// Spaces the user hid sit apart, whatever they're doing.
// New finishes only count as active for a day; older unread news stays quiet.
const used = t => (t.endedAt ? Date.parse(t.endedAt) : -Infinity);

export function arrangeSpaces(tiles, hiddenIds = [], now = Date.now()) {
  const urgency = t => (t.asking ? 0 : t.working ? 1 : t.fresh && now - used(t) < RECENT_MS ? 2 : 3);
  const hide = new Set(hiddenIds);
  const shown = tiles.filter(t => !hide.has(t.space.id));
  const newest = (x, y) => used(y) - used(x) || x.space.number - y.space.number;
  return {
    active: shown.filter(t => urgency(t) < 3).sort((x, y) => urgency(x) - urgency(y) || newest(x, y)),
    quiet: shown.filter(t => urgency(t) === 3).sort((x, y) => (y.total > 0) - (x.total > 0) || newest(x, y)),
    hidden: tiles.filter(t => hide.has(t.space.id)),
  };
}
