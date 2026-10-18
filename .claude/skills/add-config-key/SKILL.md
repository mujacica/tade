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
| `packages/core/src/config.ts` | `ConfigSchema` and the schemas it is made of: the half that grows with every key |
| `packages/core/src/config-file.ts` | the file it is read from and written to: `parseConfig`, `loadConfig`, `writeSetting`, `ownerOnly` |
| `packages/core/src/settings.ts` | `settingsOf`, `parseSetting`, `findableBy`, `settingLabel`, `SettingKind`, the Keys and tokens group |
| `packages/core/src/settings-projects.ts` | the one `projects` group: every row of it one project's, by `scope` |
| `packages/core/src/settings-keep.ts` | the Journal group — what Tade keeps and lets go: `journal.max_mb`, `documents.keep_days`, `notes.keep_days` |
| `packages/core/src/settings-queue.ts` | the Queue group — who decides what was held: `queue.holds` |
| `packages/core/src/settings-models.ts` | the Models group — what new agents start on: each route's model, thinking and harness, and each other harness's model and thinking under it |
| `packages/core/src/reach.ts` | `settingReach`, `Reach`, the `NEVER` table, `OPEN`, `OPEN_UNDER`, `ALLOWED_UNDER`, `namedBy`, `wordsFor`, `WATCH_REACH`, `watchNamedBy`, `LINES_LOOKED_BACK` |
| `packages/core/src/carry.ts` | `carryOf` — what another machine's Tade is given of each key — `leavesOf`, `carryDecision`, `changedThere`, `HOME_HOLDS`, `KEYS_TO_REMOTE`; `carry-files.ts` for the personas and templates |
| `packages/core/src/project.ts` | what one project answers for itself: `workspaceFor`, `pushFor`, `PUSH_MODES`, `pushProblems` |
| `packages/core/src/secrets.ts` | a credential: `findSecret`, `secretPath`, `secretCommand`, `IN_CONFIG`, `KEYS_AND_AGENTS`, `SEEN_BY_AGENTS` |
| `packages/core/src/gone.ts` | keys that are gone: the `GONE` table, `dropGone`, `SERVER_RUNS_AS_YOU`, `SERVER_HELD_BY_NOTHING`, `CHECKS_ARE_READ` |
| `packages/app/src/wire/settings.ts` | the page's one write, `config_changed`, `held` (a credential said as `set` / `not set`) |
| `packages/app/src/wire/setting-tools.ts` | where reach is *enforced*: `tade_settings`' listing and `askedSetting`, the boundary asked before the row |
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
- A value that ends up inside another program's config or a request — a host name in a Caddy site
  block, a certificate, a passkey's relying party — is refused at the schema for anything that is
  not its shape, rather than escaped where it is used: `surfaces.web.public` is a name and only a
  name (`publicName`), so no scheme, port, path or address can arrive by it. A name that is refused
  for a reason rather than a shape is refused the same way, with the reason as the message —
  `tade.sh` and the names under it (`refusedName`) — so the field, the CLI and `tade config --check`
  all say it.
- **A row may write a second key on the same press** where the person's one act means both, and
  only then, and each key gets its own `config_changed` line. Never a key the row does not say it
  writes. **Never a copy of the value into a key that outlives it**: Public name once added the name
  to `trusted_hosts`, which already trusted it on its own and kept trusting it after it changed. Now
  it writes the name alone and takes back those copies (`copiedHosts`, `core/src/public-name.ts`),
  which the journal tells from a name somebody put there.
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
   a `kind` (`choice`, `flag`, `number` with a `unit` — `fraction` for a share of something, and
   whether it takes decimals is read from its schema (`withDecimals`, `settings-numbers.ts`) —
   `text` (`pairs` for `a=b, c=d`, `list` for a key the schema holds as a list — without it every
   save is refused, `expected array, received string`), `hours`, `key`, `model`), and
   `live: false` if it is only read when Tade starts — the panel labels it *on restart*.
   - Name the group and the setting the words somebody would search for, and put the rest in
     `keywords`: the panel's search reads `findableBy`, which is the title, the `means`, the key
     itself and those words. A setting nobody can find is a setting nobody has.
   - A credential is not a setting you write here: an extension declares it (`kind: 'secret'` on its
     own setting declaration, `packages/extensions/core/src/port.ts`) and Settings › Keys and tokens
     draws a row per declared one. See *A credential is a setting* below.
5. Decide how far the orchestrator's arm reaches into it — `settingReach` in
   `packages/core/src/reach.ts`. See the section below; a whole new *section* of the schema fails
   `packages/core/test/reach.test.ts` until somebody has decided which side of the line it is on.
