---
name: add-config-key
description: Add or change a key in ~/.tade/config.yaml (zod schema, defaults, validation errors, Settings, how far the orchestrator's arm reaches into it, credentials). Use whenever a feature needs a user-tunable setting, when a setting needs a key or a DSN, when a key must stop being read, or when deciding what the orchestrator may change.
---

# Adding a config key

Schema: `ConfigSchema` in `packages/core/src/config.ts` (zod 4).

The config is the one thing Tade owns that is neither derived nor a lane's: everything else is a
query. So a key is four decisions, not one — what it parses as, where somebody finds it, how far the
orchestrator's arm reaches into it, and whether a person can read back what they typed.

| Path | What |
|---|---|
| `packages/core/src/config.ts` | `ConfigSchema`, `loadConfig`, `writeSetting`, `ownerOnly` |
| `packages/core/src/settings.ts` | `settingsOf`, `parseSetting`, `findableBy`, `SettingKind`, the Keys and tokens group |
| `packages/core/src/reach.ts` | `settingReach`, `Reach`, the `NEVER` table, `OPEN`, `OPEN_UNDER`, `ALLOWED_UNDER`, `namedBy`, `wordsFor`, `WATCH_REACH`, `watchNamedBy`, `LINES_LOOKED_BACK` |
| `packages/core/src/project.ts` | what one project answers for itself: `workspaceFor`, `pushFor`, `PUSH_MODES`, `pushProblems` |
| `packages/core/src/secrets.ts` | a credential: `findSecret`, `secretPath`, `secretCommand`, `IN_CONFIG`, `KEYS_AND_AGENTS`, `SEEN_BY_AGENTS` |
| `packages/core/src/gone.ts` | keys that are gone: the `GONE` table, `dropGone`, `SERVER_RUNS_AS_YOU`, `SERVER_HELD_BY_NOTHING`, `CHECKS_ARE_READ` |
| `packages/app/src/wire/settings.ts` | where reach is *enforced*, `config_changed`, `held` (a credential said as `set` / `not set`) |
| `packages/app/src/panels/settings/state.ts` | the page: `settingsClick`, `leavingField`, `visibleSettings`, `writeOf` |
| `packages/app/src/wire/projects.ts` | `openAt` — the one door a project is opened through |
| `packages/orchestrator/src/tools-config.ts` | `tade_settings`, `tade_setting_change`, `tade_project_open`, `tade_project_close` |
| `packages/core/test/config.test.ts`, `test/reach.test.ts` | the default, the bad value, and which side of the reach line a new section is on |

## Conventions

- Objects are `z.strictObject` so typos are errors, and `tade config --check` names the bad key
  by its dotted path (`workspace.drivr`). Keep new objects strict.
- Every key has a default (`.default(...)`) or is `.optional()`. An empty or missing config
  file must always parse. Nested sections use `.prefault({})` so their inner defaults apply.
- Closed sets are `z.enum([...])`, not free strings.
- A key that refers to something else in the file (a worker route name, a project) is checked in
  the schema's `superRefine`, with `path` pointing at the offending key. Catching it at
  `tade config --check` time is the whole point; don't leave it to fail at spawn time.
- Use `.prefault(value)` for a fallback that should be *parsed* (so nested defaults apply).
  `.default(value)` injects the value as-is and skips them.
- Paths may start with `~`; expand them with `expandHome()` where they're used, not in the schema,
  so `tade config` prints what the user wrote.
- Don't read `process.env` or `homedir()` inside feature code. Take the loaded `Config`,
  and use `tadeHome(env)` for state paths so tests can set `TADE_HOME`.
- **A setting Tade accepts and ignores is worse than one it doesn't have**, because it reads like a
  promise. If a config key has no reader, either wire it or delete it — and if a key stops being
  read, it goes in `GONE` rather than staying in the schema doing nothing (below).

## Steps

1. Add the key to the schema with a default.
2. Add cases to `packages/core/test/config.test.ts`: the default, a valid value, and an invalid
   value asserting the exact `issues[0].path`.
3. Use it via `loadConfig()` in the consumer. In the window, read it from `this.opts.config` at the
   moment it is needed rather than copying it at start: Settings replaces that object when a value
   changes, which is what makes a setting apply at once.
4. If people will want to change it, add it to `settingsOf` in `packages/core/src/settings.ts`, in
   the group they would look for it in: a `title`, a `means` sentence saying what changing it does,
   a `kind` (`choice`, `flag`, `number` with a `unit` — `fraction` for a share of something —
   `text` (`pairs` for `a=b, c=d`), `hours`, `key`, `model`), and `live: false` if it is only read
   when Tade starts — the panel labels it *on restart*.
   - Name the group and the setting the words somebody would search for, and put the rest in
     `keywords`: the panel's search reads `findableBy`, which is the title, the `means`, the key
     itself and those words. A setting nobody can find is a setting nobody has.
   - A credential is not a setting you write here: an extension declares it (`kind: 'secret'` on its
     own setting declaration, `packages/extensions/core/src/port.ts`) and Settings › Keys and tokens
     draws a row per declared one. See *A credential is a setting* below.
5. Decide how far the orchestrator's arm reaches into it — `settingReach` in
   `packages/core/src/reach.ts`. See the section below; a whole new *section* of the schema fails
   `packages/core/test/reach.test.ts` until somebody has decided which side of the line it is on.
6. Its `means` sentence is its documentation. The README shows config only for setting up something
   people cannot start without (an extension's organization, say).
7. `pnpm check`.

## How far the orchestrator's arm reaches

Tade configures itself: the orchestrator reads what Tade is set up with and changes some of it
(`tade_settings`, `tade_setting_change`, `tade_project_open`, `tade_project_close`), through the
same `settingsOf`, `parseSetting` and `writeSetting` the Settings page goes through. **One write
path**, so a value the schema refuses is still put back as it was, and a change made by a model is
recorded exactly like one made by a hand.

What differs from the page is that the orchestrator is ungated and reads attacker-controlled text
all day — a review comment, a CI log, a dependency's changelog. So the question is never whether it
can be trusted but **what the worst a sentence it read can do is**, which is a property of the
setting rather than of the model. It is decided in one pure function (`settingReach`,
`core/src/reach.ts`) and **enforced in the window** (`packages/app/src/wire/settings.ts`), never in
the tool: a rule that lives where the model lives is a rule the model can be talked out of.

Three answers and no fourth:

- **`never`** is everything that widens what an agent may do, hands a third party tools or a
  credential, changes who is asked, or changes where Tade sends something — `approvals`, `accounts`
  and `workers.accounts`, a route's `provider`, the whole of `extensions` and `mcp`,
  `orchestrator.extensions`, `telemetry.dsn`, and a project's `root`. Each is a **subtree** and not
  a key, which is the whole point: a key added under one of them is refused on the day it is added,
  by somebody who never read this file. Never add a lone `never` entry where a subtree is what you
  mean.
- **`asked`** is the default and nearly everything else: the person's own words have to name that
  setting, checked against the journal's `said` lines (`namedBy`, over `LINES_LOOKED_BACK`). That is
  a real barrier rather than a formality, because `said` is what a person typed or spoke and nothing
  an agent read can ever get into it — a page can tell a model to turn the checks off, it cannot put
  "turn the checks off" in somebody's mouth. It is honest about what it holds: an ordinary word
  matches loosely, other wording is refused outright, and both are the safe direction, because it
  may only ever refuse.
- **`open`** is the three window sizes, where the worst case is something the person is looking at —
  plus, in `OPEN_UNDER`, what the person has said outright is the orchestrator's to set. There is one
  of those (`projects.<name>.push`) and it argues for itself where it is written, including what it
  costs. The shape of that argument is the one to copy: it is reach over a *setting* and never over
  an act, the act stays behind whatever already gates it (`approvals`), and the residual risk is
  named rather than left for somebody to find. A key only belongs here on the person's own say-so.

Two consequences when you add a key:

- The other half of the `asked` decision is whether a person can *say* the setting's name. The check
  is `namedBy`, which reads the setting's path, its title as a phrase, its `keywords` and its path
  segments (`wordsFor`) — so `keywords` that are the words somebody would actually say is what keeps
  a legitimate request from being refused. It is the same list the panel's search reads, so this
  costs nothing extra.
- Every change writes `config_changed` — the path, what it was, what it is now, who asked, and their
  words — because a change nobody watched has to be one somebody can find and undo. A credential is
  said there as `set` or `not set` (`held` in `wire/settings.ts`) and is never read back by any tool,
  the way it is never in the journal anywhere else.

One thing decided here is **not a config key at all** — a watch, which lives in `schedules.jsonl`
(`WATCH_REACH`, `watchNamedBy`). It is in `reach.ts` because the question is the same question, and
answering it somewhere else is how two answers to it come to exist. `extensions.*.enabled` is
`never` because turning an extension on imports somebody's code and hands its tools to every agent;
a watch inside an extension already on widens nothing an agent may do, so it is `asked`. What
`WATCH_REACH` does *not* hold is the queue's own pause and remove, and that is said in
`WATCH_REACH` rather than papered over.

## A key one project answers for itself

Some settings are the machine's answer only until somebody runs two repositories daily, and then
both answers are true at once — `agents.workspace` was one, and being global is what made the
start-time collision check read the wrong project's tree. The shape is always the same, and there
are exactly two files it can go wrong in:

- The key goes on `ProjectConfigSchema` as `.optional()` — never with a default, which would make
  "unset" and "set to the default" different things.
- **One reader, and every call site goes through it**: `checksFor` (`core/src/checks.ts`),
  `workspaceFor` and `pushFor` (`core/src/project.ts`) are the three there are, and a fourth
  belongs beside them. The bug is never the resolution, it is the site that still reads the global
  — so grep for the global key after you add the override and make sure the only reader left is
  the resolver.
- **A resolver may answer with *less* than was asked for, and then it has to say so.** `pushFor` is
  the one that does: `branch-and-review` needs a branch of the agent's own, so in a `checkout`
  project it cannot mean what it says and resolves to pushing nothing, with `pushNeedsABranch` as
  its `problem`. Resolving it to the *neighbouring* value would have put commits on a shared branch
  nobody asked to push — a resolution that answers with more than was asked for is the one shape to
  refuse outright. The sentence is written once and read in the three places somebody is deciding:
  the Settings row's `means`, `tade_settings` (the same row), and `parseConfig`'s `warnings`, which
  is what `tade config --check` prints. A **warning and never an issue**: refusing the file would
  take away everything else they wrote in it.
- **Something a task already carries is a parameter, not a read.** `pushFor` takes the workspace
  rather than reading `workspaceFor` itself, because a task keeps the workspace it was made with
  (`TaskFile.workspace`): resolving against the config would move an agent that is already working
  the moment somebody changed the setting under it.
- Anything that already exists keeps what it was made with. A task file records its own answer;
  changing the setting must never move an agent that is already working.
- Add it to the `projects` group in `settingsOf` with `value: project.<key> ?? ''` and
  `fallback: config.<the global>`, and put `''` first in a `choice` — empty is how somebody gives
  the question back to the machine, and `writeSetting` deletes the key.
- Add the path to `ALLOWED_UNDER` in `reach.ts`, or it is `never`: `projects` is a `never` subtree
  because of `root`, so a new key under it is refused until somebody decides — which is the rule
  working, not the rule in the way.

## A credential is a setting, written in the config in plain sight

Anything that needs a key declares a `secret` setting (`kind: 'secret'`, with the environment
variable it has always read as `env`), and what is pasted is written to `extensions.<name>.<key>` in
`config.yaml` — as typed, drawn as itself, copyable — like every other setting, by `writeSetting`,
which used to refuse exactly this. An account's API key is `accounts.<name>.key`, the same way.
`secretPath` builds the path; `findSecret` reads it.

Twice before, the worry about a key in a file was **obeyed rather than answered**:

1. By refusing credentials outright, which moved the job to everybody's shell profile.
2. By the OS keychain, which put it where nobody could look — a pasted key could not be read back
   and checked for a typo, could not be copied to another machine, and on a Mac whose keychain
   wanted a word about it could not be written at all without `security` stopping to ask, which is a
   question put to a window that has stopped drawing.

What answers the worry is **the file, not the hiding**: `config.yaml` lives in `TADE_HOME`, is
written `0600` and narrowed to its owner on every write (`ownerOnly`), and is not a project file
anybody commits. Nothing is masked anywhere: a key you cannot read is one you cannot check.

**The environment always wins** (`ctx.secret` on the extension port, `findSecret` — one rule, one
place), so a machine that exports a variable today behaves exactly as it does, and a field whose
variable beats it says so where it is saved (the row's `fallback` is `in use — <where>`). A key is
still never in the journal and never in anything telemetry would send. Nothing is kept anywhere
else: there is no keychain, no `secrets.json` and no vault to choose between — a key pasted into an
older Tade has to be pasted again.

## `0600` keeps the file from other people, and an agent is not another person

That is the whole of what the mode buys, and there is no second user on the machine to buy it from:
agents run as you, in your checkout, with nothing containing them and nothing asked
(`approvals.mode: 'bypass'`) unless somebody has turned approvals on — so **any agent can read
`config.yaml` and every key in it**. The audit agent that found this did exactly that, incidentally,
with no special access and no prompt.

Everything above stays true and stays worth having, and it is all containment of *everywhere else*:
a key is never in the journal (`set` or `not set`, `held` in `wire/settings.ts`), never in anything
telemetry would send (`KEPT`, and `leak.test.ts` is the proof), never in a lane's stored spec
(`withoutInherited`) and never in a launch line — a harness is handed `secretCommand`, which prints
the key at the moment it is needed. What is *not* contained is the one program you deliberately
handed the machine to, and no arrangement of the file can contain that.

So it is **a decision and not an oversight, and the rule is that it is said where somebody is
deciding**: the Extensions page above the field, the line under a credential on the Settings page,
the prompt that asks for an account's key, and `tade setup` before it asks anybody to paste one —
each of them the same sentence, written once (`KEYS_AND_AGENTS`, with `SEEN_BY_AGENTS` as the clause
a two-line note has room for, in `core/src/secrets.ts`) rather than four wordings that drift. Where
the line is cut at two, Tade's half goes first, because that is the half that may never be the one
cut. The README says it in its own words, being prose and not a drawing, under the first picture and
where it talks about pasting keys — above the features rather than down with install, because it is
the one thing to know before the first agent starts and not a step of setting up.

It carries **the way out in the same breath**, because a warning with nothing to do about it is one
people learn to scroll past: export the variable, which wins over the file and which Tade never
writes down, or leave that extension unset.

And **nothing anywhere may go back to saying the file is one *only you* can read**. Fourteen
sentences across eight files said exactly that, each of them true about the mode and wrong about the
machine, and each read by somebody at the moment they were deciding. Containing an agent is
deliberately not the answer here and is not Tade's to give: what an agent may reach is the harness's
or the agent's own, and approvals are never Tade's to change.

This is also why **Tade does not sandbox anything**, and says so rather than half-owning it. There
was a `sandbox` on every route and on every MCP server — seatbelt on macOS, bwrap on Linux, and the
rule that one which could not be applied failed the run. Every default was `none`, so the promise it
read like was one almost nobody ever got; and what it was containing is a program the person
deliberately handed the machine to. Containment is **the harness's or the agent's** — Codex has its
own `--sandbox` and Tade passes `danger-full-access` because Tade's gate is what decides here — and
a thing Tade half-owns is worse than either end of it, which is the keystore's lesson again. What is
left is what was always doing the work: the approval tiers, the worktree as the policy boundary, and
saying plainly where somebody is deciding that an agent and an MCP server both run as you
(`KEYS_AND_AGENTS`, `SERVER_RUNS_AS_YOU`).

## A DSN is an endpoint, and the token is the credential

`telemetry.dsn` is an ordinary string in `config.yaml`, drawn as itself: Sentry publishes a DSN in
the JavaScript of every page it watches, and all one grants is the right to send events to one
project. Marked `secret` it got the worst of both — bullets in the field, so seventy characters
somebody pasted could not be read back and checked for a typo. `$TADE_TELEMETRY_DSN` is the fallback
*under* the setting and never over it, and the field's own fallback says so: a DSN typed into
Settings is the one that is used, because a setting Tade accepts and ignores is worse than one it
does not have.

What is genuinely a credential — Sentry's auth token, the forge token, an extension's key — is
`kind: 'secret'` and lives in the same file, drawn the same way, with the environment winning over
it. What still separates the two is that nothing wins over a DSN, and that a key is a key.

## Leaving a field saves it; escape is how you throw it away

The Settings page says "Saved as you change it", and every other control keeps that promise the
moment it is pressed — a switch, a radio, an arrow. A field wrote on enter and on nothing else, so
clicking Done, the next setting, another category or the window behind the page dropped what had
been typed and went on saying "Saved" underneath it; with a masked field nothing on screen said so,
which is how a pasted DSN came to look like a value that resets itself.

So every way out of a field but escape writes it — `leavingField`
(`packages/app/src/panels/settings/state.ts`), answered **once** in `settingsClick` rather than in
each of a dozen cases. Nothing is written when nothing changed, and a write that fails leaves the
page open with the reason on it rather than closing over the top of a value that did not save. If
you add a way out of a field, it goes through that one answer.

## A key that is gone

A key that stops being read does not simply leave the schema: people have it written down, and
refusing the file takes away everything else they wrote at the same time. So it is **ignored and
said** — an entry in the `GONE` table in `packages/core/src/gone.ts` (read by `dropGone`), with the
pattern and the sentence that replaced it side by side, so that tidying one away takes the other
with it. `mcp.servers.*.sandbox` and `checks.from_ci` are the examples; `SERVER_RUNS_AS_YOU` and
`CHECKS_ARE_READ` are the sentences.

Never refuse the file, and never leave the key in the schema parsing quietly into nothing — that is
the "accepts and ignores" failure with an extra step.

## Closing a project is not forgetting its work

`tade_project_close` takes `projects.<name>` out of the config and **does nothing else**: the
folder, every commit, branch and worktree, everything in Tade's home and the journal all stay, and
opening the same path again brings all of it back — which is why closing is reversible and is said
so when it happens. There is no tool that removes a worktree, deletes a branch or deletes a folder,
and asking explicitly does not produce one: that is a person with git in a terminal. A project with
an agent still running in it is refused, naming them.

Opening is the same door the picker uses — `openAt` in `packages/app/src/wire/projects.ts`: a
repository Tade has, one on disk it does not, or one that is not there yet, made and `git init`ed
only where it was asked for. It never repoints a project it already has, because moving a root moves
where every agent in it works.

## Writing config

Always edit the YAML **document** (`parseDocument`, `setIn`, `deleteIn`), never `parse` then
`stringify` — that drops every comment in a file somebody wrote by hand. `writeSetting` is the one
path, and it calls `ownerOnly` on every write.

Then: `pnpm check` on its own.
