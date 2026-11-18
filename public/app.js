import { mdBlocks } from './md.js';
import { groupAgents, isSeen, isDone, turnKey, spaceTiles, spaceAgents, arrangeSpaces } from './herd.js';
import { withImages } from './attach.js';
import { recordingType, releaseOutcome, spokenDraft, routeTitle, autoGo, AUTO_GO_MS, CANCEL_PX } from './voice.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const base = p => (p || '').split('/').pop();

const state = {
  agents: new Map(),
  sessions: [],
  filter: localGet('whistle.filter') || 'all',
  openId: null,
  spaceId: null,       // the space page that's open, or the one the open agent lives in
  spaces: [],
  detail: null,
  showAllTurns: false,
  sent: new Set(),     // agents we just sent to, shown dimmed until herdr reports work
  stopArmed: null,
  marks: {},          // { agentId: { seen, done } } per turn, saved on the server
  hidden: localList('whistle.hidden'), // space ids hidden from home, saved on the server
  showHidden: false,
  details: new Map(),  // agentId -> last detail, so reopening an agent paints at once
  pending: null,       // { id, text, at } a message sent but not yet in the transcript
};

function localList(k) { try { return JSON.parse(localGet(k)) || []; } catch { return []; } }

function setHidden(list) {
  state.hidden = list;
  localSet('whistle.hidden', JSON.stringify(list));
  fetch('/api/prefs', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hidden: list }) }).catch(() => {});
  render();
}

// The saved filter, unless its session is gone, then All (the choice stays saved).
function activeFilter() {
  if (state.filter === 'all' || !state.sessions.length) return state.filter;
  return state.sessions.some(s => s.name === state.filter) ? state.filter : 'all';
}

// The filter lives on the server per Tailscale user, so a Safari tab, the home-screen
// app and other devices agree. Local storage is only for a fast first paint.
function setFilter(f, { save = true } = {}) {
  state.filter = f;
  localSet('whistle.filter', f);
  if (save) fetch('/api/prefs', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filter: f }) }).catch(() => {});
  render();
}

function loadMarks() {
  api('/api/marks').then(m => { state.marks = m; render(); }).catch(() => {});
}

// Optimistic: update locally, then tell the server.
function mark(id, kind) {
  const a = state.agents.get(id);
  if (!a) return;
  const turn = turnKey(a);
  const entry = { ...state.marks[id] };
  if (kind === 'undone') delete entry.done; else entry[kind] = turn;
  state.marks = { ...state.marks, [id]: entry };
  fetch('/api/marks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, kind, turn }) }).catch(() => {});
}

function markDone(id) {
  const a = state.agents.get(id);
  mark(id, 'seen');
  mark(id, 'done');
  if (state.openId === id) location.hash = spaceHash(a);
  else render();
  toast(`Done with ${a?.title || a?.project || 'agent'}`, { label: 'Undo', run: () => { mark(id, 'undone'); render(); } });
}

function loadPrefs() {
  api('/api/prefs').then(p => {
    if (Array.isArray(p.hidden)) { state.hidden = p.hidden; localSet('whistle.hidden', JSON.stringify(p.hidden)); }
    if (p.filter && p.filter !== state.filter) setFilter(p.filter, { save: false }); else render();
  }).catch(() => {});
}

function localGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }

// ---------- data ----------
async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error?.message || `HTTP ${r.status}`), { code: data.error?.code, status: r.status });
  return data;
}

let es = null;
function connect() {
  es?.close();
  es = new EventSource('/api/events');
  es.addEventListener('snapshot', e => {
    const d = JSON.parse(e.data);
    if (!state.version) state.version = d.version;
    else if (d.version && d.version !== state.version) updateReady();
    state.agents = new Map(d.agents.map(a => [a.id, a]));
    state.sessions = d.sessions;
    state.spaces = d.spaces || [];
    render();
  });
  es.addEventListener('change', e => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'spaces') { state.spaces = ev.spaces; return render(); }
    if (ev.type === 'removed') state.agents.delete(ev.id);
    else {
      state.agents.set(ev.agent.id, ev.agent);
      if (ev.agent.status === 'working' || ev.agent.status === 'blocked') state.sent.delete(ev.agent.id);
    }
    render();
    if (state.openId && (ev.agent?.id === state.openId || ev.id === state.openId)) refreshDetailSoon();
  });
  es.onerror = () => { $('#count').textContent = 'Reconnecting…'; };
}

// ---------- updates ----------
// A deploy restarts the server; the stream reconnects with a new app version.
// Reload right away unless you're mid-reply, then offer it instead.
let updatePending = false;
function updateReady() {
  updatePending = true;
  if (safeToReload()) location.reload();
  else toast('Whistle was updated', { label: 'Reload', run: () => location.reload() }, 60_000);
}
const safeToReload = () => $('#rec').hidden && !$('#draft').value.trim() && !attached.length && document.activeElement?.id !== 'draft' && !document.querySelector('.sheet:not([hidden])');

// The home-screen app has no browser pull-to-refresh, so do it here.
function pullToRefresh(scroller) {
  const ptr = $('#ptr');
  let y0 = null, dy = 0;
  scroller.addEventListener('touchstart', e => { y0 = scroller.scrollTop <= 0 ? e.touches[0].clientY : null; dy = 0; }, { passive: true });
  scroller.addEventListener('touchmove', e => {
    if (y0 === null) return;
    dy = Math.max(0, (e.touches[0].clientY - y0) * 0.5);
    if (scroller.scrollTop > 0) { y0 = null; dy = 0; }
    ptr.hidden = dy < 8;
    ptr.style.transform = `translate(-50%, ${Math.min(dy, 90)}px)`;
    ptr.textContent = dy > 70 ? 'Release to refresh' : 'Pull to refresh';
  }, { passive: true });
  scroller.addEventListener('touchend', () => {
    if (y0 === null) return;
    y0 = null;
    if (dy > 70) { ptr.textContent = 'Refreshing…'; location.reload(); } else ptr.hidden = true;
  });
}

// ---------- actions ----------
// Optimistic: the card dims and the toast shows on the tap, and undo if herdr says no.
async function act(id, chip) {
  const a = state.agents.get(id);
  navigator.vibrate?.(8);
  state.sent.add(id);
  if (chip.text) showPending(id, chip.text);
  toast(`Sent to ${a?.project || 'agent'}: ${chip.label || chip.text}`);
  render();
  try {
    if (chip.keys) await api(`/api/agents/${encodeURIComponent(id)}/keys`, { keys: chip.keys });
    else await api(`/api/agents/${encodeURIComponent(id)}/prompt`, { text: chip.text });
  } catch (e) {
    state.sent.delete(id);
    if (state.pending?.id === id) state.pending = null;
    render();
    toast(e.code === 'agent_blocked' ? 'It is waiting on a question. Answer it first.' : `Not sent: ${e.message}`);
  }
}

// Your message shows in the conversation the moment you send it.
function showPending(id, text) {
  state.pending = { id, text, at: Date.now() };
  setTimeout(() => { if (state.pending?.text === text && Date.now() - state.pending.at >= 20_000) { state.pending = null; render(); } }, 20_000);
}

function stop(id) {
  if (state.stopArmed === id) {
    state.stopArmed = null;
    return act(id, { keys: ['esc'], label: 'Stop' });
  }
  state.stopArmed = id;
  toast('Tap Stop again to interrupt');
  setTimeout(() => { if (state.stopArmed === id) { state.stopArmed = null; render(); } }, 3000);
  render();
}