6. Decide whether it goes to a remote this machine is an owner of — `carryOf` in
   `packages/core/src/carry.ts`, beside `settingReach` and for the same reason. See *What a remote is
   given* below; a whole new section is this machine's own until it is named there, and
   `packages/core/test/carry.test.ts` fails until somebody has.
7. Its `means` sentence is its documentation. The README shows config only for setting up something
   people cannot start without (an extension's organization, say).
8. `pnpm check`.

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
`core/src/reach.ts`) and **enforced in the window** (`packages/app/src/wire/setting-tools.ts`), never in
the tool: a rule that lives where the model lives is a rule the model can be talked out of.

Three answers and no fourth:

- **`never`** is everything that widens what an agent may do, hands a third party tools or a
  credential, changes who is asked, or changes where Tade sends something — `approvals`, `accounts`
  (adding, removing, signing in and every key), a route's `provider` and the orchestrator's own, the whole of `extensions`
  and `mcp`, `orchestrator.extensions`, `telemetry.dsn`, a project's `root`, and the whole of `remotes` (another
  machine this one drives, with a session that is your keyboard there: `core/src/remotes.ts`, written
  only by `tade remote add`). Each is a **subtree** and not
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
  **And `open` is also what a paired phone may change** where `surfaces.web.settings` is on
  (`awayReach`, `packages/web/src/configuring.ts`): a key added to the tier is reachable from away
  the day it is added, so `SETTINGS_FROM_AWAY`'s list moves in the same commit —
  `packages/web/test/configuring.test.ts` holds the two together. `asked` and `never` are never
  reachable from a device; that is argued in `configuring.ts`.

**Which account new agents run as is a default too, among the accounts that exist.**
`workers.accounts.<harness>` (the machine's) and `projects.<name>.accounts.<harness>` (one
project's, which wins for it — `default` there is the harness's own sign-in) are `asked`: the person
decided on 2026-10-17 that they and the orchestrator switch between a personal and a company
subscription, project by project. Every value is an account they added and signed in themselves —
the schema refuses any other name and the row offers no other — so a switch hands nobody a
credential and sends nothing anywhere new; it moves the next agent between two plans of theirs, and
never one already working. What makes a sign-in stays `never`: the `accounts` subtree. A line names
an account row only by the harness and the word together ("the claude code account"), never by
`accounts` or the harness alone (`wordsTogether`). **One reader**: `accountFor`
(`core/src/project.ts`), beside `workspaceFor`; the workbench, the plan a start would spend and the
Accounts page all go through it, and `signInUse` says who runs as each sign-in for the surfaces that
list them. **The orchestrator's own is `asked` too** (`orchestrator.account`, decided 2026-10-18 with
a running agent's, `tade_agent_account`): named only as "your account" (`OWNED_ROWS`), since "account"
alone is every agent row's word; read through `orchestratorAccount`; cleared with its harness
(`clearedByHarness`); and a change starts it again on that sign-in with its conversation carried
(`carryHere`) — at once for a person's press, after the turn that asked where it asked (`moveAccount`).

**What a harness's own sign-in is called is a label beside them** (`workers.default_names.<h>`,
decided 2026-10-18): `asked` by sitting outside the `accounts` subtree, since naming one signs nothing
in, and named only by the harness with a naming word (`DEFAULT_NAME_ROW`, `NAMING`). The name works
wherever an account is chosen — `workers.accounts`, a project's, `orchestrator.account`,
`tade_agent_account` — and means the own sign-in (`isOwnSignIn`, `signInChosen`, beside
`accountFor`); the schema refuses one an added account of that harness has, and the workbench writes
a choice of it as the own sign-in (`default`, or unset), so naming it again strands nothing.

**Defaults are settings, and where work is sent is not a default.** What new agents start on —
each route's model and thinking, and each other harness's under it
(`workers.routes.<r>.harnesses.<h>.(model|thinking)`) — is `asked` (`ALLOWED_UNDER`): the person
decided the orchestrator changes those defaults when they ask, and a default somebody can ask for
is a row in `settings-models.ts`, or `config/change` refuses it as no setting at all. `provider`,
under a route or under a harness, stays `never`, and so do credentials: "these settings" meant
the defaults, and which provider a route sends work to is a separate, standing rule, not one more
default. A model row writes its own key alone — as `provider/id` where the harness names a model
that way — so the default route, which sets no provider, is given a model with nothing written
beside it; what the name picks there is said in `ALLOWED_UNDER`'s comment. Where a route still
keeps a `provider` and the model chosen is another provider's, pi would make a model up under the
kept one's name, so the person's press clears that provider with it and says so, a line each
(`providerBeside`); the orchestrator asking the same is refused with the `never` clause before its
words are looked for. The orchestrator's own `provider` is `never` the same way, and its `Model` row
writes it beside the model, so a model that would move it — another provider's, or a bare name,
which clears it — is refused at both doors that write it, `tade_setting_change` and
`tade_orchestrator_model` (`ownProviderMoved`). A pair that already disagrees in the file starts
new agents on the model alone where the harness offers it, said once a window (`startingModel`).

