---
name: add-extension
description: Add a Wilco extension — something the orchestrator, agents and the window can use that Wilco was not built knowing about (dependencies, Sentry). Use when adding tools that talk to an outside service or a project's files, a brief item, or a new built-in extension.
---

# Adding an extension

An extension is harness-neutral: it declares tools as JSON Schema and runs them **in the window's
process**, where its settings and credentials are. Each harness gets them in its own terms — pi as
tools registered by Wilco's own pi extensions, which call back to Wilco. What only a harness can do
(a pi skill, a native pi extension) ships beside it under `harness.<id>`.

| Path | What |
|---|---|
| `packages/extensions/core/src/port.ts` | `WilcoExtension`, tools, actions, brief items, linkers, context |
| `packages/extensions/core/src/host.ts` | `ExtensionHost`: loads, checks, runs, briefs, prompts |
| `packages/extensions/core/src/conformance.ts` | The suite every extension passes |
| `packages/extensions/<name>/` | A built-in extension: `src/extension.ts`, `skills/`, `test/` |
| `packages/orchestrator/src/extensions.ts` | `BUILTIN_EXTENSIONS` (the registry) and what loading gives each part |
| `~/.wilco/extensions/active/<name>/extension.ts` | Yours: default-export the extension |

## Rules

- **Tools start with the extension's name**: `sentry_issues`, `deps_check`. The host refuses anything
  else, which is what keeps two extensions from shadowing each other or Wilco's own `wilco_*` tools.
- **Say who a tool is for** (`for: ['orchestrator', 'agent']`). Anything that changes something
  outside a worktree — resolving a Sentry issue — is `['orchestrator']` only, and its description
  says "only when asked".
- **Work happens in agents.** A tool that changes a project calls `ctx.wilco.startAgent(...)` with a
  `context` (becomes `.wilco/context.md`), `links` (kept in `task.yaml`, shown under GIT) and
  `prepare` (changes the worktree before the agent starts). When `ctx.wilco` is null there is no
  window: say so, don't do the work somewhere else. When `ctx.caller.kind === 'agent'`, work in
  `ctx.caller.cwd`, which is that agent's worktree.
- **`ready()` never touches the network** — it runs before the window opens. Return what to do
  ("set $SENTRY_AUTH_TOKEN…"), not that something failed.
- **Every setting is declared** in `settings`. A key under `extensions.<name>` that is not declared is
  reported as not read, in the panel and `wilco extensions`.
- **Answers are markdown for a reader** — a model or a person. Put URLs in `links` so they are
  written out and clickable; add `linkers` for ids that should open somewhere (Sentry short ids).
- **Throw with a reason someone can act on.** The host turns it into the tool's failure, which the
  model reads and the window shows in full.
- **Tests never reach the network.** Pass `fetch` to `ExtensionHost.load`, and `env: {}` — `pnpm run`
  puts its own `npm_config_*` in the environment. Use `mkrepo` for anything reading a project.

## Steps

1. Create `packages/extensions/<name>/` with `package.json` (`@wilco/extension-<name>`, depending on
   `@wilco/extensions-core`), `tsconfig.json`, `src/extension.ts`, `src/index.ts`.
2. Write the extension. Keep what talks to the service (`api.ts`), what formats answers
   (`format.ts`) and the extension itself (`extension.ts`) apart, so each is tested alone.
3. In `test/`, call `extensionConformance(() => yourExtension, { settings, env })` and test the tools
   through `ExtensionHost.load(...).call(...)` with a fake `fetch`.
4. If agents should know how to work with it, add a pi skill under `skills/<skill>/SKILL.md` and list
   it in `harness.pi.skills`; write `agents(ctx, project)` for the one paragraph every agent is told.
5. Add it to `BUILTIN_EXTENSIONS` and to `packages/orchestrator/package.json`; `pnpm install`.
6. If the window should show something new about it, follow `change-the-window`.
7. Mention it in the README's extensions section, and run `pnpm check`.