// /clear throws the conversation away, so it asks first.
function clearSession(id) {
  const a = state.agents.get(id);
  confirmSheet({
    title: 'Start a new session?',
    body: `Clears the conversation in ${a?.project || 'this agent'} (/clear). The agent keeps running in the same pane.`,
    label: 'Clear and start fresh',
    run: async () => {
      try {
        await api(`/api/agents/${encodeURIComponent(id)}/prompt`, { text: '/clear' });
        toast('Started a fresh session');
        // Claude takes a moment to switch transcripts; look a few times.
        for (const ms of [500, 1500, 3000, 6000]) setTimeout(() => { if (state.openId === id) loadDetail(); }, ms);
      } catch (e) {
        toast(e.code === 'agent_blocked' ? 'It is waiting on a question. Answer it first.' : `Not cleared: ${e.message}`);
      }
    },
  });
}

function confirmSheet({ title, body, label, run }) {
  closeSheet();
  const scrim = Object.assign(document.createElement('div'), { className: 'scrim' });
  const sheet = Object.assign(document.createElement('div'), { className: 'sheet confirm' });
  sheet.innerHTML = `<b class="ct">${esc(title)}</b><p>${esc(body)}</p>
    <button class="danger" data-ok>${esc(label)}</button>
    <button data-cancel>Cancel</button>`;
  scrim.onclick = closeSheet;
  sheet.onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;
    closeSheet();
    if (b.dataset.ok !== undefined) run();
  };
  document.body.append(scrim, sheet);
}

// ---------- herd ----------
// Finished agents read "New" until you've opened them (or seen them in herdr).
const pillText = a => ({ blocked: 'Asking', working: 'Working' }[a.status] || (isSeen(a, state.marks) ? 'Finished' : 'New'));
const pillClass = a => (a.status === 'done' || a.status === 'idle' ? (isSeen(a, state.marks) ? 'idle' : 'done') : a.status);
const pillHtml = a => `<span class="pill ${pillClass(a)}">${pillText(a)}</span>`;
const doneChip = id => `<button class="chip ghost" data-done="${esc(id)}">Done</button>`;