Two consequences when you add a key:

- The other half of the `asked` decision is whether a person can *say* the setting's name. The check
  is `namedBy`, which reads the setting's path, its title as a phrase, its `keywords` and its path
  segments (`wordsFor`) — so `keywords` that are the words somebody would actually say is what keeps
  a legitimate request from being refused. It is the same list the panel's search reads, so this
  costs nothing extra. A segment every row of its kind shares names none of them: a section, a
  project's name, a scope, and every word of a route's row, which a line names only by the route's
  or the harness's name *with* the setting's (`wordsTogether`) — "switch the model" names no
  route's model, "make the default thinking high" names one row. A title counts on its own unless
  it is only the kind of setting it is: the orchestrator's own `Model`, `Thinking` and `Harness`
  need whose said in front (`OWNED_ROWS`, "your model"), and their `keywords` only find them on
  the panel, so a row whose title is that bare goes there too.
- Every change writes `config_changed` — the path, what it was, what it is now, who asked, and their
  words — because a change nobody watched has to be one somebody can find and undo. A credential is
  said there as `set` or `not set` (`held` in `wire/settings.ts`) and is never read back by any tool,
  the way it is never in the journal anywhere else. A line the journal would not take is said in the
  conversation, never dropped: a carried one without it reads to the next carry as changed here.

One thing decided here is **not a config key at all** — a watch, which lives in `schedules.jsonl`
(`WATCH_REACH`, `watchNamedBy`). It is in `reach.ts` because the question is the same question, and
answering it somewhere else is how two answers to it come to exist. `extensions.*.enabled` is
`never` because turning an extension on imports somebody's code and hands its tools to every agent;
a watch inside an extension already on widens nothing an agent may do, so it is `asked`. What
`WATCH_REACH` does *not* hold is the queue's own pause and remove, and that is said in
`WATCH_REACH` rather than papered over.

## What a remote is given of this machine

Somebody who set this Tade up should not have to set up the one on their server again, so
`tade remote add` carries it there and the window keeps it in step (`@tade/workbench/carry`, over
the owner's `POST /api/carry`, `@tade/web`'s `carried.ts`). What travels is decided per key, in one
place — `carryOf`, beside `settingReach` — and per kind of thing a home holds (`HOME_HOLDS`), which
is what the checklist at the end of `tade remote add` and Settings › Remotes read:

| What the home holds | Becomes | How |
|---|---|---|
| ordinary preferences — commit and push rules, instructions, the orchestrator and routes, accounts and which one agents use, approvals, the checks' rules, queue, notes, documents, prices, the window's sizes, editor and keys, search, the talk key, telemetry's switches, which extensions are on and their other settings — and the **attention** settings | **(a) carried, and kept in step** | `kept`: written there through that machine's `Settings.writeKey`, read back and applied, one `config_changed` each with `carried` and the device; again when a link comes up, when the config moves here, and hourly |
| the **personas** you wrote, the **templates** you published | **(a) carried** | `carry-files.ts`: a persona is a preference; a published version is the same file there or none, never rewritten |
| **keys** — any leaf named `key`, `token`, `secret` or `password`, and any an extension declared — **MCP servers**, the **telemetry DSN**, **intake**'s sources and grants | **(b) on one press** | `pressed`: sent as digests until the press, so that machine can say which it already has; `KEYS_TO_REMOTE` said where the press is; written `0600` there; `remote_carried` here and `config_changed` there, neither ever the value |
| each harness's **sign-in** — Claude Code, Codex, pi | **(c) never copied: guided** | `ssh -t <host> tade accounts sign-in <harness>`, the harness's own headless sign-in, in a terminal the person types into, from `tade remote add` or Settings › Remotes; that machine answers whether each is signed in and until when, and never more |
| **projects**, `workspace` and `drivers`, `agents.workspace`, `keep_awake` and `give_way`, `remotes`, the GitHub App and the Slack app's client made for this machine's public name (`extensions.intake.github_app_*`, `extensions.intake.slack_client_*`), the whole away view (`surfaces.web`), voice hardware (`stt`, `mic`, `speak`, `muted`), `telemetry.environment`, `journal`, the machine's daily `budget`, `checks.run_here`/`parallel`/`suites`, `orchestrator.extensions` | **(d) each machine's own** | `here`: refused there whatever arrives, because that machine asks `carryOf` again |

