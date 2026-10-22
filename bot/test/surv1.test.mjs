// SURV1: screen messages sense, risky food eaten when the body needs it, eat-to-regen, dig_in availability, memory ages.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createScreen, renderComponent, EN } from '../src/screen.js'
import { edibles, needsBadFood } from '../src/skills/survival.js'
import { CATALOG } from '../src/habits/catalog.js'
import { OPTIONS, ACHIEVED } from '../src/s1/goals.js'
import { hpShown } from '../src/mindlink/digest.js'
import { agoText, recency } from '../../mind/digest.js'

test('screen: vanilla 1.21.1 translation keys render to English', () => {
  const want = { 'block.minecraft.bed.no_sleep': /sleep only at night or during thunderstorms/, 'block.minecraft.bed.not_safe': /monsters nearby/, 'block.minecraft.bed.obstructed': /obstructed/,
    'block.minecraft.bed.too_far_away': /too far away/, 'block.minecraft.spawn.not_valid': /no home bed or charged respawn anchor/, 'block.minecraft.bed.occupied': /occupied/ }
  for (const [k, re] of Object.entries(want)) assert.match(renderComponent({ translate: k }), re, k)
  assert.equal(renderComponent({ translate: 'sleep.players_sleeping', with: [1, 3] }), '1/3 players sleeping')
  assert.equal(renderComponent({ text: '', extra: [{ text: 'a ' }, { translate: 'block.minecraft.bed.obstructed' }] }), 'a This bed is obstructed')
  assert.ok(Object.keys(EN).length >= 10)
})
test('screen: dedupe within seconds, noise/chat/own lines skipped, age + near() for failures', () => {
  let t = 1000; const seen = []
  const s = createScreen({ now: () => t, onMessage: (e) => seen.push(e.text) })
  assert.ok(s.add('You can sleep only at night or during thunderstorms', { position: 'game_info', key: 'block.minecraft.bed.no_sleep' }))
  t += 1500; assert.equal(s.add('You can sleep only at night or during thunderstorms'), null, 'repeat within 4 s')
  assert.equal(s.add('<Sam> hi', { position: 'chat' }), null)
  assert.equal(s.add('Sam joined the game', { key: 'multiplayer.player.joined' }), null)
  assert.equal(s.add('<Wren> hello', { position: 'system', self: 'Wren' }), null)
  t += 6000; assert.ok(s.add('You can sleep only at night or during thunderstorms'), 'later repeat counts again')
  assert.equal(seen.length, 2)
  assert.deepEqual(s.recent(120, 3), [{ text: 'You can sleep only at night or during thunderstorms', ago_s: 0 }])
  assert.match(s.near(t - 500).text, /sleep only/); assert.equal(s.near(t - 60000), null)
})
test('screen: attach() listens to bot "message" (not chat) and title packets', () => {
  const handlers = {}
  const bot = { username: 'Wren', registry: {}, on: (e, f) => { handlers[e] = f }, off() {}, _client: { on: (e, f) => { handlers[e] = f }, off() {} } }
  const s = createScreen(); s.attach(bot)
  handlers.message({ json: { translate: 'block.minecraft.bed.not_safe' }, toString() { return 'block.minecraft.bed.not_safe' } }, 'game_info')
  handlers.message({ json: { text: 'hi' }, toString() { return 'hi' } }, 'chat')
  handlers.set_title_text({ text: JSON.stringify({ text: 'Day 2' }) })
  assert.deepEqual(s.recent().map((m) => m.text).sort(), ['Day 2', 'You may not rest now; there are monsters nearby'])
})
const bot = (food, health, names) => ({ food, health, registry: { foodsByName: { rotten_flesh: { foodPoints: 4, saturation: 0.8 }, cooked_beef: { foodPoints: 8, saturation: 12.8 }, beef: { foodPoints: 3, saturation: 1.8 } } },
  inventory: { items: () => names.map((n) => ({ name: n, count: 2 })) } })