function ago(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function visible() {
  const f = activeFilter();
  return [...state.agents.values()].filter(a => f === 'all' || a.session === f);
}

// `full` shows what a model button will actually send under its label.
function chipHtml(id, chips, { full = false } = {}) {
  return chips.map((c, i) => {
    const hint = c.hint || (full && c.text && c.text.toLowerCase() !== c.label.toLowerCase() ? c.text : '');
    return `<button class="chip${c.primary ? ' primary' : ''}${c.source === 'model' ? ' model' : ''}" data-act="${esc(id)}" data-i="${i}">${esc(c.label)}${hint ? `<small>${esc(hint)}</small>` : ''}</button>`;
  }).join('');
}

function sessionTag(a) { return a.session !== 'default' ? `<span class="tag">${esc(a.session)}</span>` : ''; }

const inFilter = x => activeFilter() === 'all' || x.session === activeFilter();
const spaceHash = a => (a?.spaceId ? `s=${encodeURIComponent(a.spaceId)}` : '');

function renderHerd() {
  const list = visible();
  // Asking stays on top across every space; everything else is one square per space.
  const { asking, working } = groupAgents(list, state.marks);
  const tiles = spaceTiles(state.spaces.filter(inFilter), list, state.marks);
  const fresh = tiles.reduce((n, t) => n + t.fresh, 0);

  $('#count').textContent = [asking.length && `${asking.length} asking`, fresh && `${fresh} new`, working.length && `${working.length} working`].filter(Boolean).join(' · ') || 'All quiet';

  const counts = new Map();
  for (const sp of state.spaces) counts.set(sp.session, (counts.get(sp.session) || 0) + 1);
  $('#sessions').innerHTML = [{ name: 'all', running: true }, ...state.sessions].map(s => {
    const n = s.name === 'all' ? state.spaces.length : counts.get(s.name) || 0;
    return `<button data-filter="${esc(s.name)}" aria-pressed="${activeFilter() === s.name}" class="${s.running ? '' : 'down'}">${s.name === 'all' ? 'All' : esc(s.name)} · ${n}</button>`;
  }).join('');

  // Active spaces (asking, working, new) are wide rows on top; quiet ones are squares.
  const { active, quiet, hidden } = arrangeSpaces(tiles, state.hidden);
  $('#g-asking').hidden = !asking.length;
  $('#asking').innerHTML = asking.map(card).join('');
  $('#g-active').hidden = !active.length;
  $('#active').innerHTML = active.map(t => wide(t, list)).join('');
  $('#quiet-h').textContent = active.length ? 'Quiet' : 'Spaces';
  $('#g-spaces').hidden = !quiet.length && !!(active.length || hidden.length);
  $('#tiles').innerHTML = quiet.map(t => tile(t)).join('') || '<p class="empty">No herdr spaces running.</p>';
  $('#g-hidden').hidden = !hidden.length;
  $('#hidden-t').textContent = `${state.showHidden ? '▾' : '▸'} Hidden · ${hidden.length}`;
  $('#hidden-t').setAttribute('aria-expanded', String(state.showHidden));
  $('#hidden').hidden = !state.showHidden;
  $('#hidden').innerHTML = state.showHidden ? hidden.map(t => tile(t, { dim: true })).join('') : '';
  $('#hint').hidden = tiles.length < 2;
  bindSwipes();
}

const statusSpans = t => [
  t.asking && `<span class="d-ask">${t.asking} asking</span>`,
  t.working && `<span class="d-wk">${t.working} working</span>`,
  t.fresh && `<span class="d-new">${t.fresh} new</span>`,
].filter(Boolean).join('');

// A wide row for an active space: what's going on, and the agents doing it.
function wide(t, agents) {
  const sp = t.space;
  const u = t.asking ? 'u-ask' : t.working ? 'u-wk' : 'u-new';
  const mine = spaceAgents(agents, sp.id, state.marks).filter(a => a.status === 'blocked' || a.status === 'working' || !isSeen(a, state.marks)).slice(0, 2);
  const line = a => {
    const what = a.status === 'blocked' ? a.question?.question : a.status === 'working' ? a.live : a.summary;
    return `<span class="ln"><b>${esc(a.title || a.project)}</b>${what ? ` · ${esc(what)}` : ''}</span>`;
  };
  return `<button class="wide ${u}" data-space="${esc(sp.id)}">
    <span class="hd">${activeFilter() === 'all' && sp.session !== 'default' ? `<span class="tag">${esc(sp.session)}</span>` : ''}<span class="nm">${esc(sp.label)}</span><span class="ft">${t.endedAt ? ago(t.endedAt) : ''}</span></span>
    <span class="st">${statusSpans(t)}</span>
    ${mine.map(line).join('')}
  </button>`;
}

function tile(t, { dim = false } = {}) {
  const sp = t.space;
  const st = statusSpans(t);
  const foot = t.total ? `${t.total} agent${t.total > 1 ? 's' : ''}${t.endedAt ? ` · ${ago(t.endedAt)}` : ''}` : 'No agents';
  return `<button class="tile${t.asking ? ' hot' : ''}${dim ? ' dim' : ''}" data-space="${esc(sp.id)}">
    ${activeFilter() === 'all' && sp.session !== 'default' ? `<span class="tag">${esc(sp.session)}</span>` : ''}
    <span class="nm">${esc(sp.label)}</span>
    <span class="st">${st}</span>
    <span class="ft">${foot}</span>
  </button>`;
}

function workingCard(a) {
  return `<article class="card working" data-id="${esc(a.id)}">
      <div class="meta"><span class="pill working">Working</span>${sessionTag(a)}<span class="proj">${esc(a.project)}</span><span class="ago">${a.steps ? `${a.steps} steps` : ''}</span></div>
      <button class="open" data-open="${esc(a.id)}"><h2>${esc(a.title)}</h2></button>
      ${a.live ? `<div class="live"><span>▸</span><span>${esc(a.live)}</span></div>` : ''}
      ${a.queue?.length ? `<div class="next"><span>Next</span><span>${esc(a.queue[0].text)}</span>${a.queue.length > 1 ? `<span>+${a.queue.length - 1}</span>` : ''}</div>` : ''}
      <div class="bar"><i></i></div>
      <div class="chips"><button class="chip ${state.stopArmed === a.id ? 'warn' : 'ghost'}" data-stop="${esc(a.id)}">${state.stopArmed === a.id ? 'Tap to stop' : 'Stop'}</button></div>
    </article>`;
}

// ---------- space ----------
function renderSpace() {
  const sp = state.spaces.find(x => x.id === state.spaceId);
  const agents = spaceAgents([...state.agents.values()], state.spaceId, state.marks);
  $('#sp-title').textContent = sp?.label || state.spaceId;
  $('#sp-sub').textContent = `${sp?.session ?? ''} · ${agents.length} agent${agents.length === 1 ? '' : 's'}`;
  $('#sp-list').innerHTML = agents.map(a => (a.status === 'working' ? workingCard(a) : card(a))).join('') || '<p class="empty">No agents here yet.</p>';
  bindSwipes();
}

function newAgentSheet(spaceId) {
  closeSheet();
  const sp = state.spaces.find(x => x.id === spaceId);
  const scrim = Object.assign(document.createElement('div'), { className: 'scrim' });
  const sheet = Object.assign(document.createElement('form'), { className: 'sheet make' });
  sheet.innerHTML = `<b class="ct">New agent in ${esc(sp?.label || 'this space')}</b>
    <label for="na-label">Name</label>
    <input id="na-label" placeholder="e.g. Pricing page (the tab name in herdr)" autocomplete="off" maxlength="40">
    <label for="na-prompt">First message</label>
    <textarea id="na-prompt" placeholder="What should it work on? Leave empty to just start Claude."></textarea>
    <button class="go" type="submit">Start Claude</button>
    <button type="button" data-cancel>Cancel</button>`;
  scrim.onclick = closeSheet;
  $('[data-cancel]', sheet).onclick = closeSheet;
  sheet.onsubmit = async e => {
    e.preventDefault();
    const go = $('.go', sheet);
    go.disabled = true;
    go.textContent = 'Starting Claude…';
    try {
      await startAgent(spaceId, $('#na-label').value, $('#na-prompt').value, closeSheet);
    } catch {
      go.disabled = false;
      go.textContent = 'Start Claude';
    }
  };
  document.body.append(scrim, sheet);
  $('#na-label').focus();
}

// A new Claude tab in the space, opened once herdr reports it. Throws after telling you why.
async function startAgent(spaceId, label, prompt, started = () => {}) {
  try {
    const { id, waiting } = await api(`/api/spaces/${encodeURIComponent(spaceId)}/agents`, { label, prompt });
    started();
    if (waiting) toast(startupNote(prompt), null, 6000);
    else if (prompt.trim()) showPending(id, prompt.trim());
    // The new pane shows up on the next poll; open it once it's here.
    for (let i = 0; i < 20 && !state.agents.has(id); i++) await new Promise(r => setTimeout(r, 250));
    location.hash = `a=${encodeURIComponent(id)}`;
  } catch (err) {
    toast(err.code === 'agent_not_ready' ? 'Claude is waiting on something in the new tab. Open it in herdr.' : `Not started: ${err.message}`, null, 5000);
    throw err;
  }
}

// Long-press a space: hide it from home (Whistle only) or delete it in herdr.
function spaceMenu(spaceId) {
  const sp = state.spaces.find(x => x.id === spaceId);
  if (!sp) return;
  closeSheet();
  const mine = [...state.agents.values()].filter(a => a.spaceId === spaceId);
  const hidden = state.hidden.includes(spaceId);
  const scrim = Object.assign(document.createElement('div'), { className: 'scrim' });
  const sheet = Object.assign(document.createElement('div'), { className: 'sheet' });
  sheet.innerHTML = `<b class="sh">${esc(sp.label)}<small>${esc(sp.session)} · ${mine.length} agent${mine.length === 1 ? '' : 's'}</small></b>
    <button data-m="hide">${hidden ? 'Show on home' : 'Hide from home'}<small>${hidden ? 'Put it back with the other spaces.' : 'Only in Whistle. It keeps running in herdr, and questions still show under Asking you.'}</small></button>
    <button data-m="delete" class="del">Delete space…<small>Closes it in herdr and ends its agents.</small></button>
    <button data-m="cancel">Cancel</button>`;
  scrim.onclick = closeSheet;
  sheet.onclick = e => {
    const m = e.target.closest('button')?.dataset.m;
    if (!m) return;
    closeSheet();
    if (m === 'hide') {
      setHidden(hidden ? state.hidden.filter(x => x !== spaceId) : [...state.hidden, spaceId]);
      if (!hidden) toast(`Hid ${sp.label}`, { label: 'Undo', run: () => setHidden(state.hidden.filter(x => x !== spaceId)) });
    } else if (m === 'delete') deleteSpace(sp, mine);
  };
  document.body.append(scrim, sheet);
}

function deleteSpace(sp, mine) {
  const working = mine.filter(a => a.status === 'working').length;
  confirmSheet({
    title: `Delete ${sp.label}?`,
    body: `Closes the workspace in herdr${mine.length ? ` and ends its ${mine.length} agent${mine.length === 1 ? '' : 's'}` : ''}.${working ? ` ${working} ${working === 1 ? 'is' : 'are'} still working.` : ''} Files on disk are not touched. This can't be undone.`,
    label: 'Delete space',
    run: async () => {
      try {
        await fetch(`/api/spaces/${encodeURIComponent(sp.id)}`, { method: 'DELETE' }).then(async r => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error?.message || `HTTP ${r.status}`); });
        if (state.hidden.includes(sp.id)) setHidden(state.hidden.filter(x => x !== sp.id));
        if (state.spaceId === sp.id) location.hash = '';
        toast(`Deleted ${sp.label}`);
      } catch (e) { toast(`Not deleted: ${e.message}`, null, 5000); }
    },
  });
}

