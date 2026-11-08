// Reply buttons that come straight from the agent's state, no model needed.
// A button sends either `text` as a prompt or `keys` as key presses.

const OFFER = /\?\s*$/;
const PUSHED = /\b(pushed|committed|deployed)\b/i;

export function suggest({ status, question, transcript }) {
  if (status === 'working') return [];
  if (question) {
    return question.options.map((o, i) => ({ label: o.label, hint: o.description, keys: [String(o.n)], primary: i === 0 }));
  }
  const last = transcript?.turns?.at(-1);
  if (!last) return [];

  const out = [];
  const lastPara = last.answer.split(/\n\s*\n/).at(-1)?.trim() || '';
  if (OFFER.test(lastPara)) {
    out.push({ label: 'Yes', text: 'yes', primary: true }, { label: 'No', text: 'no', primary: false });
  }
  if (Object.keys(last.files).length && !PUSHED.test(last.answer)) {
    out.push({ label: 'Commit and push', text: 'commit and push', primary: !out.length });
  }
  return out;
}