test('eat: rotten flesh only when starving or hurt with regen blocked; an explicit choice is honoured', () => {
  assert.equal(needsBadFood(bot(10, 20, [])), false)
  assert.equal(needsBadFood(bot(5, 20, [])), true)
  assert.equal(needsBadFood(bot(10, 3, [])), true, 'hp 3 food 10: natural regen is off')
  assert.equal(needsBadFood(bot(18, 3, [])), false)
  const b = bot(12, 15, ['rotten_flesh'])
  assert.equal(edibles(b).length, 0); assert.equal(edibles(b, { also: 'rotten_flesh' }).length, 1)
  assert.deepEqual(edibles(bot(10, 3, ['rotten_flesh', 'cooked_beef']), { allowBad: true }).map((i) => i.name), ['cooked_beef', 'rotten_flesh'])
})
const c0 = (o = {}) => ({ bot: { food: 10, health: 3 }, inv: { food: 0, badFood: 4, blocks: 19, pickaxe: 1, free: 5 }, needs: { urgencies: { hunger: 0.5 }, levels: {} }, tier: 2, exposed: [], hostiles: 1, dark: true, sealed: false, underground: false, ...o })
test('habits: eat while hurt with food < 18; dig_in beats take_cover when nearly dead and not sealed', () => {
  const eat = CATALOG.find((h) => h.name === 'eat'), dig = CATALOG.find((h) => h.name === 'dig_in'), cover = CATALOG.find((h) => h.name === 'take_cover')
  assert.ok(eat.applies(c0()), 'rotten flesh counts at hp 3 / food 10')
  assert.ok(!eat.applies(c0({ bot: { food: 10, health: 20 }, inv: { food: 0, badFood: 4 } })), 'healthy: no rotten flesh')
  assert.ok(eat.applies(c0({ bot: { food: 16, health: 12 }, inv: { food: 2, badFood: 0 } })), 'regen drive')
  assert.ok(eat.utility(c0({ inv: { food: 2, badFood: 0 } })) > eat.utility(c0({ bot: { food: 10, health: 20 }, inv: { food: 2 } })))
  assert.ok(dig.applies(c0())); assert.ok(!dig.applies(c0({ sealed: true }))); assert.ok(!dig.applies(c0({ bot: { food: 10, health: 12 } })))
  assert.ok(dig.utility(c0()) > cover.utility(c0()))
})
test('S1 goals: dig_in is an option for defend/avoid/rest/build_shelter, and finishes them', () => {
  for (const t of ['defend', 'avoid', 'rest', 'build_shelter']) assert.ok(OPTIONS[t].some((o) => o.name === 'dig_in' && o.skill === 'dig_in'), t)
  const o = OPTIONS.defend.find((x) => x.name === 'dig_in')
  assert.ok(o.applies(c0())); assert.ok(!o.applies(c0({ inv: { blocks: 0, pickaxe: 0 } })))
  const g = { did: new Set(['dig_in:done']), steps: 1 }
  assert.ok(ACHIEVED.defend({ hostiles: 3 }, g) && ACHIEVED.rest({ energyLevel: 0 }, g) && ACHIEVED.build_shelter({}, g))
  const eatOpt = OPTIONS.get_food.find((x) => x.name === 'eat')
  assert.ok(eatOpt.applies(c0())); assert.ok(!eatOpt.applies(c0({ bot: { food: 12, health: 20 } })))
})
test('digest: hp one decimal below 6, never 0 while alive; memory ages and distances', () => {
  assert.equal(hpShown(0.27), 0.3); assert.equal(hpShown(2.77), 2.8); assert.equal(hpShown(14.4), 14); assert.equal(hpShown(0), 0)
  assert.equal(agoText(30), '30 s ago'); assert.equal(agoText(4 * 3600), '4 h ago'); assert.equal(agoText(120), '2 min ago')
  assert.equal(recency(0, { x: 700, z: 0 }, 4 * 3600, { x: 0, z: 0 }), '(4 h ago, 700 m away) ')
})
