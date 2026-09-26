---
name: set-up-the-machine
description: What Tade requires of the machine and how setting up proves it — a program declared by whoever needs it, how it got installed and how it moves forward, the wizard and `tade update`, the lane that proves a setup, and the Node floor checked at the door. Use when adding or changing a `programs` declaration or a `HowToInstall`, when `tade setup`, `tade setup --check` or `tade update` says the wrong thing about a machine, when somebody's install fails before Tade starts, or when adding a readiness step.
---

# Setting up the machine

Tade shells out to other people's software — git for everything, tmux to hold a lane, pi or Claude
Code to be an agent, `gh` to find a GitHub credential. **Which programs those are is nobody's list.**
Each port declares what it needs, the declarations are folded in one place, what is on the machine is
read from the machine, what is *current* is asked of the world only when somebody presses the button,
and setting up ends by actually opening a lane — because every other check is a reading of a file.

| Path | What |
|---|---|
| `packages/core/src/programs.ts` | the vocabulary, all pure: `RequiredProgram`, `HowToInstall`, `TADE_PROGRAMS`, `Declared`, `ProgramNeed`, `neededPrograms`, `Install`, `InstallManager`, `ProgramPlace`, `installOf`, `updateWith`, `installWith`, `InstallersHere`, `parseVersion`, `compareVersions`, `isBehind`, `declarationProblems` |
| `packages/core/src/readiness.ts` | `StepId`, `Step`, `ReadinessFacts`, `readiness`, `worksStep`, `isReady`, `nextStep`, `NativeTrouble`, `MissingProgram`, `WantedKey`, `LaneProof` |
| `packages/workbench/src/programs.ts` | the I/O half: `programsNeeded`, `whereIs`, `lookAtPrograms`, `askWhatIsCurrent`, `lookAtTade`, `lookAtUpdates`, `ProgramLook`, `TadeLook`, `UpdateLook`, `tadeRoot` |
| `packages/workbench/src/machine.ts` | `installersHere`, `missingFrom`, `nativeProblems`, `NativeProblem`, `lookAtHarnesses`, `HarnessHere` |
| `packages/workbench/src/prove.ts` | `proveALane`, `ProveOptions` — the one act |
| `packages/cli/src/commands/setup.ts` | the wizard: `ORDER`, `CHANGES_MACHINE`, `doStep`, `--check`, the closing proof |
| `packages/cli/src/commands/setup-facts.ts` | `lookHere`, `gather`, `nativeTroubles`, `Look` — the two depths |
| `packages/cli/src/commands/setup-machine.ts` | `setUpPrograms`, `offerInstall`, `sayNativeTrouble`, `signInSomewhere`, `harnessLines`, `setUpKeys` |
| `packages/cli/src/commands/update.ts` | `tade update`, and `--check` as the only thing that dials |
| `packages/cli/src/bin.ts` | the door: `nodeTooOld` before any other import, then `nativeTrouble` |
| `packages/cli/src/node.ts` | `nodeTooOld`, and the two private halves `numbers` and `below` |
| `packages/cli/src/version.ts` | `needsNode`, `version` — `engines.node`, read back |
| `packages/drivers/{core,pty,tmux}` | `WorkspaceDriver.programs`; the pty driver's `helperAt`/`helperProblem` |
| `packages/harnesses/{core,pi,claude,codex}` | `WorkerAdapter.programs` |
| `packages/forges/{core,github}` | `Forge.programs` |
| `packages/app/src/wire/machine.ts` | the Updates page's actions: check, run a command in a terminal, reload |

## Declaring that something needs a program

1. Put a `RequiredProgram` on the implementation that shells out to it — `programs` on
   `WorkspaceDriver`, `WorkerAdapter` or `Forge`. Not in a list anywhere else: the point of the
   declaration is that a new harness arrives with its own requirement and **no other file changes**.
2. Say all five things. `command` as it is run (`tmux`, `gh`), `title` as a person reads it (`GitHub
   CLI`), `why` as a clause that finishes "it is needed for…", `versionArgs` that make it print its
   version and nothing else, and `optional` where Tade works without it.
