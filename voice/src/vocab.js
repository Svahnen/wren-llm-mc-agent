// Second-pass helpers: word-level agreement between the streaming decoder and Parakeet, and a vocabulary fix-up (names, Wren, Minecraft terms)
// by phonetic key + edit distance. Pure functions, no I/O. Fix-ups are conservative: a COMMON English word ("run", "when") only becomes Wren in a
// vocative position or when the two decoders disagree about it; otherwise it is reported as uncertain, never silently rewritten.
export const norm = (t) => String(t || '').toLowerCase().replace(/[’`]/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
export const words = (t) => { const n = norm(t); return n ? n.split(' ') : []; };

export function lev(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[n];
}
// Small metaphone-like key: enough to equate wren/ren/rin/wrenn, steve/stev, creeper/creaper.
export function phon(w) {
  let s = String(w || '').toLowerCase().replace(/[^a-z]/g, ''); if (!s) return '';
  s = s.replace(/^(wr|rh)/, 'r').replace(/^kn/, 'n').replace(/^wh/, 'w').replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k').replace(/q/g, 'k').replace(/x/g, 'ks').replace(/z/g, 's').replace(/dg/g, 'j').replace(/(.)\1+/g, '$1');
  return s[0] + s.slice(1).replace(/[aeiouyhw]/g, '');
}
// word-level alignment: ops 'ok' | 'sub' | 'ins' (word only in b) | 'del' (word only in a)
export function align(a, b) {
  const m = a.length, n = b.length, d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i; for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  const ops = []; let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)) { ops.push({ op: a[i - 1] === b[j - 1] ? 'ok' : 'sub', a: a[i - 1], b: b[j - 1], ai: i - 1, bi: j - 1 }); i--; j--; }
    else if (i > 0 && d[i][j] === d[i - 1][j] + 1) { ops.push({ op: 'del', a: a[i - 1], ai: i - 1 }); i--; }
    else { ops.push({ op: 'ins', b: b[j - 1], bi: j - 1 }); j--; }
  }
  return ops.reverse();
}
export const wer = (ref, hyp) => { const r = words(ref), h = words(hyp); if (!r.length) return h.length ? 1 : 0; return lev2(r, h) / r.length; };
const lev2 = (a, b) => align(a, b).filter((o) => o.op !== 'ok').length;
const FUNC = new Set('a an the and or but so of to in on at is are was i it you he she we they this that these those uh um oh'.split(' '));

/** Agreement of two decoders over the same utterance. -> {agreement 0..1, subs[{final, stream, bi}], missing_in_stream[], extra_in_stream[]} */
export function agree(streamText, finalText) {
  const s = words(streamText), f = words(finalText);
  if (!f.length && !s.length) return { agreement: 1, subs: [], missing_in_stream: [], extra_in_stream: [] };
  const ops = align(s, f), bad = ops.filter((o) => o.op !== 'ok').length;
  return { agreement: +Math.max(0, 1 - bad / Math.max(s.length, f.length, 1)).toFixed(3),
    subs: ops.filter((o) => o.op === 'sub').map((o) => ({ final: o.b, stream: o.a, bi: o.bi })),
    missing_in_stream: ops.filter((o) => o.op === 'ins').map((o) => o.b), extra_in_stream: ops.filter((o) => o.op === 'del').map((o) => o.a) };
}

// ---------------------------------------------------------------- vocabulary
export const WREN_STRONG = new Set(['ren', 'wrenn', 'wran', 'rhen', 'wrin', 'rin', 'rinn', 'renn', 'wrem', 'rennn', 'wrenne']);    // not English words: always Wren
export const WREN_COMMON = new Set(['run', 'ran', 'rain', 'rent', 'when', 'wrench', 'rend', 'win', 'then', 'rang', 'ring', 'wren']);   // English words: only vocative / on disagreement
const GREET = new Set('hey hi hello yo oh ok okay hiya heya thanks thank bye sorry please cheers'.split(' '));
const AFTER_VOC = new Set('can could will would do did are is what where how why please come look help follow stop wait show tell give let listen hold you'.split(' '));
export const TERMS = ['creeper', 'zombie', 'skeleton', 'spider', 'enderman', 'lava', 'pickaxe', 'diamond', 'village', 'bed', 'villager', 'pillager', 'cobblestone', 'redstone', 'obsidian', 'nether', 'furnace', 'torch', 'sword', 'shovel', 'chest', 'iron', 'coal', 'portal', 'witch', 'phantom', 'netherite', 'crafting table', 'sugar cane', 'zombies', 'creepers', 'skeletons', 'spiders', 'diamonds'];
const TERM_TABLE = { 'pick axe': 'pickaxe', 'pic axe': 'pickaxe', 'pickax': 'pickaxe', 'pig axe': 'pickaxe', 'pick ax': 'pickaxe', 'ender man': 'enderman', 'end of man': 'enderman', 'end a man': 'enderman', 'and a man': 'enderman', 'cobble stone': 'cobblestone', 'red stone': 'redstone', 'creaper': 'creeper', 'creepers': 'creepers', 'zombi': 'zombie', 'skelton': 'skeleton', 'spyder': 'spider', 'villege': 'village', 'vilage': 'village', 'diamant': 'diamond', 'dimond': 'diamond', 'larva': 'lava', 'lover': 'lava', 'bad': null };
const COMMON = new Set(`the be to of and a in that have i it for not on with he as you do at this but his by from they we say her she or an will my one all would there their what so up out if about who get which go me when make can like time no just him know take people into year your good some could them see other than then now look only come its over think also back after use two how our work first well way even new want because any these give day most us is are was were been has had did does said each tell very where much through those both too off right still such here more many must name should never same last long great little own old big high small large next early young important few public bad able free hand part place case week company system program question government number night point home water room mother area money story fact month lot study book eye job word business issue side kind head house service friend father power hour game line end member law car city community name president team minute idea kid body information back parent face others level office door health person art war history party result change morning reason research girl guy moment air teacher force education foot boy age policy music market sense nation plan college interest death experience effect use class control care field development role effort rate heart drug show leader light voice wife police mind price report decision son view relationship town road arm difference value building action model season society tax director position player record paper space ground form event official matter center couple site project activity star table need court oil situation cost industry figure street image phone data picture practice piece land product doctor wall patient worker news test movie north love support technology step baby computer type attention film tree source organization hair window culture chance brother energy period course summer plant opportunity term letter condition choice rule daughter east ground block food farm river tree stone wood sand cave mountain sky sun moon dark night sheep cow pig chicken horse dog cat wolf fish boat axe pick bow arrow shield armor armour apple bread meat steak carrot potato wheat seed seeds gold iron coal stick sticks plank planks log logs door fence gate glass wool bucket bottle book map clock compass sign chest barrel box bed pillow roof floor stairs ladder bridge tunnel mine shaft base house hole pit pool lake sea ocean island beach hill valley forest jungle desert swamp plains snow ice rain thunder storm fire flame smoke`.split(/\s+/));
export const isCommon = (w) => COMMON.has(w) || FUNC.has(w);
const cap = (s) => s.replace(/(^|\s)([a-z])/g, (m, a, b) => a + b.toUpperCase());
const tokenize = (t) => String(t || '').match(/[A-Za-z’']+|[^A-Za-z’']+/g) || [];

function fuzzyMatch(lw, list) {      // -> {canon, how} | null ; list: [{canon, key}]
  if (lw.length < 4) return null; const k = phon(lw); let best = null;
  for (const e of list) {
    const lc = e.canon.toLowerCase(); if (Math.abs(lc.length - lw.length) > 2 || e.canon.includes(' ')) continue;
    const d = lev(lw, lc), lim = lw.length >= 8 ? 2 : 1;
    if (d === 0) return { canon: e.canon, how: 'exact', d: 0 };
    const ok = d <= lim || (k === e.key && k.length >= 3 && d <= 2);
    if (ok && (!best || d < best.d)) best = { canon: e.canon, how: k === e.key ? 'phonetic' : 'edit', d };
  }
  return best;
}

/**
 * fixup(finalText, {streamText, names[], botName, hasStream}) -> {text, corrected, changes[], uncertain[]}
 * names = player names currently near (from the mod's players list). uncertain[] = {word, candidates[], why}.
 */
export function fixup(finalText, { streamText = '', names = [], botName = 'Wren' } = {}) {
  const toks = tokenize(finalText), W = []; toks.forEach((t, i) => { if (/^[A-Za-z’']+$/.test(t)) W.push({ i, w: t, lw: t.toLowerCase().replace(/’/g, "'") }); });
  const ag = agree(streamText, finalText), subAt = new Map(ag.subs.map((s) => [s.final, s]));          // by final word (first match is enough)
  const hasStream = !!norm(streamText);
  const people = [...new Set([...names.filter(Boolean)])].filter((n) => n.length >= 4);
  const nameList = people.map((n) => ({ canon: n, key: phon(n) })), termList = TERMS.map((t) => ({ canon: t, key: phon(t) }));
  const changes = [], uncertain = [], seenU = new Set();
  const bot = botName, botLc = bot.toLowerCase();
  const addU = (word, candidates, why) => { if (!seenU.has(word)) { seenU.add(word); uncertain.push({ word, candidates, why }); } };
  const streamW = new Set(words(streamText));
  for (let k = 0; k < W.length; k++) {
    const { i, w, lw } = W[k], prev = W[k - 1]?.lw, next = W[k + 1]?.lw;
    const before = toks.slice(0, i).join(''), after = toks.slice(i + 1).join('');
    const atStart = k === 0, commaAfter = /^\s*[,?!.]/.test(after), atEnd = !W[k + 1] || /^\s*[.?!]\s*$/.test(after);
    const disagree = hasStream && !streamW.has(lw);          // the streaming decoder did not hear this word
    const streamHasWren = streamW.has(botLc) || [...streamW].some((x) => WREN_STRONG.has(x));
    const rep = (to, why) => { if (to !== w) { changes.push({ from: w, to, why }); toks[i] = to; } };
    if (lw === botLc) { rep(bot, 'case'); changes.length && changes.at(-1).why === 'case' && changes.pop(); continue; }
    if (WREN_STRONG.has(lw)) { rep(bot, 'name_variant'); continue; }
    if (WREN_COMMON.has(lw)) {
      const voc = (prev && GREET.has(prev)) || (atStart && (commaAfter || AFTER_VOC.has(next || ''))) || (/,\s*$/.test(before) && atEnd);
      if (voc && !(lw === 'run' && atStart && !prev && !commaAfter && next !== 'can' && next !== 'could' && next !== 'will')) rep(bot, 'vocative');
      else if (streamHasWren && disagree) rep(bot, 'decoders_disagree');
      else if (disagree && !isCommon(lw) === false && (subAt.get(lw)?.stream || '').length) addU(w, [bot], 'could be the name ' + bot);
      continue;
    }
    if (lw.length >= 4 && !isCommon(lw) || TERM_TABLE[lw] !== undefined) {
      const near = fuzzyMatch(lw, nameList);
      if (near && near.how !== 'exact' && !(isCommon(lw))) { if (disagree || !hasStream || near.how === 'phonetic') rep(near.canon, 'near_name_' + near.how); else addU(w, [near.canon], 'close to player name'); continue; }
      if (near?.how === 'exact') { rep(near.canon, 'case'); changes.length && changes.at(-1).why === 'case' && changes.pop(); continue; }
      const tt = TERM_TABLE[lw]; if (tt) { rep(tt, 'term_table'); continue; }
      const term = isCommon(lw) ? null : fuzzyMatch(lw, termList);
      if (term && term.how !== 'exact') { if (disagree || !hasStream) rep(term.canon, 'term_' + term.how); else addU(w, [term.canon], 'close to Minecraft term'); continue; }
    }
  }
  // bigrams for compound terms ("pick axe", "ender man", "red stone")
  let text = toks.join(''), t2 = text;
  for (const [from, to] of Object.entries(TERM_TABLE)) { if (!to || !from.includes(' ')) continue; const rx = new RegExp(`\\b${from.replace(' ', '\\s+')}\\b`, 'gi'); t2 = t2.replace(rx, (m) => { changes.push({ from: m, to, why: 'term_table' }); return to; }); }
  text = t2;
  const inPhrase = new Set(changes.filter((c) => c.from.includes(' ')).flatMap((c) => c.from.toLowerCase().split(/\s+/)));
  // everything the decoders disagree about and we did not settle is uncertain; unknown capitalised mid-sentence words too
  const changed = new Set(changes.map((c) => c.from.toLowerCase())), known = new Set([...people.map((n) => n.toLowerCase()), botLc]);
  for (const s of ag.subs) { if (FUNC.has(s.final) && FUNC.has(s.stream)) continue; if (changed.has(s.final) || known.has(s.final) || inPhrase.has(s.final)) continue; addU(s.final, [s.stream], 'decoders disagree'); }
  for (const m of text.matchAll(/(?<=[a-z,;]\s)([A-Z][a-z]{2,})\b/g)) { const lw = m[1].toLowerCase(); if (!known.has(lw) && !isCommon(lw) && !TERMS.includes(lw)) addU(m[1], [], 'unknown proper noun'); }
  return { text, corrected: changes.some((c) => c.why !== 'case'), changes, uncertain: uncertain.slice(0, 8) };
}

/** Combine the two decoders into the heard fields. */
export function mergeHeard({ stream, final, names, botName }) {
  const hasFinal = !!final?.trim();
  const base = hasFinal ? final.trim() : (stream || '').trim();
  const ag = hasFinal ? agree(stream, final) : { agreement: stream ? 0.5 : 0, subs: [] };
  if (hasFinal && !norm(stream)) ag.agreement = 0.5;          // streaming pass heard nothing: nothing to confirm with
  const fx = fixup(base, { streamText: hasFinal ? stream : '', names, botName });
  const alts = []; const push = (t, src) => { t = (t || '').trim(); if (t && !alts.some((a) => norm(a.text) === norm(t)) && norm(t) !== norm(fx.text)) alts.push({ text: t, src }); };
  if (hasFinal) { push(final, 'parakeet'); push(stream, 'stream'); } else push(stream, 'stream');
  return { text: fx.text, text_final: hasFinal ? final.trim() : null, text_stream: (stream || '').trim(), alternatives: alts, confidence: +ag.agreement.toFixed(2), agreement: ag.agreement,
    uncertain_words: fx.uncertain.map((u) => u.word), uncertain: fx.uncertain, corrected: fx.corrected, changes: fx.changes, second_pass: hasFinal };
}
