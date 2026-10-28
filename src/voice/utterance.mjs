export function isBackchannel(text = '', durationMs = 0) {
  const normalized = text.toLowerCase().replace(/[\s，。！？、,.!?~～]/g, '');
  return durationMs < 1900 && /^(?:(?:嗯|唔|哦|噢|对|是|好|好的|是的|没错|明白|嗯哼)+|ok|okay|yes|yeah|yep|uhhuh|mhm|mm+)$/.test(normalized);
}

export function createUtteranceGate({ onCandidate, onInterrupt, onBackchannel, minSpeechMs = 650 }) {
  let active = false;
  let startedAt = 0;
  let interrupted = false;
  let lastText = '';
  let playback = false;
  return {
    begin(now = performance.now(), isPlaying = false) {
      active = true; startedAt = now; interrupted = false; lastText = ''; playback = isPlaying;
      if (playback) onCandidate?.({ phase: 'candidate', durationMs: 0, text: '' });
    },
    transcript(text, now = performance.now()) {
      if (!active) return;
      lastText = text;
      const durationMs = now - startedAt;
      if (!interrupted && playback && durationMs >= minSpeechMs && text.trim() && !isBackchannel(text, durationMs)) {
        interrupted = true;
        onInterrupt?.({ phase: 'interrupt', durationMs, text });
      }
    },
    tick(now = performance.now()) {
      if (!active || interrupted || !playback || now - startedAt < 1900) return;
      interrupted = true;
      onInterrupt?.({ phase: 'interrupt', durationMs: now - startedAt, text: lastText });
    },
    end(now = performance.now(), text = lastText) {
      if (!active) return { text: '', backchannel: false, interrupted: false, durationMs: 0 };
      active = false;
      const durationMs = now - startedAt;
      const backchannel = playback && isBackchannel(text, durationMs);
      if (backchannel) onBackchannel?.({ text, durationMs });
      else if (playback && text.trim() && !interrupted) {
        interrupted = true;
        onInterrupt?.({ phase: 'interrupt', text, durationMs });
      }
      return { text: backchannel ? '' : text, backchannel, interrupted, durationMs };
    },
    cancel() { active = false; lastText = ''; },
    get active() { return active; },
  };
}