3. Add `install` — a `HowToInstall` — only for what you are sure of. See the rules below.
4. Add `at` only where it is **not** looked up on PATH: something that ships with Tade runs the copy
   in Tade's own `node_modules`, and reporting it missing because nothing on PATH answers to its name
   is a lie about the one actually running (pi does this).
5. Run that implementation's conformance suite. `declarationProblems` is asserted by all three
   (`drivers/core`, `harnesses/core`, `forges/core`), so a program nobody can look up or ask is
   caught there.

Declaring **nothing** is an answer: the pty driver needs no program of its own, and says so by
having no `programs`. What Tade itself needs whichever implementations are in use is `TADE_PROGRAMS`
— git and node — declared in `core` because it is a fact about Tade, not about the page that shows it.

## Rules

- **Pure and impure are two files, and the network is a third thing.** `core/src/programs.ts` is the
  vocabulary and the folds: no PATH walk, no clock, no fetch. Looking a program up, asking it its
  version and asking a registry what is current are I/O and live in the workbench. Nothing here is
  ever on a timer.
- **Reading the machine is free and asking the world is not.** `lookAtPrograms` is a PATH lookup and
  one `--version` per program — that is what somebody opening the Updates page or running `tade
  setup` pays for. `askWhatIsCurrent` reaches the network and runs **only** because somebody pressed
  the button or passed `tade update --check`. `lookAtUpdates` is both, behind `ask`.
- **`cannot tell` is a first-class answer, and a guess never is.** A binary somebody dropped on their
  PATH has no manager to ask, so `cannotTell` says so; before anybody has asked, the answer is not
  unknown but *unasked*, and the page says that once at the foot rather than on every line.
  `parseVersion` returns null rather than half a version — `v22.18.0` has a word boundary inside it,
  which is why the pattern is not `\b`.
- **Every program is listed, not only the ones in use.** `programsNeeded` asks every registered
  driver, harness and forge and marks each declaration `inUse`. Whether tmux is installed is what
  somebody wants to know *before* they switch to it. A program only something unused needs is
  `optional` in `missingFrom`, which is also what keeps it from ever being a reason to stop.
- **Asking a question must leave nothing behind.** `programsNeeded` constructs a driver only to read
  its declaration and then `await driver.detach()`s it, because a driver may take a scratch folder for
  its lanes' output. A harness adapter is constructed the same way and does no I/O in its constructor.
- **How a program got here is read off where it is** (`installOf`), never asked of every package
  manager on the machine: asking would mean running four programs to answer one question, and the
  path is what actually decides which of them owns the file. A Cellar, a Caskroom, a global package's
  folder, a version manager's, `/usr/bin`, or nothing anybody claims.
- **A formula is not a cask.** They are two namespaces and are upgraded differently, and the cask
  `claude` is a desktop app while the cask `claude-code` is the agent — so asking about the wrong one
  answers confidently about something else entirely. `Install.brew` carries which it is, `updateWith`
  puts `--cask` in the command, and `brewLatest` passes `--formula`/`--cask` so `brew info` cannot
  answer about whichever it found first.
- **Something inside Tade's own tree is Tade's** (`manager: 'tade'`), and that check comes first
  because it beats everything else: `npm install --global` on it would install a second copy nothing
  would ever run, and asking npm what is newest would answer about a package nothing here runs. It
  moves when Tade moves, and `updateWith` and `askWhatIsCurrent` both say exactly that. `tadeRoot`
  recognises the tree by the CLI under it, not by a name, because the checkout is `tade` and the
  published package is `tade-sh`. `tade` itself is looked up with `within: null`, or it would report
  as shipped with Tade.
- **Nothing installs anything.** The exact command is on the page or on the checklist **before** it
  runs, and running it types that command into a terminal somebody is looking at
  (`watchCommand`, `offerInstall` → `ui.run`). An installer handed the terminal is an installer whose
  output you cannot see and whose questions you cannot answer, because Tade is still holding the
  keyboard. A command that fails says so and the answer is no, never a failure.
