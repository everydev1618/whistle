// Hold-to-talk decisions, kept pure so node can test them. The recording itself is in app.js.

// iPhone Safari records AAC in mp4; Chrome records Opus in webm.
const TYPES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
export const recordingType = supported => TYPES.find(t => supported(t)) || '';

export const MIN_MS = 400;     // shorter than this is a tap, not a message
export const CANCEL_PX = 80;   // slide this far off the button to throw it away

export function releaseOutcome({ ms, dx, dy }) {
  if (Math.hypot(dx, dy) > CANCEL_PX) return 'cancel';
  return ms < MIN_MS ? 'short' : 'send';
}

export function spokenDraft(typed, spoken) {
  if (!typed.trim()) return spoken;
  return /\s$/.test(typed) ? typed + spoken : `${typed} ${spoken}`;
}

// The card that says where something said on the home screen will go.
export function routeTitle(r) {
  switch (r.kind) {
    case 'space': return `New agent in ${r.where}`;
    case 'folder': return `New space in ~/Code/${r.where}`;
    case 'init': return `New repo ~/Code/${r.where}`;
    case 'clone': return `Clone ${r.where}`;
    default: return 'Where should this go?';
  }
}

// Picking the wrong space costs nothing; making folders on the Mac waits for a tap.
export const autoGo = r => r.kind === 'space' || r.kind === 'folder';
export const AUTO_GO_MS = 3000;
