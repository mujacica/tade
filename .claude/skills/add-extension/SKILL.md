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
| `packages/extensions/core/src/port.ts` | `TadeExtension`, tools, actions, watches, brief items, linkers, caution, meant, context |
| `packages/extensions/core/src/host.ts` | `ExtensionHost`: loads, checks, runs, briefs, prompts |
| `packages/extensions/core/src/conformance.ts` | The suite every extension passes |
| `packages/extensions/<name>/` | A built-in extension: `src/extension.ts`, `skills/`, `test/` |
| `packages/orchestrator/src/extensions.ts` | `BUILTIN_EXTENSIONS` (the registry) and what loading gives each part |
| `~/.tade/extensions/<name>/extension.ts` | Yours: default-export the extension. One folder, and off until turned on |

## Rules

- **Being in the folder is not being on.** Tade's own (`BUILTIN_EXTENSIONS`) are on unless
  `extensions.<name>.enabled: false`; everything in `~/.tade/extensions/` is off until
  `enabled: true`, and one that is off is *never imported* — it is listed by its folder name and
  the first comment line of its file, and nothing in it runs. Turning one on takes effect the next
  time Tade starts (`tade extensions enable <name>`, Extensions, or the setup wizard's last
  question); the host says so rather than loading it mid-session. `extensionEnabled` in
  `packages/core` is the one rule, and `--safe` overrides all of it.
- **One of yours calls itself what its folder is called**, or it is listed as broken: the folder is
  what is turned on and what `extensions.<name>` configures, so two names would mean setting it up
  in one place and switching it in another.
- **Tools start with the extension's name**: `sentry_issues`, `deps_check`. The host refuses anything
  else, which is what keeps two extensions from shadowing each other or Tade's own `tade_*` tools.
- **Say who a tool is for** (`for: ['orchestrator', 'agent']`). Anything that changes something
  outside the project — resolving a Sentry issue — is `['orchestrator']` only, and its description
  says "only when asked".
- **Work happens in agents.** A tool that changes a project calls `ctx.tade.startAgent(...)` with a
  `context` (becomes `.tade/context.md` — ignored by the project, so it is the agent's to read and
  nobody's to commit), `links` (kept in `task.yaml`, shown under GIT) and
  `prepare` (changes the directory it will work in before it starts: the checkout or its
  worktree, as `agents.workspace` says). When `ctx.tade` is null there is no
  window: say so, don't do the work somewhere else. When `ctx.caller.kind === 'agent'`, work in
  `ctx.caller.cwd`, which is where that agent works.
- **`ready()` never touches the network** — it runs before the window opens. Return what to do
  ("set $SENTRY_AUTH_TOKEN…"), not that something failed.
- **Say how it is used, in `workflow`.** A few lines for a person, each one way it is actually
  reached for, in the order somebody would meet them — shown on its page in Extensions, unedited.
  `description` is one sentence and `orchestrator()` / `agents()` are written for models; this is
  the only thing that tells the person who installed it what it is for. Write what somebody is
  doing when this happens and what it gets them, not a feature list: with nothing here, a page
  showing one watch reads as an extension that does one thing — which is exactly how Jev, with
  eight tools, came to look like a thing that reviews diffs.
- **Every setting is declared** in `settings`. A key under `extensions.<name>` that is not declared is
  reported as not read, in the panel and `tade extensions`.
- **A credential is a `secret` setting, never a string one.** Declare it once —
  `{ key: 'token', kind: 'secret', env: 'SENTRY_AUTH_TOKEN', envFrom: 'token_env', means: … }` — and
  read it with `ctx.secret('token')`, which answers `{ value, from }` or null. Tade gives you the
  rest: a field in your `setup` (`kind: 'secret'`), a row in Settings › Keys and tokens, and the
  setting written into `config.yaml` under `extensions.<name>.<key>` — in plain text, in a file
  that is `0600` and one person's, so a pasted key can be read back and checked. What marks it as a
  secret is that the environment wins over it (so anything that worked before still does) and that
  you read it through `ctx.secret` rather than out of `ctx.settings`. Never put a credential in
  `settings` as a string — the field, the Settings row and the environment rule all hang off
  `kind: 'secret'` — and never put its value in an answer, a log line or a `ready()` message: say
  where it came from (`found.from`), which is a place, not a value.
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
- **A list is a section in the sidebar** (`lists`): an id, a heading, how often it may be asked
  again (`every`, never oftener than 30s), and `rows(ctx, filter)` reading the extension's own
  cache. It never throws — a problem is one quiet row saying why — a section with no rows and no
  problem is not drawn at all, and the window never asks it from a draw. A row is a title, a few
  marks, where it opens (one of the extension's own tools) and the task it is about, if any.
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
- **A second reading of a command runs with an agent held at it** (`caution`): Tade's approval rules
  have already answered the call, and this is asked beside them about what no rule names. It may
  only return a stricter tier (`soft`, `hard`) or null — there is no answer that allows anything —
  and the `reason` is a clause written in advance, never a sentence about the command. It is given
  a short deadline and a late answer is dropped, so never do anything here that must not be
  abandoned, and let a setting turn it off. The conformance suite holds every one of these to it.
- **A watch may be for telling rather than starting** (`offers: 'ask'`): then it has no `agent` at
  all, and Tade tells the orchestrator about each finding instead. Use it when what it finds is
  work already going — an agent stuck — where there is nothing to start. A watch that reads what
  Tade is running gets the window as `ctx.tade`, and says it cannot look without one rather than
  finding nothing.
- **A sentence typed into search reaches whoever offers to read one** (`meant`): the choices are
  what the window already has in its list, the answer is ids from that list and nothing else, and
  it has a deadline of a couple of seconds because somebody is watching the box.
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
