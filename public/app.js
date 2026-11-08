import { mdBlocks } from './md.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const base = p => (p || '').split('/').pop();

const state = {
  agents: new Map(),
  sessions: [],
  filter: localGet('whistle.filter') || 'all',
  openId: null,
  detail: null,
  showAllTurns: false,
  sent: new Set(),     // agents we just sent to, shown dimmed until herdr reports work
  stopArmed: null,
};

function localGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }

// ---------- data ----------
async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error?.message || `HTTP ${r.status}`), { code: data.error?.code, status: r.status });
  return data;
}

function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('snapshot', e => {
    const d = JSON.parse(e.data);
    state.agents = new Map(d.agents.map(a => [a.id, a]));
    state.sessions = d.sessions;
    render();
  });
  es.addEventListener('change', e => {
    const ev = JSON.parse(e.data);
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

// ---------- actions ----------
async function act(id, chip) {
  const a = state.agents.get(id);
  try {
    if (chip.keys) await api(`/api/agents/${encodeURIComponent(id)}/keys`, { keys: chip.keys });
    else await api(`/api/agents/${encodeURIComponent(id)}/prompt`, { text: chip.text });
    state.sent.add(id);
    toast(`Sent to ${a?.project || 'agent'}: ${chip.label || chip.text}`);
    render();
  } catch (e) {
    toast(e.code === 'agent_blocked' ? 'It is waiting on a question. Answer it first.' : `Not sent: ${e.message}`);
  }
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

// ---------- herd ----------
const PILL = { blocked: 'Asking', done: 'Finished', idle: 'Finished', working: 'Working' };
const RECENT_MS = 24 * 3600 * 1000;
const when = a => (a.endedAt ? Date.parse(a.endedAt) : 0);

function ago(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function visible() {
  return [...state.agents.values()].filter(a => state.filter === 'all' || a.session === state.filter);
}

// `full` shows what a model button will actually send under its label.
function chipHtml(id, chips, { full = false } = {}) {
  return chips.map((c, i) => {
    const hint = c.hint || (full && c.text && c.text.toLowerCase() !== c.label.toLowerCase() ? c.text : '');
    return `<button class="chip${c.primary ? ' primary' : ''}${c.source === 'model' ? ' model' : ''}" data-act="${esc(id)}" data-i="${i}">${esc(c.label)}${hint ? `<small>${esc(hint)}</small>` : ''}</button>`;
  }).join('');
}

function sessionTag(a) { return a.session !== 'default' ? `<span class="tag">${esc(a.session)}</span>` : ''; }

function renderHerd() {
  const list = visible();
  // Asking: stuck until you answer. Finished: ended a turn in the last day, your move.
  // Earlier: everything quieter or older.
  const byRecent = (x, y) => when(y) - when(x);
  const recent = a => Date.now() - when(a) < RECENT_MS;
  const asking = list.filter(a => a.status === 'blocked').sort(byRecent);
  const finished = list.filter(a => (a.status === 'done' || a.status === 'idle') && recent(a)).sort(byRecent);
  const working = list.filter(a => a.status === 'working').sort(byRecent);
  const earlier = list.filter(a => !asking.includes(a) && !finished.includes(a) && !working.includes(a)).sort(byRecent);

  $('#count').textContent = [asking.length && `${asking.length} asking`, `${finished.length} finished`, `${working.length} working`].filter(Boolean).join(' · ');

  const counts = new Map();
  for (const a of state.agents.values()) counts.set(a.session, (counts.get(a.session) || 0) + 1);
  $('#sessions').innerHTML = [{ name: 'all', running: true }, ...state.sessions].map(s => {
    const n = s.name === 'all' ? state.agents.size : counts.get(s.name) || 0;
    return `<button data-filter="${esc(s.name)}" aria-pressed="${state.filter === s.name}" class="${s.running ? '' : 'down'}">${s.name === 'all' ? 'All' : esc(s.name)} · ${n}</button>`;
  }).join('');

  $('#g-asking').hidden = !asking.length;
  $('#asking').innerHTML = asking.map(card).join('');
  $('#finished').innerHTML = finished.map(card).join('') || '<p class="empty">Nothing finished in the last day.</p>';

  $('#working').innerHTML = working.map(a => `
    <article class="card" data-id="${esc(a.id)}">
      <div class="meta"><span class="pill working">Working</span>${sessionTag(a)}<span class="proj">${esc(a.project)}</span><span class="ago">${a.steps ? `${a.steps} steps` : ''}</span></div>
      <button class="open" data-open="${esc(a.id)}"><h2>${esc(a.title)}</h2></button>
      ${a.live ? `<div class="live"><span>▸</span><span>${esc(a.live)}</span></div>` : ''}
      <div class="bar"><i></i></div>
      <div class="chips"><button class="chip ${state.stopArmed === a.id ? 'warn' : 'ghost'}" data-stop="${esc(a.id)}">${state.stopArmed === a.id ? 'Tap to stop' : 'Stop'}</button></div>
    </article>`).join('');
  $('#g-working').hidden = !working.length;

  $('#earlier').innerHTML = earlier.map(a => `<button class="rest" data-open="${esc(a.id)}"><span>${esc(a.title || a.project)}</span><span class="proj">${esc(a.project)} · ${ago(a.endedAt)}</span></button>`).join('');
  $('#g-earlier').hidden = !earlier.length;
  bindSwipes();
}

function card(a) {
  const sent = state.sent.has(a.id);
  const body = a.question
    ? `<p class="q">${esc(a.question.question)}</p>`
    : a.summary ? `<p>${esc(a.summary)}</p>` : '';
  const chips = sent ? '' : chipHtml(a.id, a.suggestions.slice(0, 3));
  return `<article class="card${sent ? ' sent' : ''}" data-id="${esc(a.id)}">
    ${a.suggestions[0] && !sent ? `<div class="swipehint">${esc(a.suggestions[0].label)} ›</div>` : ''}
    <div class="meta"><span class="pill ${a.status}">${PILL[a.status] || a.status}</span>${sessionTag(a)}<span class="proj">${esc(a.project)}</span><span class="ago">${sent ? 'sent' : ago(a.endedAt)}</span></div>
    <button class="open" data-open="${esc(a.id)}"><h2>${esc(a.title)}</h2>${body}</button>
    ${chips ? `<div class="chips">${chips}</div>` : ''}
  </article>`;
}

function bindSwipes() {
  for (const card of document.querySelectorAll('#asking .card, #finished .card')) {
    const id = card.dataset.id;
    const a = state.agents.get(id);
    const top = a?.suggestions?.[0];
    if (!top || state.sent.has(id)) continue;
    const hint = $('.swipehint', card);
    let x0 = null, y0 = 0, dx = 0;
    card.addEventListener('pointerdown', e => { if (e.target.closest('.chip')) return; x0 = e.clientX; y0 = e.clientY; dx = 0; });
    card.addEventListener('pointermove', e => {
      if (x0 === null) return;
      dx = Math.max(0, e.clientX - x0);
      if (!card.classList.contains('dragging')) {
        if (Math.abs(e.clientY - y0) > 12) { x0 = null; return; } // vertical scroll wins
        if (dx < 10) return;
        card.classList.add('dragging');
        card.setPointerCapture(e.pointerId);
      }
      card.style.transform = `translateX(${dx}px)`;
      hint.style.opacity = Math.min(1, dx / 110);
      hint.style.zIndex = 0;
    });
    const end = () => {
      if (x0 === null) return;
      x0 = null;
      const dragged = card.classList.contains('dragging');
      card.classList.remove('dragging');
      if (dragged && dx > 110) {
        card.style.transform = 'translateX(110%)';
        card.style.opacity = 0;
        navigator.vibrate?.(10);
        setTimeout(() => act(id, top), 180);
      } else { card.style.transform = ''; hint.style.opacity = 0; }
      if (dragged) card.addEventListener('click', e => e.stopPropagation(), { capture: true, once: true });
    };
    card.addEventListener('pointerup', end);
    card.addEventListener('pointercancel', end);
  }
}

// ---------- session ----------
let refreshT;
function refreshDetailSoon() { clearTimeout(refreshT); refreshT = setTimeout(loadDetail, 350); }

async function loadDetail() {
  const id = state.openId;
  if (!id) return;
  try {
    const d = await api(`/api/agents/${encodeURIComponent(id)}`);
    if (state.openId !== id) return;
    state.detail = d;
    renderSession();
  } catch (e) {
    if (e.status === 404) { toast('That agent is gone.'); location.hash = ''; }
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
  $('#s-sub').textContent = `${a.project} · ${a.session}/${a.paneId}`;
  const pill = $('#s-pill');
  pill.className = `pill ${a.status}`;
  pill.textContent = PILL[a.status] || a.status;

  const scroller = $('#s-scroll');
  const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
  const t = d?.transcript;
  let html = '';
  if (!t) html = '<p class="notx">No Claude transcript found for this pane.</p>';
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
  if (a.question) {
    html += `<div class="ask"><div class="ctx">Waiting on you · ${esc(a.question.header)}</div><div class="qq">${esc(a.question.question)}</div>
      ${a.question.options.map(o => `<button data-key="${o.n}"><b>${esc(o.label)}</b>${o.description ? `<span>${esc(o.description)}</span>` : ''}</button>`).join('')}</div>`;
  }
  $('#s-body').innerHTML = html;

  const chips = a.question ? [] : [...a.suggestions];
  let dock = chipHtml(a.id, chips, { full: true });
  if (a.status === 'working') dock += `<button class="chip ${state.stopArmed === a.id ? 'warn' : 'ghost'}" data-stop="${esc(a.id)}">${state.stopArmed === a.id ? 'Tap to stop' : 'Stop'}</button>`;
  if (a.status === 'blocked') dock += `<button class="chip ghost" data-esc="${esc(a.id)}">Dismiss (Esc)</button>`;
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
  document.querySelectorAll('.sheet, .scrim').forEach(n => n.remove());
  document.querySelectorAll('.answer .sel').forEach(n => n.classList.remove('sel'));
}

function grow(t) { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 140) + 'px'; }

// ---------- routing ----------
function route() {
  const m = location.hash.match(/^#a=(.+)$/);
  const id = m ? decodeURIComponent(m[1]) : null;
  closeSheet();
  if (id !== state.openId) { state.detail = null; state.showAllTurns = false; delete $('#s-scroll').dataset.seen; $('#s-body').innerHTML = ''; }
  state.openId = id;
  $('#herd').hidden = !!id;
  $('#session').hidden = !id;
  if (id) { renderSession(); loadDetail(); } else renderHerd();
}

function render() { if (state.openId) renderSession(); else renderHerd(); }

let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.hidden = true; }, 2600);
}

// ---------- events ----------
// Long-press a reply button to put its text in the composer instead of sending it.
let pressT = null, pressed = false, px = 0, py = 0;
document.addEventListener('pointermove', e => { if (Math.hypot(e.clientX - px, e.clientY - py) > 10) clearTimeout(pressT); });
document.addEventListener('pointerdown', e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  pressed = false;
  px = e.clientX; py = e.clientY;
  clearTimeout(pressT);
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
document.addEventListener('contextmenu', e => { if (e.target.closest('[data-act]')) e.preventDefault(); });

document.addEventListener('click', e => {
  if (pressed && e.target.closest('[data-act]')) { pressed = false; return; }
  const el = e.target.closest('[data-act],[data-open],[data-filter],[data-stop],[data-esc],[data-key],[data-strip],[data-earlier],.answer > *');
  if (!el) return;
  if (el.dataset.act) {
    const a = state.agents.get(el.dataset.act);
    const chip = a?.suggestions?.[Number(el.dataset.i)];
    if (chip) act(a.id, chip);
  } else if (el.dataset.open) location.hash = `a=${encodeURIComponent(el.dataset.open)}`;
  else if (el.dataset.filter) { state.filter = el.dataset.filter; localSet('whistle.filter', state.filter); renderHerd(); }
  else if (el.dataset.stop) stop(el.dataset.stop);
  else if (el.dataset.esc) act(el.dataset.esc, { keys: ['esc'], label: 'Esc' });
  else if (el.dataset.key) act(state.openId, { keys: [el.dataset.key], label: el.querySelector('b')?.textContent });
  else if (el.dataset.strip !== undefined) {
    const ol = el.nextElementSibling;
    ol.hidden = !ol.hidden;
    el.setAttribute('aria-expanded', String(!ol.hidden));
  } else if (el.dataset.earlier !== undefined) { state.showAllTurns = true; renderSession(); }
  else if (el.closest('.answer') && !e.target.closest('a')) openSheet(el);
});

$('#back').onclick = () => { location.hash = ''; };
window.addEventListener('hashchange', route);

const draft = $('#draft');
draft.addEventListener('input', () => grow(draft));
draft.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); } });
$('#composer').addEventListener('submit', async e => {
  e.preventDefault();
  const text = draft.value.trim();
  if (!text || !state.openId) return;
  const before = draft.value;
  draft.value = '';
  grow(draft);
  try {
    await api(`/api/agents/${encodeURIComponent(state.openId)}/prompt`, { text });
    state.sent.add(state.openId);
    toast('Sent');
  } catch (err) {
    draft.value = before;
    grow(draft);
    toast(err.code === 'agent_blocked' ? 'It is waiting on a question. Answer it first.' : `Not sent: ${err.message}`);
  }
});

setInterval(() => { if (!state.openId) renderHerd(); }, 30_000); // keep "5m ago" fresh
connect();
route();
