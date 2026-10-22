// Split text into speakable units. First unit is an early short clause (<= firstClauseWords) so TTS starts sooner.
export function splitSentences(text, { firstClauseWords = 8 } = {}) {
  const clean = String(text || '').replace(/[*_~`#<>\[\]{}|]/g, '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const parts = clean.match(/[^.!?…]+(?:[.!?…]+["')\]]*|$)/g)?.map((s) => s.trim()).filter((s) => /[a-z0-9]/i.test(s)) || [clean];
  // early first clause: cut the first sentence at its first comma/semicolon/dash once >= 3 words are before it, if >= 4 words remain after
  if (parts.length) {
    const w = parts[0].split(' ');
    for (let i = 2; i < Math.min(w.length - 4, firstClauseWords); i++) {
      if (/[,;:—–]$/.test(w[i])) { parts.splice(0, 1, w.slice(0, i + 1).join(' '), w.slice(i + 1).join(' ')); break; }
    }
  }
  return parts;
}
