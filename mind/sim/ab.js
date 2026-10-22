// A/B memory ablation: same seeds, same scripted first lava death, memory ON vs OFF.
import { runSim } from './run.js';
export async function runAB({ seeds = [1, 2, 3, 4, 5], days = 10 } = {}) {
  const rows = []; for (const seed of seeds) {
    const on = await runSim({ seed, days, memory: true }), off = await runSim({ seed, days, memory: false });
    const w3 = (m) => m.lavaDeathsByDay.slice(1, 4).reduce((a, b) => a + b, 0);
    rows.push({ seed, offRepeats: off.lavaDeathsAfterFirst, onRepeats: on.lavaDeathsAfterFirst, offNext3d: w3(off), onNext3d: w3(on), offMineAttempts: off.goals.mine_iron ?? 0, onMineAttempts: on.goals.mine_iron ?? 0 });
  }
  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
  const red = (off, on) => (off ? 1 - on / off : null);
  return { rows, totals: { offRepeats: sum('offRepeats'), onRepeats: sum('onRepeats'), reduction: red(sum('offRepeats'), sum('onRepeats')), offNext3d: sum('offNext3d'), onNext3d: sum('onNext3d'), reductionNext3d: red(sum('offNext3d'), sum('onNext3d')) } };
}
if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(await runAB(), null, 1));
