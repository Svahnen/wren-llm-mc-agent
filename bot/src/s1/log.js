// S1G: one JSONL line per System-1 decision, for training the goal-conditioned scorer.
//   {v:1, t, kind:'goal'|'no_intent', run, intent_id, step, goal:{type,target,hash,mods,intent_hash}|null, state:{...}, candidates:[{name,skill,score,base,hab,goal_term,pen,learned?,locked?}],
//    chosen:{name,skill,args,source:'selector'|'safety'|'habit'}, outcome:{status,reason,ms,achieved}}
import fs from 'node:fs'
import path from 'node:path'

export function createDecisionLog({ dir, run = null, maxBytes = 30e6 } = {}) {
  let bytes = 0, file = null, day = null
  return {
    write(rec) {
      if (!dir) return false
      try {
        const d = new Date().toISOString().slice(0, 10)
        if (d !== day) { day = d; file = path.join(dir, `s1-${d}.jsonl`); fs.mkdirSync(dir, { recursive: true }); bytes = 0 }
        if (bytes > maxBytes) return false
        const line = JSON.stringify({ v: 1, t: new Date().toISOString(), run, ...rec }) + '\n'
        fs.appendFileSync(file, line); bytes += line.length
        return true
      } catch { return false }
    },
  }
}