The rules the table stands on:

- **That machine decides, not the one sending.** It asks `carryOf` again for every path, so a path
  that is its own is refused there whatever a Mac sends.
- **Never over a value somebody there changed** (`changedThere`): its last `config_changed` line is
  somebody there, or a carry's line with the file saying otherwise (edited by hand), or no line and
  something written. That is `theirs` — left, said back with its value, and written over only on a
  press of *Send this machine's* (`--ours <path>`). A carried value this machine no longer has is
  taken away there only while it is still exactly the one carried.
- **`never` to the orchestrator is not "never carried".** Approvals, which extensions are on, a
  route's provider and the accounts are the person's own preferences, written by the person's own
  config, and they go with them; what `never` carries on a press is a credential or a grant.
- **What that machine reads only at a start is said as such.** It answers `nextStart` for what is
  there and not in use yet — a row its Settings says is not `live` (a key a row writes beside its own,
  as `<x>.provider` beside a model row, is that row's), one of yours turned on, or an MCP server on
  now or running since it started, because the broker reads `mcp.servers` once (`waitingHere`) —
  written now or since its Tade started by its journal, and the checklist and Settings › Remotes say
  *applies when Tade next starts*. An older Tade says nothing, and so does this.
- **One setting of that machine's own is turned on from here, on a press**: talking to Tade from
  another screen (`TALK_THERE`), without which this machine's tab for its orchestrator takes nothing.
  Every carry's answer says whether it is on, the checklist lists it until it is, and the press —
  `tade remote add`, `tade remote carry --talk`, Settings › Remotes, each after `TALK_TO_REMOTE` —
  is the carry's `talk: true`, an owner's and so no wider than its config over ssh. It is written
  there **once the answer has gone** (`talkHere`), because the listener it came in on is built again
  for it, and it goes in the last body. Only ever on; never a carry by itself, never the orchestrator's.
- **A key is never carried by itself, wherever it is** — the leaf rule catches every credential
  Tade declares today, and a caller that knows of one with another name passes it in (`secret`).
- **Unnamed is `here`**, the safe direction for a key nobody has looked at.

## A key one project answers for itself

Some settings are the machine's answer only until somebody runs two repositories daily, and then
both answers are true at once — `agents.workspace` was one, and being global is what made the
start-time collision check read the wrong project's tree. The shape is always the same, and there
are exactly two files it can go wrong in:

- The key goes on `ProjectConfigSchema` as `.optional()` — never with a default, which would make
  "unset" and "set to the default" different things.
- **One reader, and every call site goes through it**: `checksFor` (`core/src/checks.ts`),
  `workspaceFor`, `pushFor` and `accountFor` (`core/src/project.ts`) are the four there are, and a
  fifth belongs beside them. The bug is never the resolution, it is the site that still reads the global
  — so grep for the global key after you add the override and make sure the only reader left is
  the resolver.
- **A default that depends on another setting goes in the resolver, and then the global carries no
  schema default either.** `agents.push` is the one: what "nobody said" means is a different answer
  in each workspace (`pushDefault` — `branch-and-review` where each agent has a worktree and a branch
  of its own, `never` where they share the project's checkout), so a `.default()` on the schema would
  make a person's deliberate `never` and a file written before any of this existed the same answer.
  Both levels go `.optional()`, the table lives beside `pushFor`, and the Settings row offers `''`
  with the two defaults as its `fallback` (`PUSH_BY_DEFAULT`) so empty reads as an answer. The bound
  on this shape is the next bullet: a default may answer with more than the file said only where the
  *more* is bounded to that agent's own work — `pushDefault` cannot reach a shared branch, because
  the `checkout` answer is `never`.
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
- Add it to the one `projects` group (`settings-projects.ts`) with `value: project.<key> ?? ''`,
  `fallback: config.<the global>` and **`scope: name`**, and put `''` first in a `choice` — empty is
  how somebody gives the question back to the machine, and `writeSetting` deletes the key. The
  title names the *setting* and never the project (`Brief`, not `app brief`): the page shows one
  project at a time behind a selector (`SettingGroup.scoped`, which Intake's sources share) and
  says which once, and a list that crosses projects says
  which per row through `settingLabel`. `''` draws as `as all projects do (<fallback>)`, so the
  ordinary answer reads as an answer rather than as an empty circle.
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

**A key that replaces itself declares no variable** — the one kind that does not: Linear's refresh
token (`LINEAR_APP.refresh`) is spent by every refresh and the next one handed over, so one exported
would be good exactly once and then win over the live one in the file for ever. It is written by
the window through `writeKey` each time it turns over (`wire/linear-tokens.ts`, `by: linear
refresh`), said as `set` like any key, and kept on its machine (`carryOf`: two machines refreshing
one token would each spend the other's). Its `means` says why it has no variable, where somebody
would look for one. The access token it buys is never written at all.

**`writeKey` hands an extension's key to the extensions** (`reconfigure`) as `write` does from the
page, so a key a connect page keeps is read on the next look rather than after a restart.

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
and asking explicitly does not produce one: that is a person with git in a terminal.

**An agent still working in it is not a reason to refuse, and it used to be.** Closing is about what
Tade lists, and an agent at work is not a listing — the same argument `detach()` is, which closes
the whole window over agents that go on working. What the refusal reliably did was make the `×` on a
project's tab do nothing on every project anybody was working in, because a project worth closing is
one somebody has been working in. So nothing is stopped: the lanes keep their pids and their specs,
the registry never forgets a live one, the task files stay, and opening the path again brings every
agent back under its tab. What is **said** is which agents those are — in the answer, in the notice
and in the Close item's note — because until that path is open again nothing here draws them.

Opening is the same door the picker uses — `openAt` in `packages/app/src/wire/projects.ts`: a
repository Tade has, one on disk it does not, or one that is not there yet, made and `git init`ed
only where it was asked for. It never repoints a project it already has, because moving a root moves
where every agent in it works.

## Writing config

Always edit the YAML **document** (`parseDocument`, `setIn`, `deleteIn`), never `parse` then
`stringify` — that drops every comment in a file somebody wrote by hand. `writeSetting` is the one
path, and it calls `ownerOnly` on every write.

**From a terminal, never `writeSetting` alone**: `writeFromShell` (or `heldIn` then
`recordFromShell`, where the command reads the file back first) in `cli/src/config-write.ts`, which
writes `config_changed` `by: cli` through `changeOf` — a key as `set` or `not set`, a block as
`set`, a list with spaces between — so `copiedHosts` and `changedThere` read it as they read Settings'. The CLI may not append beside
an open window, so the line goes through `recordConfigChanges` (`workbench/src/config-changes.ts`):
folded in at once where nobody holds the home, and otherwise by the window on its beat
(`Settings.fold`) — which also **takes** it, as it takes a change of its own: the config read back
and used, an extension's or a server's as the Extensions page's switch takes one (`Settings.taken`),
so a live setting changed from a terminal is live in an open window or `tade serve` too. A change
made to the config as data — `tade setup`'s — is `patchFromShell`, a line per leaf.

**Nowhere else either.** Every writer is one of these, and a new one picks its door rather than
calling `writeSetting` bare:

| Writing from | Door |
|---|---|
| the Settings page, a carry | `Settings.write` / `writeKey` (`app/src/wire/settings.ts`) |
| the window, off the page — a switch, a model, a setup panel, `/settings` | `writeRecorded`, `writeApplied` where something must take it first, `editRecorded` (`app/src/wire/config-written.ts`) |
| the workbench — accounts, an account's key | `keptIn` then `recordKept` (`workbench/src/config-kept.ts`) |
| a process at startup that may not hold the journal | `changeOf` into `recordConfigChanges` (the extension-folder move, `by: tade`) |

Every one says a key as `set` or `not set` (`heldSays`, `core/src/secrets.ts`), a carry's included,
and never how long it is: the terminal, `writeKey` and a carry once counted its characters, which
says something about a secret and wrote the same key two ways. `changeOf`
(`config-changes.ts`) is the one rule for those lines: no line for a key written as it was, a
credential by its leaf name or `secret`, a block as `set`. `by` is whoever asked — `window`,
`orchestrator` (pass it down: `Settings.write(…, 'orchestrator', said)`), `cli`, `tade`.

**No act writes a default on its side.** Switching one agent's model or thinking — the orchestrator's
`tade_agent_model`, the pane's picker — moves that agent alone and writes nothing under
`workers.routes`, and its answer says new agents keep the project's default, which is a setting.
It once kept the choice on the route for new agents, which was a config write nobody asked
`tade_setting_change` for and had to be held to `settingReach` at a door of its own; the person
decided a switch is one agent and a default is changed where defaults are. A new act that seems to
want a default changed beside it is two acts: do the one asked for, and say which row the other is.

Then: `pnpm check` on its own.
