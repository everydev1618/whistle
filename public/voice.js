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
