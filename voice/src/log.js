import fs from 'node:fs'; import path from 'node:path';
export function makeLog(dir, name = 'voice') {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}-${new Date().toISOString().slice(0, 10)}.jsonl`);
  return (ev, data = {}) => { try { fs.appendFileSync(file, JSON.stringify({ ts: Date.now(), ev, ...data }) + '\n'); } catch {} };
}
