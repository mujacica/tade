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
- Paths may start with `~`; expand them with `expandHome()` where they're used, not in the schema,
  so `wilco config` prints what the user wrote.
- Don't read `process.env` or `homedir()` inside feature code. Take the loaded `Config`,
  and use `wilcoHome(env)` for state paths so tests can set `WILCO_HOME`.

## Steps

1. Add the key to the schema with a default.
2. Add cases to `packages/core/test/config.test.ts`: the default, a valid value, and an invalid
   value asserting the exact `issues[0].path`.
3. Use it via `loadConfig()` in the consumer.
4. Document it in the **Configuration** block of `README.md` if users are expected to set it.
5. `pnpm check`.
