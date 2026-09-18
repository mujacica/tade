---
name: add-extension
description: Add a Tade extension — something the orchestrator, agents and the window can use that Tade was not built knowing about (dependencies, Sentry). Use when adding tools that talk to an outside service or a project's files, a brief item, or a new built-in extension.
---

# Adding an extension

An extension is harness-neutral: it declares tools as JSON Schema and runs them **in the window's
process**, where its settings and credentials are. Each harness gets them in its own terms — pi as
tools registered by Tade's own pi extensions, which call back to Tade. What only a harness can do
(a pi skill, a native pi extension) ships beside it under `harness.<id>`.

| Path | What |
|---|---|
| `packages/extensions/core/src/port.ts` | `TadeExtension`, tools, actions, watches, brief items, linkers, context |
| `packages/extensions/core/src/host.ts` | `ExtensionHost`: loads, checks, runs, briefs, prompts |
| `packages/extensions/core/src/conformance.ts` | The suite every extension passes |
| `packages/extensions/<name>/` | A built-in extension: `src/extension.ts`, `skills/`, `test/` |
| `packages/orchestrator/src/extensions.ts` | `BUILTIN_EXTENSIONS` (the registry) and what loading gives each part |
| `~/.tade/extensions/active/<name>/extension.ts` | Yours: default-export the extension |

## Rules

- **Tools start with the extension's name**: `sentry_issues`, `deps_check`. The host refuses anything
  else, which is what keeps two extensions from shadowing each other or Tade's own `tade_*` tools.
- **Say who a tool is for** (`for: ['orchestrator', 'agent']`). Anything that changes something
  outside the project — resolving a Sentry issue — is `['orchestrator']` only, and its description
  says "only when asked".
- **Work happens in agents.** A tool that changes a project calls `ctx.tade.startAgent(...)` with a
  `context` (becomes `.tade/context.md`), `links` (kept in `task.yaml`, shown under GIT) and
  `prepare` (changes the directory it will work in before it starts: the checkout or its
  worktree, as `agents.workspace` says). When `ctx.tade` is null there is no
  window: say so, don't do the work somewhere else. When `ctx.caller.kind === 'agent'`, work in
  `ctx.caller.cwd`, which is where that agent works.
- **`ready()` never touches the network** — it runs before the window opens. Return what to do
  ("set $SENTRY_AUTH_TOKEN…"), not that something failed.
- **Every setting is declared** in `settings`. A key under `extensions.<name>` that is not declared is
  reported as not read, in the panel and `tade extensions`.
- **Answers are markdown for a reader** — a model or a person. Put URLs in `links` so they are
  written out and clickable; add `linkers` for ids that should open somewhere (Sentry short ids).
- **Throw with a reason someone can act on.** The host turns it into the tool's failure, which the
  model reads and the window shows in full.
- **Setup is a guide and fields** (`setup(ctx)`): steps in markdown, links to where the thing is
  made, and one field per setting — with `choices` looked up once the panel is open (the
  organizations a token can see). Saving writes the config, reloads the host and says whether it is
  ready now.
- **Status bar items are cheap and shared** (`status(ctx)`): the window asks every few seconds and
  gives up after two, so cache a sample and let every caller — status, `view`, tools — read the same
  one. `view(ctx)` is the markdown a click on the item opens, asked again while it is open.
- **`heard` on an action is for narrow phrases only** ("how much is Tade using"): matched against the
  whole utterance and run with no model. Anything looser is the orchestrator's, through the tool's
  description. Give the answer a `said` sentence, because the markdown is not for speaking.
- **Polling costs something; measure it.** Anything polled gets a performance test (see
  `extensions/resources`): one command for the whole picture, bounded history, a time limit in the
  test.
- **A watch finds work on a clock** (`watches`): `check(ctx)` looks cheaply — no model, a minute at
  most — and returns findings with a `key` that stays the same each time the same thing is found,
  and a `since` its next look starts from (`ctx.since`, or `ctx.turnedOn` the first time: what was
  there before it was turned on is not new). Overlap the cursor rather than risk a gap; Tade drops
  what it has seen. `agent(finding, ctx)` is asked only for what work starts on, so fetch the
  details there, and write them as `context`. Nothing found is an empty list; throw only when it
  cannot look, with why. Declare what it takes as `input`, and how often it looks as `every`
  (`30m`, `1h`). Tade does the rest: turning it on, the journal, the queue, telling people.
  Test it through `host.look(...)` with a fake `fetch` (see `extensions/sentry`).
- **Tests never reach the network.** Pass `fetch` to `ExtensionHost.load`, and `env: {}` — `pnpm run`
  puts its own `npm_config_*` in the environment. Use `mkrepo` for anything reading a project.

## Steps

1. Create `packages/extensions/<name>/` with `package.json` (`@tade/extension-<name>`, depending on
   `@tade/extensions-core`), `tsconfig.json`, `src/extension.ts`, `src/index.ts`.
2. Write the extension. Keep what talks to the service (`api.ts`), what formats answers
   (`format.ts`) and the extension itself (`extension.ts`) apart, so each is tested alone.
3. In `test/`, call `extensionConformance(() => yourExtension, { settings, env })` and test the tools
   through `ExtensionHost.load(...).call(...)` with a fake `fetch`.
4. If agents should know how to work with it, add a pi skill under `skills/<skill>/SKILL.md` and list
   it in `harness.pi.skills`; write `agents(ctx, project)` for the one paragraph every agent is told.
5. Add it to `BUILTIN_EXTENSIONS` and to `packages/orchestrator/package.json`; `pnpm install`.
6. If the window should show something new about it, follow `change-the-window`.
7. Mention it in the README's extensions section, and run `pnpm check`.
