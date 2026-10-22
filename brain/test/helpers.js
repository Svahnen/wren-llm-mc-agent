export const DG = {
  time: { day: 3, phase: 'day' }, pos: [40, 70, -12], health: 20, food: 20, energy: 18,
  needs: { hunger: 0, energy: 0.1, safety: 0, curiosity: 0.4, social: 0.2 },
  inventory: { oak_log: 6, bread: 2 }, free_slots: 20,
  nearby: [
    { id: 'cow_1', kind: 'cow', cat: 'animal', dist: 5, pos: [36, 70, -10], tags: ['animal'] },
    { id: 'zombie_1', kind: 'zombie', cat: 'hostile', dist: 9, pos: [49, 70, -12] },
    { id: 'diamond_ore_1', kind: 'diamond_ore', cat: 'block', dist: 4, pos: [44, 69, -12] },
  ],
  hazards: [{ id: 'lava_1', kind: 'lava', dist: 6, pos: [46, 69, -12] }],
  players: [{ name: 'Alex', dist: 12 }],
  places: [{ id: 'home', kind: 'home', pos: [0, 64, 0], dist: 45 }],
  events: [], chat: [], recent_intents: [],
}
export const dg = (o = {}) => ({ ...DG, ...o })
export const wait = (ms) => new Promise((r) => setTimeout(r, ms))
