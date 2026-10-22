#!/usr/bin/env node
// JSON-lines server on stdin/stdout: one request object per line in, one response per line out. No ports, no network.
//   echo '{"op":"status"}' | node mind/cli.js --db /path/mind.sqlite
import readline from 'node:readline';
import { createMind } from './api.js';
const i = process.argv.indexOf('--db');
const mind = createMind({ dbPath: i > 0 ? process.argv[i + 1] : ':memory:' });
const rl = readline.createInterface({ input: process.stdin });
let chain = Promise.resolve();
rl.on('line', (line) => { chain = chain.then(async () => {
  let req; try { req = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ ok: false, error: 'bad json' }) + '\n'); return; }
  const res = await mind.handle(req); if (req.id !== undefined) res.id = req.id; process.stdout.write(JSON.stringify(res) + '\n');
}); });
rl.on('close', () => chain.then(() => { mind.saveState(); mind.memory.close(); }));
