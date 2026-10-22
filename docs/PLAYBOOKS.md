# Extending Wren: playbooks, skills, reflexes, menu entries

## Vocabulary

| layer | where | what it is | who chooses it |
|---|---|---|---|
| **skill** | `bot/src/skills/*.js`, schema in `skills.json` | one capability with a progress watchdog: `gather`, `go_to`, `craft`, `gesture`, `eat` ... | playbook steps, habits, S2 |
| **reflex** | `bot/src/reflex/` | millisecond reactions that preempt everything: lava, drowning, burning, fall, suffocation | nobody; they fire on conditions |
| **habit** | `bot/src/habits/` | S1's own utility ranking of what to do when S2 gave no order (needs, boredom, recency) | S1 |
| **playbook** | `bot/src/playbooks/library/*.json` | a multi-step activity as data: skills and ops in order, guarded by predicates | S2 by name, or habits |
| **menu entry** | `brain/menu*.js` | the text and options S2 sees in its prompt | you |

Priority on the body: reflex (3) > S1 (2) > S2 (1). `bot/src/arbiter.js` hands out one owner token; a higher owner preempts a lower one.

## A playbook, annotated

`docs/examples/wave_at_person.json` (tested: it loads with the library validator):

```jsonc
{
  "name": "wave_at_person",                       // the name S2 uses; lowercase, underscores
  "desc": "walk up to a player, look at them and wave",   // shown to S2 in the menu
  "params": { "person": { "kind": "player", "required": true } },   // S2 writes: wave_at_person person=Alex
  "steps": [
    { "id": "locate", "op": "find_person", "args": { "person": "$person", "max_s": 30 },   // an op: code in playbooks/ops.js
      "retry": 0, "on_fail": { "abort": "person_not_found" } },             // abort the whole playbook with a reason
    { "id": "join", "when": ["!person_within:$person:5", "day", "!hostile_near"],   // predicates, all must hold, "!" negates
      "op": "approach_person", "args": { "person": "$person", "radius": 4 }, "retry": 1, "on_fail": "skip" },
    { "id": "look", "do": { "skill": "look_at", "args": { "target": "$person" } }, "on_fail": "skip" },   // a skill call
    { "id": "wave", "do": { "skill": "gesture", "args": { "kind": "wave" } }, "on_fail": "skip" }
  ]
}
```

Rules (full list in the header of `bot/src/playbooks/catalog.js`):
- Every step has exactly one of `do` (skill), `op` (code op) or `choose` (first feasible option that works).
- `$name` substitutes a parameter. Parameter kinds: `int`, `player`, `place`, enums (see `catalog.js`).
- `when`: predicates from `bot/src/playbooks/predicates*.js` (`day`, `night`, `hostile_near`, `food_lt:N`, `has_item:name:n`, `place_known:home`, `person_within:$p:r` ...). A step whose `when` fails is skipped.
- `ok` / `done_if`: predicates that decide success after the step; `loop: {until, max}` repeats a step.
- `retry`, `on_fail`: `"skip"` continues, `{ "abort": "reason" }` ends the playbook with that reason, which S2 reads in its next digest.
- `cooldown`: after the listed failure reasons, the menu hides the playbook for `s` seconds within `radius` blocks and shows `hint` instead.
- `commitment: true`: S1 keeps going even if the situation changes slightly (conversation promises).

### Try it

1. Copy the file into `bot/src/playbooks/library/`.
2. `cd bot && node -e "import('./src/playbooks/catalog.js').then(m => console.log(m.library().has('wave_at_person')))"` prints `true` (a malformed file throws with the reason).
3. `npm test` still passes (the library validator test loads every file).
4. Start the bot and brain; the playbook appears in S2's menu. Force it for a test by writing the chat line your brain would produce, or call the engine from a test: see `bot/test/pb1-engine.test.mjs` for the pattern (fake bot, fake clock, `createPlaybookEngine`).

## Add a skill

1. Implement `{ name, max_s, stall_s?, progress_fn(ctx), run(ctx), precondition?, abort? }` in `bot/src/skills/` (contract in `bot/README.md` and `bot/src/skills/README.md`) and register it in `skills/index.js`.
2. Declare its arguments in `bot/src/skills/skills.json` (types, ranges, defaults). `bot/test/skills-schema.test.mjs` checks the schema against the registry.
3. If S2 should be able to choose it directly, add its name to `SKILLS` in `brain/contract.js` and a translation in `bot/src/mindlink/translate.js`; the prompt and validator follow `SKILLS`.
4. `progress_fn` must return something that CHANGES while the skill makes progress and cannot oscillate; otherwise the watchdog aborts with `no_progress`.

## Add a reflex

Reflexes live in `bot/src/reflex/` (see its README). A reflex is a condition on the bot state plus an action that runs under the highest owner token; keep it fast and side-effect free when the condition is false. `bot/test/reflex-each.test.mjs` shows the test pattern with a bot double.

## Add or change what S2 sees

- `brain/prompt.js`: the system prefix (persona, rules) and the per-call user message. Change the persona here.
- `brain/menu.js` and `brain/menu-*.js`: `activityMenu(digest)` assembles the numbered options; each `menu-*.js` contributes one area. Add a function that returns lines/options from the digest and call it from `menu.js`.
- `brain/contract.js`: answer format, `SKILLS`, the validator rules and their error codes. Adding a rule here requires a test in `brain/test/`.
- Keep prompt text and tests in sync: several tests assert on prompt wording.

## Test your change

```bash
cd bot && npm test            # or one file:  node --test test/pb1-engine.test.mjs
cd ../brain && npm test
```
