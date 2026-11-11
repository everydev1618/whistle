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

// Some menus (like Claude's "trust this folder?" at startup) have no numbers,
// just a ❯ cursor, and are answered by moving it with arrows and pressing Enter.
//
//  Accessing workspace:
//  /Users/me/Code/new-project
//  …
//  ❯ No, exit
//    Yes, I trust this folder
//
//  Enter to confirm · Esc to cancel

const FOOTER = /Enter to (?:select|confirm)/;
const OPTION = /^\s*(?:❯\s*)?(\d+)\.\s+(.+?)\s*$/;
const HEADER = /^\s*(?:←\s*)?[☐☒✔]\s+(.+?)\s*(?:☐|✔|→|$)/;
const BUILTIN = /^(Type something\.?|Chat about this)$/;

export function parseQuestionScreen(text) {
  const lines = (text || '').split('\n');
  const footer = lines.findLastIndex(l => FOOTER.test(l));
  if (footer < 0) return null;
  const headerAt = lines.slice(0, footer).findLastIndex(l => HEADER.test(l));
  if (headerAt < 0) return arrowMenu(lines, footer);

  const header = lines[headerAt].match(HEADER)[1].trim();
  const question = [];
  const options = [];
  let i = headerAt + 1;
  for (; i < footer && !OPTION.test(lines[i]); i++) if (lines[i].trim()) question.push(lines[i].trim());
  for (; i < footer; i++) {
    const m = lines[i].match(OPTION);
    if (m) { options.push({ n: Number(m[1]), label: m[2], description: '', keys: [m[1]] }); continue; }
    const line = lines[i].trim();
    if (!line || /^─+$/.test(line) || !options.length) continue;
    const last = options.at(-1);
    last.description = last.description ? `${last.description} ${line}` : line;
  }
  const real = options.filter(o => !BUILTIN.test(o.label));
  if (!real.length) return null;
  return { header, question: question.join(' '), options: real };
}

function arrowMenu(lines, footer) {
  let end = footer - 1;
  while (end >= 0 && !lines[end].trim()) end--;
  let start = end;
  while (start > 0 && lines[start - 1].trim() && !/^\s*─+\s*$/.test(lines[start - 1])) start--;
  const block = lines.slice(start, end + 1);
  const cursor = block.findIndex(l => /^\s*❯\s/.test(l));
  if (cursor < 0 || block.length < 2) return null;
  const labels = block.map(l => l.replace(/^\s*❯?\s*/, '').trim());
  const options = labels.map((label, i) => {
    const moves = Array(Math.abs(i - cursor)).fill(i > cursor ? 'down' : 'up');
    return { n: i + 1, label, description: '', keys: [...moves, 'enter'] };
  });

  // What's asked: everything between the last rule above and the options.
  let top = start - 1;
  while (top >= 0 && !/^\s*─+\s*$/.test(lines[top])) top--;
  const text = lines.slice(top + 1, start).map(l => l.trim()).filter(Boolean).filter(l => l !== 'Security guide');

  if (labels.some(l => /trust this folder/i.test(l))) {
    let folder = text.find(l => /^[/~]/.test(l));
    if (folder?.length > 40) folder = `…/${folder.split('/').slice(-2).join('/')}`;
    return { header: 'Trust this folder?', question: [folder, 'Claude Code will be able to read, edit, and execute files here.'].filter(Boolean).join(' · '), arrows: true, options };
  }
  return { header: (text[0] || 'Choose').replace(/:$/, ''), question: text.slice(1).join(' '), arrows: true, options };
}
