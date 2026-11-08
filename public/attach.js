// Screenshots go up first, then the prompt names their paths on the Mac so the agent reads them.
export function withImages(text, paths) {
  if (!paths.length) return text;
  const lead = text.trim() || (paths.length > 1 ? 'Look at these screenshots.' : 'Look at this screenshot.');
  return `${lead}\n\n${paths.map(p => `[Image: ${p}]`).join('\n')}`;
}