// Something said into the home-screen mic: Haiku on the Mac picks where it goes,
// this card shows it. Safe places start by themselves after a moment unless you touch the card.
function routeSheet(said) {
  closeSheet();
  const scrim = Object.assign(document.createElement('div'), { className: 'scrim' });
  const sheet = Object.assign(document.createElement('form'), { className: 'sheet make route' });
  sheet.innerHTML = `<b class="ct" id="rt-title">Working out where that goes…</b>
    <p class="note" id="rt-sub"></p>
    <textarea id="rt-prompt" aria-label="Message">${esc(said)}</textarea>
    <div class="else" id="rt-else" hidden>
      <input id="rt-find" type="search" placeholder="Find a space" autocomplete="off" autocapitalize="off" spellcheck="false">
      <div class="picks" id="rt-picks"></div>
      <button type="button" id="rt-newspace">New space…</button>
    </div>
    <button class="go" type="submit" disabled>Start Claude</button>
    <button type="button" id="rt-other">Somewhere else</button>
    <button type="button" data-cancel>Cancel</button>`;
  const go = $('.go', sheet), title = $('#rt-title', sheet), sub = $('#rt-sub', sheet), text = $('#rt-prompt', sheet);
  let route = null, timer = null, closed = false;
  const close = () => { closed = true; stopCountdown(); closeSheet(); };
  scrim.onclick = close;
  $('[data-cancel]', sheet).onclick = close;

  const stopCountdown = () => { clearInterval(timer); timer = null; if (route) go.textContent = 'Start Claude'; };
  const countdown = () => {
    const end = Date.now() + AUTO_GO_MS;
    const tickGo = () => {
      const left = Math.ceil((end - Date.now()) / 1000);
      if (left <= 0) { stopCountdown(); sheet.requestSubmit(); } else go.textContent = `Start Claude · ${left}`;
    };
    tickGo();
    timer = setInterval(tickGo, 200);
  };
  // Touching the card means you want a look first.
  ['pointerdown', 'focusin', 'input'].forEach(ev => sheet.addEventListener(ev, e => { if (e.target !== go) stopCountdown(); }));

  const show = r => {
    route = r;
    title.textContent = routeTitle(r);
    sub.hidden = !(r.kind === 'init' || r.kind === 'clone');
    sub.textContent = r.kind === 'init' ? 'Makes the folder and runs git init.' : r.kind === 'clone' ? 'Clones it into ~/Code first.' : '';
    text.value = r.prompt;
    go.disabled = r.kind === 'unsure';
    go.textContent = 'Start Claude';
    if (r.kind === 'unsure') showElse();
    else if (autoGo(r)) countdown();
  };

  const showElse = () => {
    stopCountdown();
    $('#rt-else', sheet).hidden = false;
    $('#rt-other', sheet).hidden = true;
    drawPicks();
  };
  const drawPicks = () => {
    const q = $('#rt-find', sheet).value.trim().toLowerCase();
    const many = state.sessions.length > 1;
    const hits = [...state.spaces].filter(sp => !q || sp.label.toLowerCase().includes(q)).sort((a, b) => a.label.localeCompare(b.label));
    $('#rt-picks', sheet).innerHTML = hits.map(sp => `<button type="button" data-space="${esc(sp.id)}" class="${route?.spaceId === sp.id ? 'on' : ''}"><span>${esc(sp.label)}</span>${many ? `<small>${esc(sp.session)}</small>` : ''}</button>`).join('') || '<p class="note">No spaces match.</p>';
  };
  $('#rt-other', sheet).onclick = showElse;
  $('#rt-find', sheet).oninput = drawPicks;
  $('#rt-picks', sheet).onclick = e => {
    const b = e.target.closest('[data-space]');
    if (!b) return;
    const sp = state.spaces.find(x => x.id === b.dataset.space);
    show({ kind: 'space', spaceId: sp.id, where: sp.label, label: route?.kind === 'space' ? route.label : '', prompt: text.value });
    stopCountdown();
    drawPicks();
  };
  $('#rt-newspace', sheet).onclick = () => { const p = text.value; close(); newSpaceSheet({ prompt: p }); };

  sheet.onsubmit = async e => {
    e.preventDefault();
    if (!route || route.kind === 'unsure' || go.disabled) return;
    stopCountdown();
    const prompt = text.value;
    go.disabled = true;
    go.textContent = route.kind === 'clone' ? 'Cloning…' : 'Starting Claude…';
    try {
      if (route.kind === 'space') await startAgent(route.spaceId, route.label, prompt, close);
      else await startSpace({ label: route.label, prompt, ...(route.kind === 'folder' ? { cwd: route.cwd } : route.kind === 'init' ? { init: true } : { clone: route.repo }) }, close);
    } catch {
      go.disabled = false;
      go.textContent = 'Start Claude';
    }
  };

  document.body.append(scrim, sheet);
  api('/api/route', { text: said })
    .then(r => { if (!closed) show(r); })
    .catch(err => { if (!closed) { show({ kind: 'unsure', label: '', prompt: said }); toast(`Couldn't pick a place: ${err.message}`, null, 4000); } });
}

// Claude stopped on a question while starting (often "trust this folder?").
const startupNote = prompt => `Claude is asking something first.${prompt?.trim() ? ' Your message goes once you answer.' : ''}`;

// Where a new space's code comes from: a folder already on the Mac, a new repo, or a GitHub clone.
const slugify = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const tilde = p => p.replace(/^\/Users\/[^/]+/, '~');

// New spaces go to the filtered session, else default, else the first one running.
function defaultSession() {
  const running = state.sessions.filter(s => s.running);
  return activeFilter() !== 'all' ? activeFilter() : running.some(s => s.name === 'default') ? 'default' : running[0]?.name || '';
}

// A new space with Claude in it, opened once herdr reports it. Throws after telling you why.
async function startSpace(body, started = () => {}) {
  try {
    const { id, waiting } = await api('/api/spaces', { session: defaultSession(), ...body });
    started();
    if (waiting) toast(startupNote(body.prompt), null, 6000);
    else if (body.prompt?.trim()) showPending(id, body.prompt.trim());
    for (let i = 0; i < 20 && !state.agents.has(id); i++) await new Promise(r => setTimeout(r, 250));
    location.hash = `a=${encodeURIComponent(id)}`;
  } catch (err) {
    toast(err.code === 'agent_not_ready' ? 'Claude is waiting on something in the new space. Open it in herdr.' : `Not created: ${err.message}`, null, 5000);
    throw err;
  }
}

