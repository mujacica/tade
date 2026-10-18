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
| `packages/cli/src/commands/host.ts` | `tade host service`: the command, and asking in a terminal |
| `packages/cli/src/commands/host-service.ts` | what it and setup's server step share: `unitHere`, `offerUnit`, `offerLinger`, `setUpUnattended`, `lanesWouldStop` |
| `packages/core/src/service.ts` | pure: `serviceUnit`, `SERVICE`, `START`, `LOG` — the user unit, as text; `execOf`, `unitTrouble` — a unit that is there, read back; `serviceStateOf`, `serviceTrouble` — how it stands |
| `packages/cli/src/notify.ts` | `tade serve` telling systemd it is ready and stopping: `takeNotifySocket`, `notifier` |
| `packages/cli/src/commands/host-caddy.ts` | `tade host caddy`: `caddySaid` (the steps beside the block), `lookAtPublic` (`--check`) |
| `packages/core/src/public-listener.ts` | pure: `PUBLIC_DIR`, `publicSocket`, `publicName`, `publicDirProblem`, `publicDirCommand`, `caddySite`, `certificateSays`, `outdatedSays` |
| `packages/workbench/src/certificate.ts` | `lookAtCertificate` — one TLS handshake to a name, what a phone would get |
| `packages/core/src/domain.ts` | pure: `domainSays`, `domainHead`, `DomainSeen`, `caaRecord`, `refusedName` (`TADE_SH_IS_THE_INSTALLER`), `publicAddresses` |
| `packages/core/src/public-name.ts` | pure: `publicWrite`, `loopbackWrite`, `copiedHosts` — the name written alone, `trusted_hosts` for a loopback Caddy, and which trusted hostnames Tade itself copied there |
| `packages/workbench/src/domain.ts` | `lookAtDomain` — the zone's servers and a public resolver asked for each record, 443 here, the certificate, `caddyAccount` |
| `packages/workbench/src/dns.ts` | `ask` — one question over UDP with a deadline, the bits `node:dns` cannot set; `keyTag`, `dsOf` |
| `packages/cli/src/commands/host-domain.ts` | `tade host domain`: `domainPrinted`, `domainRefused`, `writeTrusted` |
| `packages/core/src/backup.ts` | pure: `RESTIC`, `LEFT_OUT` (what a backup leaves out, each with why), `backupPaths`, `resticBackup`, `backupSaid`, `snapshotsSaid`, `manifestOf`, `passwordFor`, `shownRepository`, `BackupConfigSchema` (`backup.*`) |
| `packages/workbench/src/backup.ts` | `recordsFolders`/`recordsHere` (each harness's `records()`), `notPushed`, `backUp`, `snapshotsIn`, `initRepository`, `restoreInto`, `restoreTo`, `cutTornTail` |
| `packages/cli/src/commands/host-backup.ts` | `tade host backup` and `tade host restore`: `takeBackup`, `initBackup`, `listBackups`, `restoreBackup`, `offerTimer` (`backupUnits`, in `core/src/service.ts`), `resticHere` |
| `packages/cli/src/commands/host-upgrade.ts` | `tade host upgrade`: `upgradeHere` over an `UpgradePlace`, `goingBack`, `unitStarts` |
| `packages/workbench/src/upgrade.ts` | `openedAs` (which Tade holds the home, out of the journal's `tade_opened`), `startsAs` (whether the Tade on disk starts) |
| `packages/app/src/wire/web-domain.ts`, `panels/settings/domain.ts` | the same look under the Public name row in Settings › Away view |
| `packages/workbench/src/machine.ts` (`unattendedHere`, `systemdHere`, `serviceUnitPath`, `lookAtService`) | whether this is a server, linger, the unit and what it runs — files, no process — and how the service stands, one `systemctl show` |
| `packages/harnesses/core/src/sign-in.ts` | `signInHere` (is a browser here?), `signInLasts` (how long a sign-in has left) |
| `packages/drivers/tmux/src/scope.ts` | the lanes' tmux server in a systemd scope of its own, under a user service |
| `packages/cli/src/commands/update.ts` | `tade update`, and `--check` as the only thing that dials |
| `packages/cli/src/bin.ts` | the door: `nodeTooOld` before any other import, then `nativeTrouble` |
| `packages/cli/src/node.ts` | `nodeTooOld`, and the two private halves `numbers` and `below` |
| `packages/cli/src/version.ts` | `needsNode`, `version` — `engines.node`, read back |
| `packages/drivers/{core,pty,tmux}` | `WorkspaceDriver.programs`; the pty driver's `helperAt`/`helperProblem` |
| `packages/harnesses/{core,pi,claude,codex}` | `WorkerAdapter.programs` |
| `packages/forges/{core,github}` | `Forge.programs` |
| `packages/app/src/wire/machine.ts` | the accounts, and `watched`: the terminal a command runs in, put in front first |
| `packages/app/src/wire/updates.ts` | the Updates subject: the page's buttons, the check on a clock, the strip's chip, `run` (the one way an update runs), the reload offer, and `tools()` for the orchestrator |
| `packages/app/src/updates.ts` | pure: `behindIn`, `stepsNamed`, `typedFor`, `endedIn`, `failureLines`, `outcomeSays` |
| `packages/workbench/src/programs.ts` (`rememberUpdates`, `lastUpdates`) | the last answer that asked, kept in `<home>/updates.json` |
| `packages/orchestrator/src/{tools,host}-machine.ts` | `tade_updates`, `tade_updates_run`, `tade_reload`, and the `ToolHost` methods behind them |

## Declaring that something needs a program

1. Put a `RequiredProgram` on the implementation that shells out to it — `programs` on
   `WorkspaceDriver`, `WorkerAdapter`, `Forge`, `RemoteLink`, `Transcriber` or `Recorder`. Not in a
   list anywhere else: the point of the declaration is that a new harness arrives with its own
   requirement and **no other file changes**. The speech ports are folded in by whoever has them
   (`voiceDeclared`, handed to `programsNeeded`/`lookAtUpdates` as `also` by the CLI), because
   `@tade/voice-core`'s manifest names the workbench and walking them from there is a cycle.
2. Say all five things. `command` as it is run (`tmux`, `gh`), `title` as a person reads it (`GitHub
   CLI`), `why` as a clause that finishes "it is needed for…", `versionArgs` that make it print its
   version and nothing else, and `optional` where Tade works without it.
3. Add `install` — a `HowToInstall` — only for what you are sure of. See the rules below.
4. Add `at` only where it is **not** looked up on PATH: something that ships with Tade runs the copy
   in Tade's own `node_modules`, and reporting it missing because nothing on PATH answers to its name
   is a lie about the one actually running (pi does this).
5. Add `oldest` where an older version does not work, and make it **the same constant** the
   implementation refuses below — the tmux driver declares `OLDEST`, which its `available()` reads.
   Without it the Programs list ticked `✓ tmux 3.1` beside a workspace step calling it too old.
6. Run that implementation's conformance suite. `declarationProblems` is asserted by every port's
   (`drivers/core`, `harnesses/core`, `forges/core`, `voice/core`), so a program nobody can look up
   or ask — or one with a Homebrew line and nothing for Linux — is caught there.

Declaring **nothing** is an answer: the pty driver needs no program of its own, and says so by
having no `programs`. What Tade itself needs whichever implementations are in use is `TADE_PROGRAMS`
— git and node — declared in `core` because it is a fact about Tade, not about the page that shows it.
Status is Tade too, not a port, so what one of its looks runs is declared beside that run and folded
in under Tade by `programsNeeded`: `PROCESSES_PROGRAMS` (`ps`, `status/src/processes.ts`) and
`PORTS_PROGRAMS` (`lsof`, and the same `ps` with its own reason, `status/src/ports.ts`).

## Rules

- **Pure and impure are two files, and the network is a third thing.** `core/src/programs.ts` is the
  vocabulary and the folds: no PATH walk, no clock, no fetch. Looking a program up, asking it its
  version and asking a registry what is current are I/O and live in the workbench, and none of it
  is on a timer of its own.
- **Reading the machine is free and asking the world is not.** `lookAtPrograms` is a PATH lookup and
  one `--version` per program — that is what somebody opening the Updates page or running `tade
  setup` pays for. `askWhatIsCurrent` reaches the network, and runs when somebody presses the button,
  passes `tade update --check`, asks the orchestrator, or when the **window's clock** says the last
  answer is older than `surfaces.window.check_updates` (daily by default; `never` is off). `lookAtUpdates`
  is both, behind `ask`.
- **The clock is the window's, and only a real window has one.** `Updates.beat` asks on the status
  beat, never in a window's first minute, never while a look or a run is going, and an hour after a
  try that failed rather than every beat — and only where the window was handed `AppOptions.updates`,
  which the CLI's window is and a test's is not: a suite may never reach the network it runs on.
  Every answer that asked is kept in `<home>/updates.json` (`rememberUpdates`; one that never asked
  is not, because it would stand in for one that did), so a window that opens draws the chip at once
  from what the last one found.
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
- **A project's own install in its own worktree is not installing a program.** "Nothing installs
  anything" is about the *machine*: a program on PATH that Tade or a port needs, which goes through
  `programs`, the page and a person pressing the button. `pnpm install` in a new worktree is the
  project's code, run where the agent was about to run it anyway, and it is the project's own answer
  to what a worktree needs — so it runs without asking, but the same way: the command shown first,
  in the agent's lane where somebody can watch it, with a deadline, before the agent starts
  (*Preparing a new worktree*, below). What does put a program on the machine is refused there
  rather than run: a devcontainer's `sudo apt-get` or `curl … | sh` is named in `unread`, because a
  container may do that and this machine was never asked to.
- **An update runs one way** (`Updates.run`): the strip's chip, a button on the Updates page and
  `tade_updates_run` all come through it. Each step is the page's exact command typed into the
  `updates` terminal, put in front first, followed by an ending it prints under a tag of its own
  (`typedFor`: `&&`/`||` and a `printf` that assembles the tag, so the line the shell echoes is never
  read as the ending — `proveALane`'s rule). How it ended is read off what that terminal printed
  (`endedIn`), with a deadline per step, a closed terminal read as stopped, and a failure said in the
  conversation with its command and the last of what it printed (`failureLines`). What is current is
  then asked again, and what came of it is told to the orchestrator as news.
- **The chip pressed is the person asking; the orchestrator needs their words.** `UPDATE_REACH` and
  `RELOAD_REACH` (`core/src/reach.ts`) are `asked`: `updateNamedBy` / `reloadNamedBy` over the
  journal's `said` lines, checked in the window, never in the tool. What the model chooses is only
  *which* step, never *what* runs — the command is always the one `updateWith` read off the install.
- **Only an install this machine could actually run is offered.** `installWith` takes the machine's
  own package manager before a global npm install, and only a manager that is on PATH —
  `installersHere` does one lookup per manager for exactly that. A `brew install` on a machine with
  no Homebrew is a command that fails in a terminal somebody is watching, which is worse than a
  sentence saying where to get it.
- **A program whose package nobody can vouch for declares `instead`.** A command that installs
  something else under the same name is worse than no command at all: `gh` says
  `cli.github.com has the package for your system` rather than offering an apt package that is in
  GitHub's own repository on most releases. Fedora's `whisper-cpp` is the library alone and
  Debian's `whisper-cli` is in testing only, so whisper.cpp offers Homebrew and tells Linux the
  upstream build. `declarationProblems` refuses an `install` that names nothing to install and a
  `cask` with no `brew` name — the two shapes that read as an offer and are not one.
- **Every platform gets its own answer, never another's** (`PerPlatform`). `instead` is one clause
  where it is true everywhere, or one per `process.platform` where it is not: git's
  `xcode-select --install` is `{ darwin }` only, because it was said to Linux. `installWith` names
  only managers of this platform in its refusal, never a cask on Linux, and where nothing answers
  for it says `cannot be installed here: nothing says how on Linux`. A `brew` with nothing for
  Linux — no apt, dnf, npm or Linux clause — is refused: a lone brew line is a Mac's answer said
  to every machine.
- **Too old is missing, and is said where missing is.** `missingFrom` lists one below `oldest`
  with `tooOld` beside the one not here, so the checklist, `--check`, the wizard, Settings › Updates
  and `tade update` all say `too old: 3.1, needs 3.2`, never a tick. Its line is `upgradeWith`: the
  manager's own update; on a Mac, for macOS's own copy, the line `installWith` offers beside it.
  A Debian or Ubuntu release keeps its package at the version it shipped, so where apt's is below
  the floor the declaration says so in `aptTooOld` and that clause is the line: apt's ran, succeeded
  and left Ubuntu 22.04's git at 2.34, and Settings › Updates ran it.
- **The system's own copy moves the platform's way** (`updateWith(install, how, machine)`): on a
  Mac with macOS and its command line tools (`Software Update`, a `cannot`), on Linux with the
  distribution's manager — apt's install line, which moves a package that is there to the newest the
  lists have, and `dnf upgrade`, because `dnf install` leaves one that is there alone. Every system
  program on Debian was told `xcode-select --install` before this.
- **A port says what is wrong and never which installer fixes it.** Its `available()`, `probe()`
  and `account()` cannot know whether this is a Mac with Homebrew or a server with apt — `brew
  install tmux` was said on Debian beside setup's apt line. Setup follows the configured driver's
  reason with the Programs list's line for what it declares (`driverNeeds`), harness lines carry
  `HarnessHere.install`, the Accounts surfaces carry `AccountView.install` (the same line, on the
  harness's own row where its program is not here), the speech step and `tade voice` read the voice
  ports' `programs`, and the harness and voice conformance suites refuse a reason naming an
  installer (`namesAnInstaller`).
- **Reloading into a new Tade says what it costs, in the driver's own words.** `wouldStop` reads
  `capabilities.detach` — never the driver's name — and only asks where lanes would not survive;
  the Updates page is handed the same fact as `lanesSurvive`. A reload counts the terminals as well
  as the agents, because a close leaves those running and a reload does not. What survives it either
  way is the work itself: worktrees, branches, the journal, queued work and schedules are all on
  disk, which is what makes the question answerable at all.
- **A run that moved Tade itself offers the reload, and only one that moved it.** Moved is the
  commit or version on disk differing from before the run — a pull that found nothing to pull owes
  no reload. The offer is the reload panel with `updated` (what it moved to, and whether the driver's
  lanes survive), opened only where no other panel is, and the chip says `reload Tade` until it is
  taken. `tade_reload` answers first and reloads half a second later, because the reload ends the
  turn its answer goes to; the orchestrator picks its conversation back up in the new window, by the
  session id that never changes.

## Preparing a new worktree

A worktree is what git tracks and nothing else — no `.env`, no local certificate, no `node_modules`
— and an agent started in a bare one spends its first minutes finding that out. So where a project's
agents work in worktrees (`workspace: worktree`, still never the default), a new one is *prepared*.
The pure half is `packages/core/src/prepare.ts`, the I/O half `packages/workbench/src/prepare.ts`,
and the tests are `packages/core/test/prepare.test.ts` and `packages/workbench/test/prepare.test.ts`,
against real repositories and real processes.

- **Two moments, two acts.** When the worktree is made (`prepareWorktree`, from `createTask`), the
  ignored files the project lists are brought across from its checkout and the setup command is
  read and kept in the task file (`TaskFile.setup`) — a task keeps what it was made with. When its
  first agent starts (`setupBefore`, from `startAgent`), the setup runs in that agent's lane before
  the agent does. Only a **new** agent — an opening instruction and no conversation to come back to
  — because running an install over work an agent has done is the relaunch bug again.
- **Read like the checks are read: narrow only, and name what cannot be read.** `readingOf` believes
  Cursor's `.cursor/worktrees.json` (`setup-worktree-unix`, else `setup-worktree`, a list of
  commands), then a devcontainer's `postCreateCommand`, then the lockfile's package manager
  (`packageManager` in `package.json` over the lockfiles, installing without changing the lockfile)
  — and stops at the first. Everything it cannot place goes in `unread` with why: a script path, an
  object of side-by-side commands, a `${…}` only a container's tooling fills in, two lockfiles and
  no declaration, a command that installs a program. Those land in the journal's `task_created`
  (`prepare_said`). A new source is a new `from…` function with a table case for what it reads
  **and** what it refuses.
- **Files are the ones git ignores, and only those.** `.worktreeinclude` (gitignore patterns) names
  them; `bringFiles` asks git which untracked files match (`ls-files -o -i -x`) and then which of
  those the project itself ignores (`check-ignore`). An untracked file that is not ignored is
  somebody's work in progress and is never handed out; a file the worktree already has is never
  written over; past `MOST_FILES` none are brought, and that is said rather than a partial set.
  Copied by default, so an agent's edit to its `.env` stays its own; `link` symlinks instead.
- **A person's answer is Tade's config, never a file in the repository.**
  `projects.<name>.prepare` (`files`, `link`, `command`, `deadline_minutes`) answers over what is
  read — `command: ''` runs nothing. It is under `projects`, a `never` subtree, and deliberately not
  in `ALLOWED_UNDER`: a setup command runs as you, so the orchestrator never sets one.
- **The setup runs under `setupLine`, said once and written nowhere.** The lane is launched as
  `/bin/sh` running a small Node program (`SETUP_JS`) and then `exec`-ing the agent's own line, so
  the agent is the lane's process exactly as before; the lane's stored spec stays the agent's line
  (the opening instruction's rule), so a relaunch never prepares twice. Node and not `sh`, because
  the deadline has to stop everything the install started and only `setsid` gives it a group of its
  own (`kill(-pid)`) — a shell without job control cannot, and macOS has no `setsid`. ctrl+c skips
  the setup (`trap : INT`, a handler and not an ignore, which would survive `exec` and deafen the
  agent). It always lets the agent start: a failed setup is a fact the agent is told
  (`composeAgentPrompt`'s `setup`, with the log in the task's folder), never a reason not to begin.
- **Ports are derived, never assigned** (`packages/status/src/ports.ts`). A lane's listening ports
  are `lsof` over listening TCP sockets, matched to the lane's process group and its descendants
  from one `ps`; a server that detached to init is nobody's. Two spawns a look, so it is asked for
  (`StatusOptions.ports`, `StatusAsk.ports`) — `tade status` does, once; the window's beat does not
  until something draws them. A look that could not be made leaves `Lane.ports` absent, never `[]`.

## A server with no screen

A Linux box reached over SSH — a VPS — is a first-class home for Tade, and setting one up is the
same `tade setup`. What changes is decided by facts about *this process*, never by a setting:

- **No browser here** is `signInHere(env)`: a session over SSH (`SSH_CONNECTION`/`SSH_TTY`), or
  Linux with neither `DISPLAY` nor `WAYLAND_DISPLAY` — which is also what a service sees. It is
  what every harness's `signIn(here)` is handed (its default, so `tade accounts sign-in` and
  Settings get it too): Claude Code runs the same `claude auth login` and says the link opens
  anywhere and the code comes back; Codex runs `codex login --device-auth`, which is what it says
  to use "on a remote or headless machine"; pi is the same pi, said for pasting back. The
  conformance suite holds all three spellings of `signIn`.
- **How long a sign-in lasts** is `AccountStatus.until`, the harness's own written-down end, drawn
  by `signInLasts`: days, a warning inside Claude Code's own three, and `cannot tell for how long`
  where it wrote none — never nothing, which would read as "for ever". Claude Code is the only one
  that writes one: `claudeAiOauth.refreshTokenExpiresAt` in `.credentials.json` (`login.ts` reads
  the later of it and `expiresAt`, and only the two dates), and only off macOS, where the sign-in
  is in the Keychain and that is not Tade's to open. Codex and pi renew by themselves and keep no
  end date.
- **From the Mac, it is the same sign-in, over the link.** `tade remote add` and Settings › Remotes
  run `ssh -t <host> tade accounts sign-in <harness>` (`RemoteLink.terminal`) in a terminal the
  person types into, for each harness the Mac uses that the server says is not signed in — so it is
  that server's `signInHere` that picks the headless sign-in, and the token lands where that harness
  keeps it there. The server answers a carry with whether each is signed in and `until`, and nothing
  else of what it keeps (`signInsOf`); a harness's login is **never copied** between machines, which
  is the line `add-config-key`'s *What a remote is given* draws.
- **The exact apt line** is `installWith`'s: `apt-get update &&` first, because a fresh box's lists
  are stale and a container's are empty, and `sudo` only where this is not root
  (`InstallersHere.root`). So `offerInstall` runs every line through `/bin/sh -c` — the line that
  runs is the line that was shown, `&&` and all.
- **The server step** (`unattended`) exists only where `unattendedHere()` answers: Linux, systemd as
  init (`/run/systemd/system`, how `sd_booted` asks), no browser. Linger is a file per user under
  `/var/lib/systemd/linger`, and the unit is `~/.config/systemd/user/tade.service` (or under
  `XDG_CONFIG_HOME`), **read for what it runs** (`unitTrouble`): an older Tade's, which ran the
  window in tmux, and one whose Node or Tade is not there any more — a Node upgraded under a version
  manager, which fails every start with nothing but `exit-code` — are each said with the line that
  writes this one. Setting up (`lookHere`, never the window's free `gather`) also asks how the service
  stands (`lookAtService`): the step is done only once it **said it was ready**, and otherwise says
  why in systemd's terms — not running, starting, failing and restarted, never said ready (`timeout`),
  started too often (`start-limit-hit`), or `cannot tell`. It is last, never required, and **setup
  writes the unit but never starts it**: `tade app` runs setup before it opens its home, so a
  service started from setup would take the home from the window waiting on it. `tade host service`
  offers the start, and not while `heldBy` says a window has the home — unless what holds it is the
  service itself (its `MainPID`), which restarting moves onto the unit just written.

### The unit (`tade host service`)

Printed to standard output whole, with everything else on standard error, so `tade host service >
tade.service` is the file; written on a press or with `--write`. What it says, and why each line:

- **`tade serve` itself, `Type=notify`.** Node is systemd's own child, its main process, so
  `Restart=on-failure` restarts a crash and not a stop, and a stop waits for it: no PIDFile, no
  ExecStop, no tmux. It is started — `systemctl start` returns, `active` — only once it says
  `READY=1`, after it holds the home, its away view listens and its signal handlers are on, so a
  Mac's link reaches it the moment the unit is active. It says so through `systemd-notify` (Node has
  no Unix datagram socket), which since systemd 246 waits until the manager has read the line — a
  sender gone before then is a pid the manager can no longer place in the unit — and a child is
  heard only under **`NotifyAccess=all`**. `NOTIFY_SOCKET` is taken out of the environment before
  anything is started, so nothing Tade starts inherits it. On systemd below 246 (RHEL 8's 239) the
  message can be dropped, the start times out and setup says `never said it was ready`.
- **`KillMode=mixed`**: a stop signals Tade alone, which closes the orchestrator and the servers it
  brokers as quitting does; what is left after it is killed. `SyslogIdentifier=tade`, so its log
  (`LOG`, `journalctl --user -u tade.service -f`) reads `tade[pid]:`.
- **The PATH of the shell it was made in**, because a service's own has none of Node, the
  harnesses or an npm prefix — and no key: a key exported in a shell does not reach a service, and
  the unit says so.
- **`StartLimitBurst=5` in 300 s**: a Tade refused its home fails at once, and five of those is a
  reason to stop. The limit counts **every** start, a person's restarts included — six in five
  minutes and `restart` is refused — so `START` runs `reset-failed` before `restart`: somebody
  starting it means now.
- **The agents are not in it.** The tmux driver starts its server in a scope of its own when this
  process is a service of the user's manager (`scope.ts`, `add-workspace-driver`), so stopping,
  restarting or crashing the unit never ends one; `lanesWouldStop` says so, in the driver's own
  `capabilities.detach`, where the configured driver's lanes would die with it.
- **Moving off an older Tade's unit** (the window in tmux) is `tade host service --write` and
  `START`: the reloaded definition has no ExecStop to wait on a main process systemd did not start,
  so the old window is killed rather than closed, once — which a `kill -9` already proves harmless
  — and `tade serve` takes the home and adopts every lane.

### Proving it

No CI runner has a user manager, so this was proved in a container with systemd as its first
process — repeat it after changing any of the above. `packages/cli/test/serve-linked.test.ts`
holds the rest without systemd: the Mac's own ssh link through a real `sshd` to a real `tade
serve` with an agent in tmux, pairing, the projection, `/api/attach`, and a restart it rides.

The box: `docker pull` fails here, so the last one was built from the Ubuntu 22.04 image already on
this laptop (`ghcr.io/getsentry/image-mirror-altinity-clickhouse-server`, `--entrypoint`
overridden), committed as `tade-vps-jammy` — systemd 249, tmux 3.2a: `apt-get install systemd
systemd-sysv dbus dbus-user-session libpam-systemd sudo build-essential python3 tmux git curl
openssh-server`, Node from nodejs.org's tarball (checksummed), a user (uid 1001), run with
`--privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock -p 127.0.0.1:2222:22 --entrypoint
/sbin/init`. Copy the tree in (`git archive HEAD` plus the changed files; a macOS tar leaves `._*`
files: `COPYFILE_DISABLE=1`), `pnpm install --frozen-lockfile --registry=https://registry.npmjs.org`,
and run as the user with `SSH_CONNECTION`, `XDG_RUNTIME_DIR=/run/user/<uid>` and
`DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/<uid>/bus`. **Ubuntu 22.04's own git (2.34) cannot
be a Tade box**: `git worktree list -z` is 2.36, so the status look sees no tasks; the git-core PPA's
git was used. Then: `sudo loginctl enable-linger`; a project and `workspace.driver: tmux`; `tade
setup --check` says what the unit is missing, then names an older Tade's unit and a Node that has
gone; `tade host service --write` (`systemd-analyze --user verify` it); a task file with `start:`
so the service starts the agent (never `docker exec`, which is no unit: kill the lanes' tmux first);
`START`. `systemctl --user restart` returned in 0.7 s with `StatusText=holding … with no screen` and
the away view answering at once; the agent's tmux server is in `tade-lanes-*.scope` and its pid
survived `restart`, `stop` + `start`, a `kill -9` of Tade (systemd restarted it), six `START`s in a
row, and the move off V1's unit with its window holding the home. From the Mac, the ssh link with
`-F` a config naming the box paired as an owner (`tade web pair --owner` there), held its
projection with the agent, attached it (a pty with `TERM=xterm-256color` — the box has no terminfo
for this laptop's Ghostty) and came back on the restarted unit's new epoch with the agent working.

Not proved: systemd below 246, where `systemd-notify` races; a distribution with
`KillUserProcesses=yes`, where a tmux server started from an SSH login — by `tade setup`'s own proof
lane, say — dies at logout; and a sign-in carried through to the end.

### A public name, behind Caddy (`tade host caddy`)

The away view on a name of the person's own is a second listener, on `/run/tade/away.sock`
(`add-away-surface` has why everything on it is public). What the machine must have for it is three
things only a person with root can do, so **Tade says each exactly and does none of them**:

- **The directory** — this user's, Caddy's group's, `2750` and setgid, made by one `tmpfiles.d`
  line (`publicDirCommand`) because `/run` empties at every boot. `/run` and not `/tmp` or the home:
  Caddy's own unit has `PrivateTmp`, and Debian and Ubuntu homes are closed to it. The listener
  refuses a directory that is anything else rather than loosening it.
- **The site block** — on standard output alone, so `tade host caddy | sudo tee -a
  /etc/caddy/Caddyfile` is the whole of adding it: name-bound, `unix//` upstream, `proxy_protocol
  v2`, `Host` untouched. Everything else goes to standard error.
- **The records** — an `A` (an `AAAA` only if IPv6 answers on 443, which Let's Encrypt tries
  first) and, once there is a certificate, a `CAA`. Nothing at the registrar is Tade's:
  `tade host domain` (below) says exactly what to add.

**`--check` and the window look the same way and say the same words**: the directory, whether
anything answers on the socket, the certificate the name answers with (one handshake, read whether
or not it verifies, loud past a sixth of its life — Caddy renews at a third), and whether this Tade
is behind, out of the Updates check's kept answer (`lastUpdates`) — `cannot tell` where nothing
has asked, never *not behind*. The window looks only where it was handed `AppOptions.certificate`
(the CLI's is, a test's never), twice a day, and says what is loud in the strip once
(`web-public.ts`).

Proved in a `node:22` container (Debian 12, Node 22.23) with Caddy 2.11.7's own release binary
running as a `caddy` user: the directory made `2750 you:caddy`, the block exactly as printed under
a `local_certs` global, this tree's away view as `you`. Through Caddy a pairing answered `201` with
the `__Host-` cookie and was recorded from the container's own address — the header's, not the
socket's; the snapshot and the live stream came through; `Host: localhost` never reached Tade; one
address ran out of pairing tries while another still paired; `--check` said the internal CA's
certificate does not verify and exited 1. Not proved: a Let's Encrypt certificate, a real phone,
and `systemd-tmpfiles` itself — the container has no systemd, so the directory was made with
`install -d`.

### The records (`tade host domain`)

The look a person runs on the box before Caddy, and again until every line is right. **Each record
is asked twice** — of the zone's own servers, recursion off, which is what is true now, and of a
public resolver that validates DNSSEC (Cloudflare's, then Google's), which is what everybody else
sees — because *missing* and *not yet visible* are different things to do, and the wait is the
resolver's own countdown (the record's TTL, or the SOA's for a "none"). The machine's own resolver is
never asked: it may be a cache on the box that calls a record visible only here. Then, a line each,
in the order they are done (`domainSays`):

- **A**, against this machine's own public addresses (`publicAddresses`). A box behind NAT has none
  on an interface, and then where the record points is read and said `cannot`, never `wrong`.
- **AAAA** only where 443 answers on IPv6 here (`servesHttps`, a connection from the box itself, so
  it cannot see a cloud firewall); an AAAA where nothing answers is loud, since Let's Encrypt tries
  IPv6 first, unless nothing answers on 443 at all yet — that is Caddy not being up, said as `later`.
- **DNSSEC** before ordering: a validating resolver's SERVFAIL where the same question with checking
  disabled is answered is a broken chain, and the line carries the registrar's DS records and the
  one the zone's own key needs (`dsOf`, SHA-256) — checked against Comcast's `dnssec-failed.org`,
  whose key tag and digest the tests hold. SERVFAIL both ways is unreachable servers, `cannot`.
- **CAA** after the first certificate, because the record names Caddy's account at Let's Encrypt
  (RFC 8657), which exists once it has ordered one. The closest set governs (RFC 8659), so the look
  climbs from the name. A set that keeps Let's Encrypt out is loud before ordering too. Caddy keeps
  its account under `/var/lib/caddy`, which only it can read, so the line says the `sudo` command
  that prints it and `--account <uri>` takes it; without one the record names Let's Encrypt alone.

**`node:dns` cannot do this**: it sets neither recursion off nor checking disabled, and returns
neither the AD bit, nor the response code, nor the SOA of a negative answer. `dns.ts` is the wire
format the look needs, over `node:dgram`, with a deadline on every try, and a server that did not
answer is not asked again in the same look, so a box with no network waits once.

**The name is written on a press and never otherwise** — `publicWrite`, as `surfaces.web.public`
alone — by the command's question, `--write`, or typing it in the Public name row. **Never into
`surfaces.web.trusted_hosts` beside it**: `surfaceOf` trusts the public name on its own, and a copy
outlives the name. Changing or clearing it takes back the copies Tade wrote there until 2026-10-17
(`copiedHosts`, the journal's `config_changed` lines), never a name somebody put there. The one path
that needs a trusted hostname is a Caddy in front of the loopback listener with no public socket
(stage 0): the command offers it, said as that, once the public name is declined (`loopbackWrite`).
The look in the window runs once each time Settings is opened on the row and on **Look again**,
never on a clock, and only where the CLI handed it `AppOptions.domain`. **`tade.sh` and every name
under it are refused at the schema** (`refusedName`), so the field, the CLI and `tade config --check`
give the same reason: it serves the installer.

Proved from this laptop against the real internet: `tade.sh` (Cloudflare, unsigned, a Google Trust
Services certificate), `example.com` (signed, validating, compact denial answering NODATA for a
name that does not exist), `dnssec-failed.org` (the broken chain, its DS worked out exactly). Not
proved: a VPS's own addresses, a real AAAA on 443, Caddy's account file as Caddy writes it, and a
record going from not yet visible to right.

### Backups (`tade host backup`, `tade host restore`)

A backup nobody restored is a hope, so both halves are one feature and have one test
(`workbench/test/backup.test.ts`, against a real restic; CI's `restic` step installs it, and where
it is missing the restore half is skipped and says so in its title).

- **restic does the keeping, Tade says what to keep.** Encrypted, because `config.yaml` holds every
  key; deduplicated, because the journal is tens of megabytes appended to and the harnesses'
  conversations are gigabytes, and hourly costs only what changed; and it speaks every target a
  person names (a folder, `sftp:`, `s3:`, `rest:`). Tade owning an archive format would be the
  half-owned sandbox again. restic is `RESTIC`, folded in under Tade by `programsNeeded`, in use
  once `backup.repository` is set.
- **The whole home, less `LEFT_OUT`** — never a list of what to keep, so a file Tade starts writing
  next month is in the next backup. Each left-out path says why beside it: the index and its WAL
  (built again on open, which also steps round copying a live SQLite file), `worktrees/`, `runs/`,
  the lock, the check slots, mirrors and copies of another machine's documents, the speech model.
  Beside the home go the folders each harness keeps its agents' conversations in
  (`WorkerAdapter.records()`, read off how the adapter was made — its account — never its sign-in),
  where they are there.
- **What is not in it is said every time**: every checkout and worktree with commits on no remote
  or changes not committed (`notPushed`, out of git, never Tade's records), and
  `BRANCHES_ARE_THE_WORK`. Each project's remote goes in the manifest (`backup.json`, renamed into
  the home before restic reads it), so a restore elsewhere prints `git clone <remote> <root>` for
  each checkout that is not there.
- **The repository and the password are `backup.*`, a `never` subtree and `here` to `carryOf`.** The
  repository reaches restic in its environment (`RESTIC_REPOSITORY`), never its command line, and is
  said with any URL password cut out (`shownRepository`). restic's own `RESTIC_PASSWORD`,
  `_FILE` and `_COMMAND` win over `backup.password` (`passwordFor`). `--init <repository>` mints one
  where there is none, prints it once on standard output with `KEEP_THE_PASSWORD`, and writes it
  through `writeFromShell` as a secret, so `config_changed` says `set` and nothing of it.
- **A restore writes over nothing.** Refused while anything holds the home, and where the home has
  a journal (a backup is older than it); a home with only `tade setup`'s config is moved aside as
  `<home>.before-restore-<moment>`. restic restores into a folder beside the home first, so a failed
  restore leaves the home as it was; the home is renamed into place, then each records folder is
  merged into where *this* machine's harness keeps it for the same user — by the config just
  restored — keeping any file of the same name already there, and what nothing placed stays where
  restic put it, said. Every `.jsonl` file gets its torn last line cut (`cutTornTail`): a backup
  taken mid-append holds half a line, and the next line appended to it would be torn too. `--to
  <folder>` lays a snapshot out to look at and moves nothing; `--from <repository>` restores on a
  machine whose config does not say yet, and restic asks for the password itself in a terminal.
- **Hourly is the person's service manager's**: `--timer` prints `tade-backup.service` (a oneshot,
  nice, idle for the disk) and `tade-backup.timer` (hourly, spread ten minutes, `Persistent=`), each
  under where it goes, writes them on a press and offers `BACKUP_START`; refused until a
  repository is named, since a timer failing every hour is noise. A run that could not read a file
  exits 1, so the unit fails loudly.

**Proved** here with restic 0.19.1 (its release binary, checksummed, in a scratch folder): a real
workbench home with a task in a worktree and a note, backed up, deleted with pi's sessions, restored,
and opened again on the same journal with the index built again; a torn line cut; through the
binary, `--init`, a backup, the list, and a restore on a second home given only the repository and
the password. **Not proved**: a remote repository (SFTP to a storage box, S3), the timer under
systemd, restic as old as Ubuntu 22.04's 0.12, a records folder of an agents' user that Tade's user
cannot read (restic's exit 3 is said, file by file), and pi sessions moved by
`PI_CODING_AGENT_SESSION_DIR` or a project's `sessionDir`, which `records()` does not name.

### Upgrading in place (`tade host upgrade`)

The box's Tade moved forward without ending an agent (REMOTE-TADE.md §7.8). Its steps take every
answer of the machine as an argument (`UpgradePlace`), so `cli/test/host-upgrade.test.ts` drives
each state a box can be in.

- **The install's own command**, `updateWith`'s — the line Settings › Updates and `tade update`
  show — run on a press (or `--yes`) through `/bin/sh` in this terminal; from a pipe without `--yes`
  it is said and nothing runs. Where nothing is newer and what holds the home runs what is on disk,
  it is current and does nothing; a checkout ahead of its upstream is current, not a refusal. A
  backup is taken first where `backup.repository` is set (`--no-backup` skips it); one that fails
  stops the upgrade unless somebody presses on, and `--yes` is not that press.
- **Which Tade holds the home is read out of the journal**: `tade_opened` carries the version of
  the Tade that opened (`runningVersion`), and `openedAs` reads the newest one with the holder's
  pid — a running process cannot be asked which files it started from, and after an install the
  files on disk are already the new ones. So a service still on the Tade before an upgrade already
  on disk is restarted without installing anything, and an older Tade that wrote no version is
  `the Tade it opened on`.
- **Before anything is restarted, the new Tade must start**: `startsAs` runs exactly what the unit
  starts (`unitStarts`, its `ExecStart` as far as `serve`), or this CLI, with `--version`. One that
  does not start is said with what it printed and nothing is restarted, with the line that goes back
  where the install's command names a version (`goingBack`: `@latest` with the old version).
- **Only the service is restarted, and only where its lanes outlive it** — `lanesWouldStop`, the
  driver's `capabilities.detach` — with `START`, on its own press. A window somebody has open is
  never restarted from here: it says it runs the old one until its `reload Tade` press. After the
  restart it looks every two seconds, for two minutes, until systemd says ready and the journal
  says which Tade opened and how many lanes it took up again — the proof the agents carried on —
  and says a service that failed, with the way back, or came back as the wrong version.

- **The Mac says when a remote's Tade is behind its own** (`versusHere`, `machine-there.ts`): the
  version each remote says it runs (`/api/machine`) against this window's `runningVersion`, as
  numbers. Settings › Remotes says `behind this Mac’s 0.2.4` (or `ahead of`) on its Tade line, and
  under it offers **Upgrade Tade there** where the link is up and it is behind this one or its own
  check says a newer is out; the press runs that machine's `tade host upgrade` in a terminal over
  the link (`RemoteLink.terminal`), pressed there as at its keyboard, and the link comes back on
  the restarted Tade by itself. Behind is said in the strip once per pair of versions
  (`Remotes.sayBehind`), and again only once either moves.

**Not proved**: a real upgrade from npm under systemd — the restart that keeps agents is the unit's
own, proved in `tade-vps-jammy` ("Proving it"), and the journal's `tade_opened` after it is the new
part, held by `workbench/test/upgrade.test.ts` against a real workbench.

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
- **Its deadline holds the process open while it waits** (`within`). Under tmux the lane is tmux's
  child and the driver's poll is `unref`'d, so a deadline that was `unref`'d too left nothing
  keeping Node alive: `tade setup --check` ended halfway, on exit code 13, having printed nothing,
  on exactly the driver a server is told to use. `setup.test.ts` runs it under tmux on a server of
  its own (`TMUX_TMPDIR`).
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
