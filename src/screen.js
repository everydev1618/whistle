// Claude only writes an AskUserQuestion to its transcript after it is answered,
// so while it waits we read the question off the terminal screen.
//
//  ☐ Color
//
// Which color?
//
// ❯ 1. Red
//      Warm
//   2. Green
//      Natural
//   4. Type something.
// ─────
//   5. Chat about this
//
// Enter to select · ↑/↓ to navigate · Esc to cancel

const OPTION = /^\s*(?:❯\s*)?(\d+)\.\s+(.+?)\s*$/;
const HEADER = /^\s*(?:←\s*)?[☐☒✔]\s+(.+?)\s*(?:☐|✔|→|$)/;
const BUILTIN = /^(Type something\.?|Chat about this)$/;

export function parseQuestionScreen(text) {
  const lines = (text || '').split('\n');
  const footer = lines.findLastIndex(l => /Enter to select/.test(l));
  if (footer < 0) return null;
  const headerAt = lines.slice(0, footer).findLastIndex(l => HEADER.test(l));
  if (headerAt < 0) return null;

  const header = lines[headerAt].match(HEADER)[1].trim();
  const question = [];
  const options = [];
  let i = headerAt + 1;
  for (; i < footer && !OPTION.test(lines[i]); i++) if (lines[i].trim()) question.push(lines[i].trim());
  for (; i < footer; i++) {
    const m = lines[i].match(OPTION);
    if (m) { options.push({ n: Number(m[1]), label: m[2], description: '' }); continue; }
    const line = lines[i].trim();
    if (!line || /^─+$/.test(line) || !options.length) continue;
    const last = options.at(-1);
    last.description = last.description ? `${last.description} ${line}` : line;
  }
  const real = options.filter(o => !BUILTIN.test(o.label));
  if (!real.length) return null;
  return { header, question: question.join(' '), options: real };
}
