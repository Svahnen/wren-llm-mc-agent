// GOAL3: routines (sleep, eat, heal, shelter) are scheduled, not long-term goals; time awareness; projects prompt; nightly review keeps it clean.
import test from 'node:test'
import assert from 'node:assert/strict'
import { GoalStore, routineOf, reviewGoals, MAX_ACTIVE } from '../../mind/goals.js'
import { daylightInfo, daylightLine, routineNote } from '../daylight.js'
import { renderDigest, buildMessages } from '../prompt.js'
import { activityMenu } from '../menu.js'
import { normalizeDigest } from '../contract.js'
import { dg } from './helpers.js'

// the exact goal texts from the live log observed
const LIVE_ROUTINES = [
  'sleep in the bed',
  'settle in the bed at home and sleep',
  'I just woke up at my bed with the respawn point set, so I want to settle in properly and make sure I actually sleep through the night',
  'settle into my bed at home',
  'settle into my bed at home (reason: I keep getting interrupted and dying before I can sleep safely, and the player confirmed the bed at home is the right one)',
  'secure a safe place to sleep before the dark gets worse',
]
const PROJECTS = ['have a reliable home with a bed and protection so I can sleep through nights without dying', 'build a house by the lake', 'explore the cave to the east', 'find iron', 'become friends with Alex', 'make a stone pickaxe']

test('live goal texts about sleeping are routines; projects are not', () => {
  for (const t of LIVE_ROUTINES) assert.ok(routineOf(t), t)
  for (const t of PROJECTS) assert.equal(routineOf(t), null, t)
  assert.equal(routineOf('sleep in the bed').trigger, 'when it gets dark')
})

test('goal: sleep is stored as a scheduled routine, takes no goal slot, and S2 is told', () => {
  const g = new GoalStore()
  const r = g.apply({ goal: 'sleep in the bed', why: 'I want to rest' }, { now: 1000 })
  assert.equal(r.created, null); assert.equal(g.active().length, 0)
  assert.equal(r.routine.kind, 'sleep'); assert.equal(g.routines.length, 1)
  assert.match(g.renderRoutines(), /R1 sleep at night: when it gets dark/)
  const again = g.apply({ goal: 'settle into my bed at home' }); assert.equal(g.routines.length, 1); assert.ok(again.routine)
  for (let i = 0; i < MAX_ACTIVE; i++) assert.ok(g.apply({ goal: 'explore valley number ' + i }).created)
  assert.equal(g.active().length, MAX_ACTIVE)
  const note = routineNote(r.routine, normalizeDigest(dg({ time: { day: 1, phase: 'day', ticks: 6000 } })))
  assert.match(note, /routine, not a long-term goal/); assert.match(note, /about 6 min of real time/); assert.match(note, /daylight/)
  const j = GoalStore.fromJSON(JSON.parse(JSON.stringify(g.snapshot()))); assert.equal(j.routines.length, 1)
})

test('rewording an existing goal into a routine moves it out of the goal list', () => {
  const g = new GoalStore(); g.apply({ goal: 'find the river' })
  const r = g.apply({ goal: 'G1: sleep in the bed' })
  assert.ok(r.routine); assert.deepEqual(r.closed, ['G1']); assert.equal(g.active().length, 0)
})

test('legacy stores: routine goals migrate on load', () => {
  const g = GoalStore.fromJSON({ goals: [{ id: 'G1', text: 'sleep in the bed', why: '', status: 'active', plan: [], notes: [], created_ms: 0 }, { id: 'G2', text: 'build a hut', why: '', status: 'active', plan: [], notes: [], created_ms: 0 }], nextId: 3 })
  assert.deepEqual(g.active().map((x) => x.id), ['G2']); assert.equal(g.routines[0].kind, 'sleep')
})

test('time awareness: daylight left in real minutes and game clock in the digest', () => {
  const d = daylightInfo({ time: { ticks: 6542 } }); assert.equal(d.minToDusk, 5); assert.equal(d.night, false)
  assert.equal(daylightInfo({ time: { ticks: 13000 } }).night, true)
  assert.equal(daylightInfo({ time: {} }), null)
  assert.match(daylightLine({ time: { ticks: 6542 } }), /about 5 min of real time left until dusk .*dusk at 18:32/)
  assert.match(renderDigest(dg({ time: { day: 1, phase: 'day', ticks: 6542 } })), /daylight: about 5 min/)
  assert.doesNotMatch(renderDigest(dg()), /daylight:/)   // no ticks, no claim
})

test('menu: sleep is NOT NOW until ~1 min before dusk', () => {
  const bed = [{ id: 'bed', kind: 'bed', dist: 3, pos: [1, 64, 1] }]
  const day = activityMenu(normalizeDigest(dg({ places: bed, time: { day: 1, phase: 'day', ticks: 3000 } })))
  assert.doesNotMatch(day, /\d\. sleep_at_night/); assert.match(day, /NOT NOW:.*sleep_at_night \(not night yet: dusk in 8 min/)
  const soon = activityMenu(normalizeDigest(dg({ places: bed, time: { day: 1, phase: 'day', ticks: 11700 } })))
  assert.match(soon, /\d\. sleep_at_night/)
  assert.match(activityMenu(normalizeDigest(dg({ places: bed, time: { day: 1, phase: 'night', ticks: 14000 } }))), /\d\. sleep_at_night/)
})

test('no project: the prompt offers daytime options without choosing, and says waiting by the bed is no plan', () => {
  const d = dg({ time: { day: 1, phase: 'day', ticks: 6000 }, places: [{ id: 'bed', kind: 'bed', dist: 2 }] })
  const g = new GoalStore(); g.apply({ goal: 'sleep in the bed' })
  const msgs = buildMessages({ digest: d, autonomy: 'high', goals: g.render(), routines: g.renderRoutines(), noProject: g.projects().length === 0 })
  const u = msgs[1].content
  assert.match(u, /Your routines \(scheduled[\s\S]*R1 sleep at night/); assert.match(u, /no long-term project right now \(only routines/)
  assert.match(u, /about 6 min of daylight/); assert.match(u, /Waiting by your bed is not a plan/); assert.match(u, /gather/); assert.match(u, /explore/)
  assert.doesNotMatch(u, /you should (gather|explore)/i)
  const withProject = buildMessages({ digest: d, autonomy: 'high', goals: 'G1 [active] x', routines: '', noProject: false })[1].content
  assert.doesNotMatch(withProject, /no long-term project/)
})

test('nightly review keeps it clean: routines move out and are not kept', async () => {
  const g = GoalStore.fromJSON({ goals: [{ id: 'G1', text: 'explore the east cave', why: '', status: 'active', plan: [], notes: [], created_ms: 0 }], nextId: 2 })
  g.goals.push({ id: 'G2', text: 'sleep in the bed', why: '', status: 'active', plan: [], notes: [], created_ms: 0 })   // sneaked in
  let asked = ''
  const res = await reviewGoals(g, async (m) => { asked = m[1].content; return 'keep: G1 still curious\nkeep: G2 yes' }, { name: 'Wren' })
  assert.deepEqual(g.active().map((x) => x.id), ['G1']); assert.doesNotMatch(asked, /G2 \[active/); assert.match(asked, /routines, not goals/)
  assert.deepEqual(res.result.kept, ['G1']); assert.equal(g.routines.length, 1)
})