- **Only an install this machine could actually run is offered.** `installWith` takes the machine's
  own package manager before a global npm install, and only a manager that is on PATH —
  `installersHere` does one lookup per manager for exactly that. A `brew install` on a machine with
  no Homebrew is a command that fails in a terminal somebody is watching, which is worse than a
  sentence saying where to get it.
- **A program whose package nobody can vouch for declares `instead`.** A command that installs
  something else under the same name is worse than no command at all: `gh` says
  `cli.github.com has the package for your system` rather than offering an apt package that is in
  GitHub's own repository on most releases, and git says `xcode-select --install`, which is where a
  Mac's git comes from. `declarationProblems` refuses an `install` that names nothing to install and
  a `cask` with no `brew` name — the two shapes that read as an offer and are not one.
- **Reloading into a new Tade says what it costs, in the driver's own words.** `wouldStop` reads
  `capabilities.detach` — never the driver's name — and only asks where lanes would not survive;
  the Updates page is handed the same fact as `lanesSurvive`. A reload counts the terminals as well
  as the agents, because a close leaves those running and a reload does not. What survives it either
  way is the work itself: worktrees, branches, the journal, queued work and schedules are all on
  disk, which is what makes the question answerable at all.

## Setting up ends with a lane

Everything else `tade setup` does is a reading of a file, so it can find git, find a model, write a
config and say "all set" about a machine where no agent can ever start. `posix_spawnp failed.` at the
first lane is what that looks like from the outside.

So it finishes by opening a lane with the **configured** driver, running a command in it, reading
what came back and closing it — `proveALane`, in the workbench. The configured one, because which
driver it is, is the choice that can be wrong. `tade setup --check` does the same, because that is
the one somebody runs when they are not sure, and it is the only part of either that proves the
machine rather than reading it.

- **It never throws.** A driver that cannot open a lane is the thing being asked about, not an error
  in the asking, so every path out is one sentence — the driver's own `available()` reason, an exit
  code with the first line of what was printed, a deadline that passed, or an id that is not a driver
  at all, with the ones that are.
- **The word that comes out is never a word that went in.** `SPELL` assembles `tade-lane-ok` from
  three strings inside the lane, so finding it cannot be a driver echoing the command line back. Both
  the bytes and `capture` are searched, because a driver that renders into a terminal of its own has
  to be read the way the window reads it.
- **It closes its own lane and then `detach`s, never `shutdown`s.** Under tmux the lanes of one home
  share a session, and shutting the driver down would kill it: proving that a lane can open must
  never end every agent working in that checkout. Closing the one lane it opened is what leaves
  nothing behind; letting go is what leaves everybody else's work running. Both are in the `finally`.
- **The lane id is unique per run** (`setup/proof-<random>`), because an id that is taken is a lane
  already running, and setting up must never stand on one of the window's.
- **It is deliberately not a readiness step.** `readiness()` is a pure fold over facts and the window
  runs it on every open (`app.ts`) to decide whether to lead somebody through setup — that has to
  cost nothing. This is an *act*. So it is `worksStep(proof)`, appended to the list by whoever ran
  it, and a null proof reads as `not tried yet`.

**The two native modules come first for the same reason the proof comes last.** Every question in
between is answered by running something — a sign-in, an installer, a download — and node-pty is what
runs it. So `native` is the first step in `ORDER` and in `readiness()`, and a blocking one stops the
wizard with "Nothing else can be set up until that is fixed: all of it runs in a lane." Which is also
why the fix for a helper whose permission bit is wrong is **said and never run**: the fix would have
to be spawned through the thing that is broken, so `sayNativeTrouble` hands over two commands and
waits to be told they have been read.

`nativeProblems` asks the **pty driver** about node-pty, whichever driver is configured — node-pty is
what Tade opens every lane with either way, and the driver is the one thing that can say whether its
helper can be run. better-sqlite3 is only `require`d, from the package that declares it, and is never
blocking: the journal is a file and works without the index it builds. What did not load *at all*
never reaches here — `bin.ts` has already said so.

### The two depths in `setup-facts.ts`