function newSpaceSheet({ prompt = '' } = {}) {
  closeSheet();
  const running = state.sessions.filter(s => s.running);
  const pick = defaultSession();
  const scrim = Object.assign(document.createElement('div'), { className: 'scrim' });
  const sheet = Object.assign(document.createElement('form'), { className: 'sheet make' });
  sheet.innerHTML = `<b class="ct">New space</b>
    <label for="ns-label">Name</label>
    <input id="ns-label" placeholder="e.g. Lighthouse" autocomplete="off" maxlength="40">
    <label>Code</label>
    <div class="seg" role="tablist">
      <button type="button" data-mode="folder" class="on">Folder</button>
      <button type="button" data-mode="init">New repo</button>
      <button type="button" data-mode="clone">Clone</button>
    </div>
    <input id="ns-find" type="search" placeholder="Find a folder" autocomplete="off" autocapitalize="off" spellcheck="false">
    <div class="picks" id="ns-picks"><p class="note">Loading…</p></div>
    <p class="note" id="ns-note" hidden></p>
    ${running.length > 1 ? `<label for="ns-session">herdr session</label><select id="ns-session">${running.map(s => `<option${s.name === pick ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}</select>` : ''}
    <label for="ns-prompt">First message</label>
    <textarea id="ns-prompt" placeholder="What should Claude work on? Leave empty to just start it.">${esc(prompt)}</textarea>
    <button class="go" type="submit">Create and start Claude</button>
    <button type="button" data-cancel>Cancel</button>`;
  scrim.onclick = closeSheet;
  $('[data-cancel]', sheet).onclick = closeSheet;

  let mode = 'folder', chosen = null, root = '~/Code';
  let folders = null, repos = null, repoErr = '';
  const find = $('#ns-find', sheet), picks = $('#ns-picks', sheet), note = $('#ns-note', sheet), name = $('#ns-label', sheet);

  const draw = () => {
    find.hidden = picks.hidden = mode === 'init';
    note.hidden = mode !== 'init';
    find.placeholder = mode === 'clone' ? 'Find a GitHub repo' : 'Find a folder';
    if (mode === 'init') {
      const slug = slugify(name.value);
      note.textContent = slug ? `Makes ${root}/${slug} and runs git init.` : 'Type a name above. Makes a folder for it in ' + root + ' and runs git init.';
      return;
    }
    const q = find.value.trim().toLowerCase();
    const list = mode === 'clone' ? repos : folders;
    if (!list) { picks.innerHTML = `<p class="note">${esc(repoErr || 'Loading…')}</p>`; return; }
    const hits = list.filter(x => !q || (x.full || x.name).toLowerCase().includes(q) || (x.description || '').toLowerCase().includes(q)).slice(0, 60);
    picks.innerHTML = hits.length ? hits.map(x => mode === 'clone'
      ? `<button type="button" data-pick="${esc(x.full)}" class="${chosen === x.full ? 'on' : ''}"><span>${esc(x.full)}${x.private ? ' <i>private</i>' : ''}</span><small>${x.local ? `Already in ${esc(tilde(x.local))}` : esc(x.description || ago(x.pushedAt))}</small></button>`
      : `<button type="button" data-pick="${esc(x.path)}" class="${chosen === x.path ? 'on' : ''}"><span>${esc(x.name)}</span><small>${x.git ? 'git' : 'not a repo'}</small></button>`).join('')
      : `<p class="note">Nothing matches.</p>`;
  };

  api('/api/folders').then(r => { root = tilde(r.root); folders = r.folders; draw(); }).catch(e => { folders = []; repoErr = e.message; draw(); });
  const loadRepos = () => {
    if (repos) return;
    api('/api/repos').then(r => { repos = r.repos; draw(); }).catch(e => { repoErr = e.message; draw(); });
  };

  $('.seg', sheet).onclick = e => {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    mode = b.dataset.mode;
    chosen = null;
    find.value = '';
    name.placeholder = 'e.g. Lighthouse';
    sheet.querySelectorAll('.seg button').forEach(x => x.classList.toggle('on', x === b));
    if (mode === 'clone') loadRepos();
    draw();
  };
  picks.onclick = e => {
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    chosen = chosen === b.dataset.pick ? null : b.dataset.pick;
    if (chosen && !name.value) name.placeholder = chosen.split('/').at(-1);
    draw();
  };
  find.oninput = draw;
  name.oninput = () => { if (mode === 'init') draw(); };

  sheet.onsubmit = async e => {
    e.preventDefault();
    const where = mode === 'init' ? { init: true } : mode === 'clone' ? { clone: chosen || '' } : { cwd: chosen || '' };
    if (mode === 'init' && !slugify(name.value)) { toast('Give the new space a name.'); name.focus(); return; }
    if (mode !== 'init' && !chosen) { toast(mode === 'clone' ? 'Pick a repo to clone.' : 'Pick a folder.'); return; }
    const go = $('.go', sheet);
    go.disabled = true;
    go.textContent = mode === 'clone' && !repos?.find(r => r.full === chosen)?.local ? 'Cloning…' : 'Starting Claude…';
    try {
      await startSpace({ session: $('#ns-session')?.value || pick, label: name.value, prompt: $('#ns-prompt').value, ...where }, closeSheet);
    } catch {
      go.disabled = false;
      go.textContent = 'Create and start Claude';
    }
  };
  document.body.append(scrim, sheet);
  draw();
  name.focus();
}

function card(a) {
  const sent = state.sent.has(a.id);
  const body = a.question
    ? `<p class="q">${esc(a.question.question)}</p>`
    : a.summary ? `<p>${esc(a.summary)}</p>` : '';
  const cleared = isDone(a, state.marks);
  const finished = a.status !== 'blocked' && !cleared;
  const chips = sent ? '' : chipHtml(a.id, a.suggestions.slice(0, 3)) + (finished ? doneChip(a.id) : '');
  return `<article class="card${sent ? ' sent' : ''}${cleared ? ' cleared' : ''}" data-id="${esc(a.id)}">
    ${a.suggestions[0] && !sent ? `<div class="swipehint">${esc(a.suggestions[0].label)} ›</div>` : ''}
    ${finished && !sent ? '<div class="swipehint left">‹ Done</div>' : ''}
    <div class="meta">${pillHtml(a)}${sessionTag(a)}<span class="proj">${esc(a.project)}</span><span class="ago">${sent ? 'sent' : ago(a.endedAt)}</span></div>
    <button class="open" data-open="${esc(a.id)}"><h2>${esc(a.title)}</h2>${body}</button>
    ${chips ? `<div class="chips">${chips}</div>` : ''}
  </article>`;
}

// Swipe right sends the top suggestion; swipe left marks a finished agent done.
function bindSwipes() {
  for (const card of document.querySelectorAll('#asking .card, #sp-list .card:not(.working)')) {
    const id = card.dataset.id;
    const a = state.agents.get(id);
    if (!a || state.sent.has(id)) continue;
    const top = a.suggestions?.[0];
    const canDone = a.status !== 'blocked' && !isDone(a, state.marks);
    if (!top && !canDone) continue;
    const right = $('.swipehint:not(.left)', card), left = $('.swipehint.left', card);
    let x0 = null, y0 = 0, dx = 0;
    card.addEventListener('pointerdown', e => { if (e.target.closest('.chip')) return; x0 = e.clientX; y0 = e.clientY; dx = 0; });
    card.addEventListener('pointermove', e => {
      if (x0 === null) return;
      dx = e.clientX - x0;
      if (dx > 0 && !top) dx = 0;
      if (dx < 0 && !canDone) dx = 0;
      if (!card.classList.contains('dragging')) {
        if (Math.abs(e.clientY - y0) > 12) { x0 = null; return; } // vertical scroll wins
        if (Math.abs(dx) < 10) return;
        card.classList.add('dragging');
        card.setPointerCapture(e.pointerId);
      }
      card.style.transform = `translateX(${dx}px)`;
      for (const [hint, on] of [[right, dx > 0], [left, dx < 0]]) {
        if (!hint) continue;
        hint.style.opacity = on ? Math.min(1, Math.abs(dx) / 110) : 0;
        hint.style.zIndex = on ? 0 : -1;
      }
    });
    const end = () => {
      if (x0 === null) return;
      x0 = null;
      const dragged = card.classList.contains('dragging');
      card.classList.remove('dragging');
      if (dragged && Math.abs(dx) > 110) {
        card.style.transform = `translateX(${dx > 0 ? 110 : -110}%)`;
        card.style.opacity = 0;
        navigator.vibrate?.(10);
        setTimeout(() => (dx > 0 ? act(id, top) : markDone(id)), 180);
      } else {
        card.style.transform = '';
        if (right) right.style.opacity = 0;
        if (left) left.style.opacity = 0;
      }
      if (dragged) card.addEventListener('click', e => e.stopPropagation(), { capture: true, once: true });
    };
    card.addEventListener('pointerup', end);
    card.addEventListener('pointercancel', end);
  }
}

// ---------- session ----------
let refreshT;
function refreshDetailSoon() { clearTimeout(refreshT); refreshT = setTimeout(loadDetail, 350); }

const inflight = new Map(); // agentId -> detail request, shared by prefetch and open
function fetchDetail(id) {
  if (!inflight.has(id)) {
    inflight.set(id, api(`/api/agents/${encodeURIComponent(id)}`)
      .then(d => { state.details.set(id, d); return d; })
      .finally(() => setTimeout(() => inflight.delete(id), 300)));
  }
  return inflight.get(id);
}

async function loadDetail() {
  const id = state.openId;
  if (!id) return;
  try {
    const d = await fetchDetail(id);
    if (state.openId !== id) return;
    state.detail = d;
    renderSession();
  } catch (e) {
    if (e.status === 404) { toast('That agent is gone.'); location.hash = state.spaceId ? `s=${encodeURIComponent(state.spaceId)}` : ''; }
  }
}

function stripHtml(turn, i) {
  if (!turn.steps.length) return '';
  const files = Object.entries(turn.files);
  const bad = turn.steps.filter(s => s.ok === false).length;
  const running = turn.steps.some(s => s.ok === null);
  const ticks = turn.steps.slice(-60).map(s => `<i class="${s.ok === true ? 'ok' : s.ok === false ? 'bad' : 'run'}"></i>`).join('');
  const sum = [`<b>${turn.steps.length} step${turn.steps.length === 1 ? '' : 's'}</b>`];
  if (files.length) sum.push(`${files.length} file${files.length === 1 ? '' : 's'}`);
  if (bad) sum.push(`${bad} failed`);
  if (running) sum.push('running');
  const items = turn.steps.map(s => `<li class="${s.ok === false ? 'bad' : ''}">${esc(s.label)}</li>`).join('');
  return `<div class="strip"><button data-strip="${i}" aria-expanded="false"><span class="ticks">${ticks}</span><span class="sum">${sum.join(' · ')}</span><span aria-hidden="true">▾</span></button><ol hidden>${items}</ol></div>`;
}

function diffHtml(turn) {
  return turn.steps.filter(s => s.diff).slice(-3).map(s => {
    const f = turn.files[s.diff.file] || { added: 0, removed: 0 };
    const rows = [...s.diff.removed.map(l => `<div class="m">-${esc(l)}</div>`), ...s.diff.added.map(l => `<div class="p">+${esc(l)}</div>`)].join('');
    return `<div class="diff"><div class="h"><span>${esc(base(s.diff.file))}</span><span><span class="a">+${f.added}</span> <span class="d">−${f.removed}</span></span></div><pre>${rows}</pre></div>`;
  }).join('');
}

function renderSession() {
  const d = state.detail;
  const a = state.agents.get(state.openId) || d?.agent;
  if (!a) return;
  $('#s-title').textContent = a.title || a.project;
  $('#back').textContent = `‹ ${state.spaces.find(x => x.id === a.spaceId)?.label || 'Spaces'}`;
  $('#s-sub').textContent = `${a.project} · ${a.session}/${a.paneId}`;
  const pill = $('#s-pill');
  pill.className = `pill ${pillClass(a)}`;
  pill.textContent = pillText(a);
  if ((a.status === 'done' || a.status === 'idle') && !isSeen(a, state.marks)) mark(a.id, 'seen');

  const scroller = $('#s-scroll');
  const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
  const t = d?.transcript;
  let html = '';
  if (!d) html = '<div class="loading" aria-label="Loading"><i></i><i></i><i></i><i></i></div>';
  else if (!t) html = '<p class="notx">No Claude transcript found for this pane.</p>';
  else {
    const turns = state.showAllTurns ? t.turns : t.turns.slice(-4);
    const hidden = t.totalTurns - turns.length;
    if (hidden > 0) html += `<button class="earlier" data-earlier>${state.showAllTurns ? '' : `Show ${Math.min(hidden, t.turns.length - turns.length)} earlier`}</button>`;
    turns.forEach((turn, i) => {
      const isLast = i === turns.length - 1;
      html += `<section class="turn"><div class="you">${esc(turn.prompt)}</div>${stripHtml(turn, i)}`;
      const blocks = mdBlocks(turn.answer);
      if (blocks.length) html += `<div class="answer">${blocks.map(b => `<${b.tag} data-quote="${esc(b.text)}">${b.html}</${b.tag}>`).join('')}</div>`;
      if (isLast) html += diffHtml(turn);
      html += '</section>';
    });
    if (!t.turns.length) html = '<p class="notx">No turns yet.</p>';
  }
  const p = state.pending;
  if (p?.id === a.id && d) {
    if (t?.turns?.some(x => x.prompt?.trim() === p.text.trim())) state.pending = null;
    else html += `<section class="turn"><div class="you pending">${esc(p.text)}</div></section>`;
  }
  if (a.question) {
    html += `<div class="ask"><div class="ctx">Waiting on you · ${esc(a.question.header)}</div><div class="qq">${esc(a.question.question)}</div>
      ${a.question.options.map(o => `<button data-keys="${esc(JSON.stringify(o.keys ?? [String(o.n)]))}"><b>${esc(o.label)}</b>${o.description ? `<span>${esc(o.description)}</span>` : ''}</button>`).join('')}</div>`;
  }
  else if (a.status === 'blocked') {
    html += `<div class="ask"><div class="ctx">Waiting on you</div><div class="qq">Claude is asking something Whistle can't read. Answer it in herdr. Dismiss (Esc) cancels it.</div></div>`;
  }
  $('#s-body').innerHTML = html;

  const chips = a.question ? [] : [...a.suggestions];
  let dock = chipHtml(a.id, chips, { full: true });
  if (a.status === 'working') dock += `<button class="chip ${state.stopArmed === a.id ? 'warn' : 'ghost'}" data-stop="${esc(a.id)}">${state.stopArmed === a.id ? 'Tap to stop' : 'Stop'}</button>`;
  if (a.status === 'blocked') dock += `<button class="chip ghost" data-esc="${esc(a.id)}">Dismiss (Esc)</button>`;
  if (a.status === 'done' || a.status === 'idle') {
    if (!isDone(a, state.marks)) dock += doneChip(a.id);
    dock += `<button class="chip ghost" data-clear="${esc(a.id)}">New session</button>`;
  }
  $('#s-queue').innerHTML = (a.queue || []).map((q, i) => `<div class="qitem"><span class="qlabel">${i ? 'Then' : 'Next'}</span><span class="qtext">${esc(q.text)}</span><button class="qx" data-unqueue="${esc(q.id)}" aria-label="Cancel queued message">✕</button></div>`).join('');
  // While it works, the composer queues instead of interrupting the turn.
  const queuing = a.status === 'working';
  $('#draft').placeholder = queuing ? 'Queue a message for when it finishes…' : 'Say something…';
  $('#send').textContent = queuing ? '⇥' : '↑';
  $('#send').setAttribute('aria-label', queuing ? 'Queue' : 'Send');
  $('#s-chips').innerHTML = dock;
  if (nearBottom || !scroller.dataset.seen) { scroller.scrollTop = scroller.scrollHeight; scroller.dataset.seen = '1'; }
}

