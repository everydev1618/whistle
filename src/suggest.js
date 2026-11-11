// Reply buttons that come straight from the agent's state, no model needed,
// worded the way the user words things (see vocab.js).
// A button sends either `text` as a prompt or `keys` as key presses.
import { DEFAULT_VOCAB } from './vocab.js';

const PUSHED = /\b(pushed|committed)\b/i;
const DEPLOYED = /\b(deployed|shipped|live at)\b/i;
const OFFER = /^(?:(?:so|ok|okay),?\s+)?(?:do you want me to|want me to|would you like me to|should i|shall i)\s+(?:also\s+)?(.+?)(?:\s+(?:too|as well))?\?$/i;
const MAX_WORDS = 6;
const MAX = 4;

const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const words = s => s.split(/\s+/).length;
const norm = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

function offerButtons(answer) {
  const lastPara = answer.split(/\n\s*\n/).at(-1)?.trim() || '';
  if (!/\?\s*$/.test(lastPara)) return [];
  const sentence = lastPara.split(/(?<=[.!?])\s+/).at(-1).trim();
  const offer = sentence.match(OFFER)?.[1];
  if (offer) {
    const choices = offer.split(/,?\s+or\s+/);
    if (choices.length === 2 && choices.every(c => words(c) <= MAX_WORDS)) {
      return choices.map(c => ({ label: clip(cap(c), 30), text: c.toLowerCase() }));
    }
    if (words(offer) <= MAX_WORDS) return [{ label: clip(`Yes, ${offer}`, 30), text: `yes ${offer}` }, { label: 'No', text: 'no' }];
  }
  return [{ label: 'Yes', text: 'yes' }, { label: 'No', text: 'no' }];
}

export function suggest({ status, question, transcript, cwd, vocab = DEFAULT_VOCAB }) {
  if (status === 'working') return [];
  if (question) {
    // Arrow menus get no default: the first choice there is often "No, exit".
    return question.options.map((o, i) => ({ label: o.label, hint: o.description, keys: o.keys ?? [String(o.n)], primary: i === 0 && !question.arrows }));
  }
  const last = transcript?.turns?.at(-1);
  if (!last) return [];

  const out = offerButtons(last.answer);
  if (Object.keys(last.files).length) {
    const deploy = vocab.deployByProject?.[cwd];
    if (!PUSHED.test(last.answer) && !DEPLOYED.test(last.answer)) out.push({ label: cap(vocab.push), text: vocab.push });
    else if (deploy && !DEPLOYED.test(last.answer)) out.push({ label: cap(deploy), text: deploy });
  }
  return out.map((b, i) => ({ ...b, primary: i === 0 }));
}

// Rule buttons first, then the model's, without repeats.
export function mergeSuggestions(rules, model = []) {
  const seen = new Set(rules.map(r => norm(r.text || r.label)));
  const out = [...rules];
  for (const m of model) {
    if (out.length >= MAX) break;
    const k = norm(m.text);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ label: m.label, text: m.text, primary: out.length === 0, source: 'model' });
  }
  return out;
}
