---
name: add-config-key
description: Add or change a key in ~/.wilco/config.yaml (zod schema, defaults, validation errors, docs). Use whenever a feature needs a user-tunable setting.
---

# Adding a config key

Schema: `ConfigSchema` in `packages/core/src/config.ts` (zod 4).

## Conventions

- Objects are `z.strictObject` so typos are errors, and `wilco config --check` names the bad key
  by its dotted path (`workspace.drivr`). Keep new objects strict.
- Every key has a default (`.default(...)`) or is `.optional()`. An empty or missing config
  file must always parse. Nested sections use `.prefault({})` so their inner defaults apply.
- Closed sets are `z.enum([...])`, not free strings.
- A key that refers to something else in the file (a worker route name, a project) is checked in
  the schema's `superRefine`, with `path` pointing at the offending key. Catching it at
  `wilco config --check` time is the whole point; don't leave it to fail at spawn time.
- Use `.prefault(value)` for a fallback that should be *parsed* (so nested defaults apply).
  `.default(value)` injects the value as-is and skips them.
- Paths may start with `~`; expand them with `expandHome()` where they're used, not in the schema,
  so `wilco config` prints what the user wrote.
- Don't read `process.env` or `homedir()` inside feature code. Take the loaded `Config`,
  and use `wilcoHome(env)` for state paths so tests can set `WILCO_HOME`.

## Steps

1. Add the key to the schema with a default.
2. Add cases to `packages/core/test/config.test.ts`: the default, a valid value, and an invalid
   value asserting the exact `issues[0].path`.
3. Use it via `loadConfig()` in the consumer. In the window, read it from `this.opts.config` at the
   moment it is needed rather than copying it at start: Settings replaces that object when a value
   changes, which is what makes a setting apply at once.
4. If people will want to change it, add it to `settingsOf` in `packages/core/src/settings.ts`, in
   the group they would look for it in: a `title`, a `means` sentence saying what changing it does,
   a `kind` (`choice`, `flag`, `number` with a `unit`, `text`, `hours`, `key`, `model`), and
   `live: false` if it is only read when Wilco starts — the panel labels it *on restart*.
5. Its `means` sentence is its documentation. The README shows config only for setting up something
   people cannot start without (an extension's organization, say).
6. `pnpm check`.

Writing config: always edit the YAML **document** (`parseDocument`, `setIn`, `deleteIn`), never
`parse` then `stringify` — that drops every comment in a file somebody wrote by hand.