function openSheet(el) {
  closeSheet();
  el.classList.add('sel');
  const quote = el.dataset.quote;
  const scrim = Object.assign(document.createElement('div'), { className: 'scrim' });
  const sheet = Object.assign(document.createElement('div'), { className: 'sheet' });
  sheet.innerHTML = `<q>${esc(quote)}</q>
    <button data-q="I don't think this is right: "><b>Push back</b><small>Disagree with this part</small></button>
    <button data-q="Redo just this part: "><b>Redo this part</b><small>Keep the rest, change only this</small></button>
    <button data-q="Why? "><b>Ask why</b><small>Explain this choice</small></button>`;
  scrim.onclick = closeSheet;
  sheet.onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;
    const draft = $('#draft');
    const short = quote.length > 400 ? quote.slice(0, 400) + '…' : quote;
    draft.value = `> ${short.replace(/\n/g, '\n> ')}\n\n${b.dataset.q}`;
    closeSheet();
    grow(draft);
    draft.focus();
    draft.setSelectionRange(draft.value.length, draft.value.length);
  };
  document.body.append(scrim, sheet);
}
function closeSheet() {
  document.querySelectorAll('.sheet:not(.out), .scrim:not(.out)').forEach(n => {
    n.classList.add('out');
    n.style.pointerEvents = 'none';
    setTimeout(() => n.remove(), 170);
  });
  document.querySelectorAll('.answer .sel').forEach(n => n.classList.remove('sel'));
}

