// FOOD4: chronic food poverty (digest sentence + menu ranking), rod-aware fishing offers, honest farm feasibility.
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeDigest } from '../contract.js'
import { activityMenu } from '../menu.js'
import { foodEpisodeLine } from '../menu-farm1.js'
import { buildMessages } from '../prompt.js'

const dg = (o = {}) => normalizeDigest({ time: { day: 3, phase: 'day', ticks: 3000 }, pos: [0, 64, 0], health: 20, food: 20, energy: 18, needs: {}, inventory: {}, free_slots: 20, nearby: [], hazards: [], places: [], players: [], events: [], ...o })
const lines = (t) => t.split('\n').filter((l) => /^\d+\./.test(l))

test('digest says plainly how often she ran out of food today (2+); one episode says nothing', () => {
  const d = dg({ food: 5, food_episodes: { day: 3, today: 3, yesterday: 0, in_episode: true } })
  assert.equal(d.food_episodes.today, 3)
  assert.match(foodEpisodeLine(d), /You ran out of food 3 times today.*hunting\/foraging near home is not enough/)
  assert.equal(foodEpisodeLine(dg({ food_episodes: { day: 3, today: 1, yesterday: 0 } })), null)
  assert.match(foodEpisodeLine(dg({ food_episodes: { day: 3, today: 1, yesterday: 4 } })), /4 times yesterday/)
  assert.equal(foodEpisodeLine(dg({})), null)
})

test('after 2+ episodes in daylight farm_plot ranks first (feasible, hoe held) with the reason; she still chooses', () => {
  const t = activityMenu(dg({ food: 9, inventory: { wooden_hoe: 1, wheat_seeds: 4 }, food_episodes: { day: 3, today: 2, yesterday: 0 } }), { max: 12 })
  const l = lines(t)
  assert.match(l[0], /^1\. farm_plot:/); assert.match(l[0], /ran out of food 2 times today/)
  const t1 = activityMenu(dg({ food: 9, inventory: { wooden_hoe: 1 }, food_episodes: { day: 3, today: 1, yesterday: 0 } }), { max: 12 })
  assert.doesNotMatch(t1, /ran out of food/)
})

test('chronic but no wood: farm_plot is a NOT NOW with the count, gather_wood is offered instead', () => {
  const t = activityMenu(dg({ food: 9, inventory: { oak_planks: 2 }, food_episodes: { day: 3, today: 2, yesterday: 0 } }), { max: 12 })
  assert.match(t, /gather resource=wood count=8:.*first step to a farm/)
})

test('at night the chronic boost does not apply; starving + hurt + foodless keeps forage on top', () => {
  const n = activityMenu(dg({ time: { day: 3, phase: 'night', ticks: 15000 }, food: 9, inventory: { wooden_hoe: 1 }, food_episodes: { day: 3, today: 3, yesterday: 0 } }), { max: 12 })
  assert.doesNotMatch(n, /ran out of food 3 times today/)
  const s = activityMenu(dg({ food: 2, health: 8, inventory: { wooden_hoe: 1 }, food_episodes: { day: 3, today: 3, yesterday: 0 } }), { max: 12 })
  assert.match(lines(s)[0], /^1\. forage/); assert.match(lines(s)[1], /^2\. farm_plot/); assert.match(lines(s)[1], /eat first/)
})

test('fishing is only offered with a rod or the means to make one (the live 2 sticks + 3 string case is not)', () => {
  const base = { food: 9, water_near_m: 5 }
  const live = activityMenu(dg({ ...base, inventory: { stick: 2, string: 3 } }), { max: 14 })
  assert.doesNotMatch(lines(live).join('\n'), /fish catches|fish: /); assert.match(live, /fish \(no fishing rod: you have 3 string but 2 sticks/)
  assert.match(live, /no fishing: no fishing rod: you have 3 string but 2 sticks|get_food: .*no fishing/s)
  const can = activityMenu(dg({ ...base, inventory: { stick: 3, string: 2 } }), { max: 14 })
  assert.match(can, /fish(_session)?[^\n]*(craft a rod from 3 sticks \+ 2 string|a rod is crafted first \(3 sticks \+ 2 string\))/)
  const rod = activityMenu(dg({ ...base, inventory: { fishing_rod: 1 } }), { max: 14 })
  assert.match(rod, /fish[^\n]*(cast your rod|rod is in the bag)/)
})

test('prompt carries the food history sentence', () => {
  const m = buildMessages({ digest: dg({ food: 5, food_episodes: { day: 3, today: 2, yesterday: 0 } }) })
  assert.match(JSON.stringify(m), /You ran out of food 2 times today/)
})
