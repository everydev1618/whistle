// Just enough markdown for Claude's answers. Each block is tappable on its own,
// so this returns blocks rather than one HTML string.
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => (/^https?:\/\//.test(u) ? `<a href="${u}" target="_blank" rel="noopener">${t}</a>` : t));
}

const plain = s => s.replace(/\*\*|`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

export function mdBlocks(text) {
  const out = [];
  const lines = (text || '').split('\n');
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.startsWith('```')) {
      const body = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) body.push(lines[i]);
      i++;
      out.push({ tag: 'pre', html: esc(body.join('\n')), text: body.join('\n') });
      continue;
    }
    const h = line.match(/^#{1,6}\s+(.*)/);
    if (h) { out.push({ tag: 'h3', html: inline(h[1]), text: plain(h[1]) }); i++; continue; }
    const listRe = /^\s*([-*]|\d+[.)])\s+(.*)/;
    if (listRe.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items = [];
      for (; i < lines.length && listRe.test(lines[i]); i++) items.push(lines[i].match(listRe)[2]);
      out.push({ tag: ordered ? 'ol' : 'ul', html: items.map(t => `<li>${inline(t)}</li>`).join(''), text: items.map(plain).join('\n') });
      continue;
    }
    const para = [];
    for (; i < lines.length && lines[i].trim() && !lines[i].startsWith('```') && !listRe.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]); i++) para.push(lines[i].trim());
    out.push({ tag: 'p', html: inline(para.join(' ')), text: plain(para.join(' ')) });
  }
  return out;
}