function grow(t) { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 140) + 'px'; }

// ---------- routing ----------
function route() {
  const a = location.hash.match(/^#a=(.+)$/);
  const sp = location.hash.match(/^#s=(.+)$/);
  const id = a ? decodeURIComponent(a[1]) : null;
  closeSheet();
  if (id !== state.openId) { state.detail = id ? state.details.get(id) ?? null : null; state.showAllTurns = false; delete $('#s-scroll').dataset.seen; $('#s-body').innerHTML = ''; }
  state.openId = id;
  state.spaceId = sp ? decodeURIComponent(sp[1]) : id ? state.agents.get(id)?.spaceId ?? null : null;
  const depth = id ? 2 : sp ? 1 : 0;
  const view = ['herd', 'space', 'session'][depth];
  if (lastDepth !== null && depth !== lastDepth) slideIn($(`#${view}`), depth > lastDepth ? 'in-fwd' : 'in-back');
  lastDepth = depth;
  $('#herd').hidden = !!(id || sp);
  $('#space').hidden = !sp;
  $('#session').hidden = !id;
  render();
  if (id) loadDetail();
}

let lastDepth = null;
function slideIn(el, cls) {
  el.classList.remove('in-fwd', 'in-back');
  void el.offsetWidth; // restart the animation
  el.classList.add(cls);
  el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
}

function render() {
  if (state.openId) renderSession();
  else if (location.hash.startsWith('#s=')) renderSpace();
  else renderHerd();
}

let toastT;
function toast(msg, action, ms) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action.label)}</button>` : ''}`;
  if (action) $('button', t).onclick = () => { t.hidden = true; action.run(); };
  // Sit just above the reply bar in the session view, so it doesn't cover the queue.
  t.style.bottom = state.openId ? `${$('#dock').offsetHeight + 10}px` : '';
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.hidden = true; }, ms ?? (action ? 5000 : 2600));
}

// ---------- events ----------
// Long-press a reply button to put its text in the composer instead of sending it.
// Long-press a space for its menu.
let pressT = null, pressed = false, px = 0, py = 0;
document.addEventListener('pointermove', e => { if (Math.hypot(e.clientX - px, e.clientY - py) > 10) clearTimeout(pressT); });
// Start loading an agent as soon as a finger lands on it, so it's there by the tap.
document.addEventListener('pointerdown', e => {
  const open = e.target.closest('[data-open]');
  if (open) fetchDetail(open.dataset.open).catch(() => {});
}, { capture: true });
document.addEventListener('pointerdown', e => {
  const el = e.target.closest('[data-act],[data-space]');
  if (!el) return;
  pressed = false;
  px = e.clientX; py = e.clientY;
  clearTimeout(pressT);
  if (el.dataset.space) {
    pressT = setTimeout(() => { pressed = true; getSelection()?.removeAllRanges(); navigator.vibrate?.(10); spaceMenu(el.dataset.space); }, 450);
    return;
  }
  pressT = setTimeout(() => {
    const a = state.agents.get(el.dataset.act);
    const chip = a?.suggestions?.[Number(el.dataset.i)];
    if (!chip?.text) return;
    pressed = true;
    if (state.openId !== a.id) location.hash = `a=${encodeURIComponent(a.id)}`;
    setTimeout(() => {
      const d = $('#draft');
      d.value = chip.text;
      grow(d);
      d.focus();
      d.setSelectionRange(d.value.length, d.value.length);
    }, 0);
  }, 450);
});
for (const ev of ['pointerup', 'pointercancel']) document.addEventListener(ev, () => clearTimeout(pressT));
document.addEventListener('selectstart', e => { if (e.target.closest?.('[data-space]')) e.preventDefault(); });
document.addEventListener('contextmenu', e => {
  if (e.target.closest('[data-act],[data-space]')) e.preventDefault();
  // A mouse right-click on a space opens its menu too.
  const sp = e.target.closest('[data-space]');
  if (sp && e.pointerType !== 'touch' && !pressed) spaceMenu(sp.dataset.space);
});

document.addEventListener('click', e => {
  if (pressed && e.target.closest('[data-act],[data-space]')) { pressed = false; return; }
  const el = e.target.closest('[data-space],[data-act],[data-done],[data-unqueue],[data-open],[data-filter],[data-stop],[data-clear],[data-esc],[data-keys],[data-strip],[data-earlier],.answer > *');
  if (!el) return;
  if (el.dataset.space) location.hash = `s=${encodeURIComponent(el.dataset.space)}`;
  else if (el.dataset.act) {
    const a = state.agents.get(el.dataset.act);
    const chip = a?.suggestions?.[Number(el.dataset.i)];
    if (chip) act(a.id, chip);
  } else if (el.dataset.done) markDone(el.dataset.done);
  else if (el.dataset.unqueue) {
    fetch(`/api/agents/${encodeURIComponent(state.openId)}/queue/${encodeURIComponent(el.dataset.unqueue)}`, { method: 'DELETE' })
      .then(r => toast(r.ok ? 'Removed from the queue' : 'Already sent'));
  }
  else if (el.dataset.open) location.hash = `a=${encodeURIComponent(el.dataset.open)}`;
  else if (el.dataset.filter) setFilter(el.dataset.filter);
  else if (el.dataset.stop) stop(el.dataset.stop);
  else if (el.dataset.clear) clearSession(el.dataset.clear);
  else if (el.dataset.esc) act(el.dataset.esc, { keys: ['esc'], label: 'Esc' });
  else if (el.dataset.keys) act(state.openId, { keys: JSON.parse(el.dataset.keys), label: el.querySelector('b')?.textContent });
  else if (el.dataset.strip !== undefined) {
    const ol = el.nextElementSibling;
    ol.hidden = !ol.hidden;
    el.setAttribute('aria-expanded', String(!ol.hidden));
  } else if (el.dataset.earlier !== undefined) { state.showAllTurns = true; renderSession(); }
  else if (el.closest('.answer') && !e.target.closest('a')) openSheet(el);
});

$('#back').onclick = () => { location.hash = spaceHash(state.agents.get(state.openId) || state.detail?.agent); };
$('#sp-back').onclick = () => { location.hash = ''; };
$('#sp-new').onclick = () => newAgentSheet(state.spaceId);
$('#new-space').onclick = newSpaceSheet;
$('#hidden-t').onclick = () => { state.showHidden = !state.showHidden; renderHerd(); };
window.addEventListener('hashchange', route);

const draft = $('#draft');
draft.addEventListener('input', () => grow(draft));
draft.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); } });
// ---------- screenshots ----------
// Picked or pasted images wait as thumbnails above the composer and go up when you send.
let attached = []; // [{ blob, url }]
const READABLE = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

// iPhone photos can be HEIC, which the agent can't read; redraw anything else as JPEG.
async function readable(file) {
  if (READABLE.includes(file.type)) return file;
  const bmp = await createImageBitmap(file);
  const c = Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
  c.getContext('2d').drawImage(bmp, 0, 0);
  return new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('could not convert image'))), 'image/jpeg', 0.9));
}

async function attach(files) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    try {
      const blob = await readable(f);
      attached.push({ blob, url: URL.createObjectURL(blob) });
    } catch { toast(`Couldn't read ${f.name || 'that image'}.`); }
  }
  renderAttached();
}