`gather()` is config, a file or two and no process, because the window asks it on every open.
`lookHere()` is everything that spawns or walks PATH, and it is the wizard's and `--check`'s; it is
handed back into each step so a step that changed the machine is answered by **looking again**
(`CHANGES_MACHINE`) rather than by guessing what changed. `lookHere` never throws: a machine where
nothing can be asked is a machine somebody is still trying to set up, and an empty answer that says
so beats a stack trace in place of the first screen.

## A Node that cannot run Tade is turned away at the door

`engines` is a warning npm prints once and installs over. What came next was a `TypeError` out of the
middle of execa — `TEXT_ENCODINGS.union is not a function` — naming a file the person does not have
and no Node version anywhere at all.

So `bin.ts` checks `nodeTooOld(process.versions.node, needsNode(), process.execPath)` **before it
loads anything**. The only two imports above that line are `./node.ts` and `./version.ts`, each a
file with no dependency of its own, because a static import is evaluated before any statement in the
file — so anything imported there is code running before the check that says whether this Node can
run it. Everything else is reached through a dynamic `import()` inside `load()`.

- **The floor is `engines.node`, read back** (`needsNode`). Two numbers drift, and the one that
  drifts is the one nobody runs. It is the same manifest `version()` reads, three levels up, which
  is the same three in a checkout and in the published package.
- **It may only ever stop somebody**, so it is narrow on purpose. It reads `>=x.y.z` and nothing
  else: a range this half-understood is a refusal it cannot justify, and refusing wrongly is worse
  here than not refusing at all — the person would at least have got an error with a cause in it.
- **It compares as numbers.** 22.9 is above 22.19 only in a dictionary. A missing part is a zero, so
  `>=22.19` means `22.19.0`.
- **A manifest it cannot read is no answer, not a refusal.** `needsNode` catches and returns null,
  which is exactly what happened before any of this existed. Reading the version for an issue report
  is `version()`'s business, and there it is still a throw.
- **What it says is the whole of the error**: the floor, this Node, the executable path, why it is
  not a preference (Tade runs TypeScript with no build step, which is how
  `~/.tade/extensions` are loaded), and four ways to get a newer one.

A dependency that did not load at all is the other half of the same door and is `nativeTrouble`'s;
what it says and why is in `cut-a-release`, under what a user's install runs.

## Steps

**A new program requirement.** The five fields, on the implementation that runs it, plus an `install`
you are sure of. Then its conformance suite, and `tade update` and `tade setup --check` to see the
row. Nothing else: `programsNeeded` walks the registries.

**A new package manager or version manager.** `InstallManager` in `core/src/programs.ts`, then the
recognition in `installOf` (off the path — `packageManagerOf` for the global-package kinds, a path
fragment otherwise), then `updateWith`, which must answer with a command or with a `cannot` that says
who owns it. If it can be asked what is current, `askWhatIsCurrent`; if it cannot, that is a
`cannot`, which is an answer. Add it to `MANAGERS` in `machine.ts` only if it is something
`installWith` should *offer*, and only in the order that prefers the system's own over a global npm
install.

**A new readiness step.** `StepId` and one builder in `core/src/readiness.ts` (pure, and the order
in that array is the order), the fact it reads on `ReadinessFacts` — optional, so that the cheap
`gather()` can leave it absent and every step reads absent as nothing to do — then `ORDER` and
`doStep` in `setup.ts`, and `CHANGES_MACHINE` if answering it changes the machine rather than the
config. Do not make it an act: if it has to *run* something, it belongs where `worksStep` is.

**A new native dependency.** `NATIVE` in `packages/cli/src/native.ts` so a load failure is a
sentence, `nativeProblems` in `machine.ts` so a half-installed one is a checklist row with
`blocking` answered honestly, and `pnpm.onlyBuiltDependencies` in the root manifest — which the
published manifest carries. Whether its install needs a script of its own is `cut-a-release`'s
question, and the answer has so far always been no.

**Anything drawn.** The Updates page and the reload panel are the window's: `change-the-window`, and
`redraw-the-pictures` if it changes what a picture shows.

Then: `pnpm check` **on its own** — the suite spawns real git, real PTYs and real processes with
short timeouts, and anything CPU-heavy beside it starves them into what looks exactly like a
regression. `tade setup --check` on this machine is the other half, because it is the only one that
opens a lane.
