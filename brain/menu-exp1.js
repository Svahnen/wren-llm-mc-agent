// EXP1: menu entry for resource_expedition (kept apart from menu.js). Pure function of the digest; returns { ok:[{score,text}], no:["name (reason)"] }.
// A recent gather failure that says "no log within 64 m" is the cue: the area around home is used up, so the hint is to go further.
import { daylightInfo } from './daylight.js'
const KIND = { wood: /\b(log|wood|tree)/i, stone: /\b(stone|cobble|coal|iron|ore)/i, food: /\b(food|animal|cow|meat|fish)/i }
const FORM = /\bno [a-z_ ]{2,30} (?:blocks )?within \d+ m|no_target_found|nothing_gained|missing_planks|found_nothing/i

/** which resource does a failure line talk about (null = not a depleted-area failure) */
export function depletedResource(f) {
  const what = String(f?.what ?? ''), reason = String(f?.reason ?? '')
  const text = `${what} ${reason}`
  if (/resource_expedition/.test(what)) return null
  // BAT1: S2's failures arrive as "wanted playbook: make_tools" / "failed (no_wood). Steps: wood:failed/no_target_found [...]" (the EXP1 hint missed these: S2 started make_tools 3x in 7 min)
  if (/^(?:wanted )?playbook\b|^wanted /i.test(what) && !/resource_expedition/.test(what)) {
    if (/\bno_stone\b|stone:failed\/(?:no_target_found|could)/.test(reason)) return 'stone'
    if (/\bno_wood\b|missing_planks|missing_log|wood:failed\/(?:no_target_found|could)|log:failed\/no_target/.test(reason)) return 'wood'
    if (/could_not_gather|no_target_found/.test(reason)) { for (const k of ['wood', 'stone', 'food']) if (KIND[k].test(text)) return k }
  }
  if (/^gather_wood$|gather\(?.*wood|collect.*(wood|log)/i.test(what) && FORM.test(reason)) return 'wood'
  if (/^gather_stone$|gather\(?.*stone/i.test(what) && FORM.test(reason)) return 'stone'
  if (/^craft/i.test(what) && /missing_planks|missing_log/.test(reason)) return 'wood'
  if (/^(collect|gather|hunt|find)/i.test(what) && /\bno (?:animal|cow|food)|no_animal_nearby|no_food_found/i.test(reason)) return 'food'
  if (/^(collect|gather)/i.test(what) && FORM.test(reason)) { for (const k of ['wood', 'stone', 'food']) if (KIND[k].test(text)) return k }
  if (/could_not_gather/.test(reason) && /^(wanted|pursue|gather)/i.test(what)) { for (const k of ['wood', 'stone', 'food']) if (KIND[k].test(text)) return k; return 'any' }
  return null
}

export function expeditionMenu(dg) {
  const ok = [], no = []
  const night = dg.time?.phase === 'night' || !!dg.thunder, d = daylightInfo(dg)
  const recent = (dg.failures ?? []).filter((f) => f.ago_s == null || f.ago_s <= 1200).map((f) => ({ f, r: depletedResource(f) })).filter((x) => x.r)
  const cue = recent.at(-1)
  const res = cue?.r ?? 'any'
  const soon = !night && d && d.minToDusk < 4
  if (night) { no.push(`resource_expedition (it is night${d?.minToDawn ? `, dawn in ${d.minToDawn} min` : ''})`); return { ok, no } }
  if (soon) { no.push(`resource_expedition (not now: dusk in ${d.minToDusk} min)`); return { ok, no } }
  const place = (dg.places ?? []).find((p) => p.kind !== 'home' && p.kind !== 'bed' && (p.kind === (res === 'wood' ? 'forest' : res === 'stone' ? 'stone_area' : 'food_area') || (p.note && new RegExp(res === 'wood' ? 'forest|tree|wood' : res === 'stone' ? 'stone|rock|hill|cave' : 'cow|sheep|pig|animal|food', 'i').test(p.note))))
  const where = place ? `to your remembered ${place.id}${place.dist != null ? ` (${place.dist} m ${place.dir ?? ''})` : ''}` : 'to new ground likely to have it'
  if (cue) add(ok, 8.2, `resource_expedition resource=${res} max_dist=200: ${cue.f.what} failed (${String(cue.f.reason).slice(0, 70)}), so the ground around home is used up; walks ${where} in daylight${d ? ` (about ${d.minToDusk} min left)` : ''}, collects ${res === 'wood' ? '16 logs' : res === 'stone' ? '16 cobblestone' : 'food'}, remembers the place and returns home`)
  else add(ok, 1.3, 'resource_expedition resource=<wood|stone|food|any> max_dist=200: daylight trip to a remembered or new place for wood, stone or food, then home')
  return { ok, no }
}
const add = (ok, score, text) => ok.push({ score, text })