function renderAttached(sending = false) {
  $('#s-attached').innerHTML = attached.map((a, i) => `<div class="thumb${sending ? ' sending' : ''}"><img src="${a.url}" alt="Screenshot ${i + 1}">${sending ? '' : `<button type="button" class="tx" data-detach="${i}" aria-label="Remove screenshot ${i + 1}">✕</button>`}</div>`).join('');
}

function clearAttached() {
  attached.forEach(a => URL.revokeObjectURL(a.url));
  attached = [];
  renderAttached();
}

async function upload(blob) {
  const r = await fetch('/api/uploads', { method: 'POST', headers: { 'content-type': blob.type }, body: blob });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error?.message || `HTTP ${r.status}`);
  return data.path;
}

$('#attach').onclick = () => $('#files').click();
$('#files').addEventListener('change', e => { attach([...e.target.files]); e.target.value = ''; });
$('#s-attached').addEventListener('click', e => {
  const b = e.target.closest('[data-detach]');
  if (!b) return;
  const [gone] = attached.splice(Number(b.dataset.detach), 1);
  URL.revokeObjectURL(gone.url);
  renderAttached();
});
draft.addEventListener('paste', e => {
  const imgs = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
  if (!imgs.length) return;
  e.preventDefault();
  attach(imgs);
});

$('#composer').addEventListener('submit', async e => {
  e.preventDefault();
  const typed = draft.value.trim();
  if ((!typed && !attached.length) || !state.openId) return;
  const before = draft.value;
  draft.value = '';
  grow(draft);
  const id = state.openId;
  const queuing = state.agents.get(id)?.status === 'working';
  if (!attached.length) {
    if (!queuing) { showPending(id, typed); state.sent.add(id); }
    toast(queuing ? 'Queued. It sends when this turn finishes.' : 'Sent');
    renderSession();
  }
  const optimistic = !attached.length;
  try {
    let text = typed;
    if (attached.length) {
      renderAttached(true);
      text = withImages(typed, await Promise.all(attached.map(a => upload(a.blob))));
    }
    if (queuing) {
      await api(`/api/agents/${encodeURIComponent(id)}/queue`, { text });
      if (!optimistic) toast('Queued. It sends when this turn finishes.');
    } else {
      if (!optimistic) showPending(id, typed || 'Screenshot');
      await api(`/api/agents/${encodeURIComponent(id)}/prompt`, { text });
      state.sent.add(id);
      if (!optimistic) toast('Sent');
    }
    clearAttached();
  } catch (err) {
    state.sent.delete(id);
    if (state.pending?.id === id) state.pending = null;
    renderSession();
    draft.value = before;
    grow(draft);
    renderAttached();
    toast(err.code === 'agent_blocked' ? 'It is waiting on a question. Answer it first.' : `Not sent: ${err.message}`);
  }
});

// ---------- hold to talk ----------
// Hold the mic and talk; let go to send, slide away to throw it away.
// The phone records, whisper on the Mac turns it into text, then `onText` decides where it goes.
function holdToTalk(btn, onText) {
  let pressing = false, busy = false, rec = null, stream = null, chunks = [], t0 = 0, x0 = 0, y0 = 0, tick = null;
  const panel = $('#rec');
  const show = (cls, title, sub) => {
    panel.hidden = false;
    panel.className = `rec ${cls}`;
    panel.style.bottom = `${(btn.closest('footer')?.offsetHeight ?? 80) + 14}px`; // just above the bar it came from
    $('#rec-t').textContent = title;
    $('#rec-s').textContent = sub;
    btn.classList.toggle('on', cls === 'on');
    btn.classList.toggle('away', cls === 'away');
    btn.classList.toggle('busy', cls === 'busy');
  };
  const reset = () => {
    clearInterval(tick);
    stream?.getTracks().forEach(t => t.stop());
    stream = rec = null;
    panel.hidden = true;
    btn.classList.remove('on', 'away', 'busy');
  };
  const clock = () => { const s = Math.floor((Date.now() - t0) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

  btn.addEventListener('contextmenu', e => e.preventDefault());
  btn.addEventListener('pointerdown', async e => {
    e.preventDefault();
    if (pressing || busy || rec) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast('This browser cannot record audio.');
    pressing = true;
    x0 = e.clientX; y0 = e.clientY;
    btn.setPointerCapture?.(e.pointerId);
    show('on', 'Listening…', 'Slide away to cancel');
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      pressing = false;
      reset();
      return toast('Whistle needs the microphone. Allow it in Settings › Safari › Microphone.', null, 5000);
    }
    if (!pressing) return reset(); // let go while the permission prompt was up
    const type = recordingType(t => MediaRecorder.isTypeSupported(t));
    rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    chunks = [];
    rec.ondataavailable = ev => { if (ev.data.size) chunks.push(ev.data); };
    rec.start();
    t0 = Date.now();
    navigator.vibrate?.(10);
    tick = setInterval(() => { if (btn.classList.contains('on')) $('#rec-t').textContent = `Listening… ${clock()}`; }, 250);
  });
  btn.addEventListener('pointermove', e => {
    if (!pressing || !rec) return;
    const away = Math.hypot(e.clientX - x0, e.clientY - y0) > CANCEL_PX;
    if (away !== btn.classList.contains('away')) show(away ? 'away' : 'on', away ? 'Let go to cancel' : `Listening… ${clock()}`, away ? 'Slide back to keep it' : 'Slide away to cancel');
  });
  const release = e => {
    if (!pressing) return;
    pressing = false;
    if (!rec) return; // still waiting on the microphone; reset happens there
    const r = rec;
    const outcome = e.type === 'pointercancel' ? 'cancel' : releaseOutcome({ ms: Date.now() - t0, dx: e.clientX - x0, dy: e.clientY - y0 });
    clearInterval(tick);
    r.onstop = async () => {
      const blob = new Blob(chunks, { type: r.mimeType || 'audio/mp4' });
      reset();
      if (outcome === 'short') return toast('Hold the mic while you talk.');
      if (outcome === 'cancel') return;
      busy = true;
      show('busy', 'Transcribing…', 'One moment');
      try {
        const res = await fetch('/api/transcribe', { method: 'POST', headers: { 'content-type': blob.type }, body: blob });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
        reset();
        if (!data.text) toast("Didn't catch that. Try again a little closer.");
        else await onText(data.text);
      } catch (err) {
        reset();
        toast(`Not transcribed: ${err.message}`, null, 5000);
      } finally { busy = false; }
    };
    r.stop();
  };
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointercancel', release);
}

// On the home screen: Haiku picks the space, folder or repo; the card confirms it.
holdToTalk($('#home-mic'), text => routeSheet(text));
// In a space: what you said starts a new agent there.
holdToTalk($('#sp-mic'), text => startAgent(state.spaceId, '', text).catch(() => {}));
// In an agent: it goes in the composer after anything typed, and sends (or queues).
holdToTalk($('#mic'), text => {
  draft.value = spokenDraft(draft.value, text);
  grow(draft);
  $('#composer').requestSubmit();
});

setInterval(() => { if (!state.openId) render(); }, 30_000); // keep "5m ago" fresh
connect();
route();
loadPrefs();
loadMarks();
pullToRefresh($('#herd-scroll'));
pullToRefresh($('#sp-scroll'));
pullToRefresh($('#s-scroll'));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (updatePending && safeToReload()) return location.reload();
  if (es?.readyState === EventSource.CLOSED) connect(); // iOS can kill the stream while suspended
  loadPrefs();
  loadMarks();
});
