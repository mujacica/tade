---
name: add-workspace-driver
description: Add a new WorkspaceDriver (tmux, ghostty, kitty, wezterm, zellij, container) or change the driver port, or add or change a RemoteLink (how this machine's Tade reaches another machine's — ssh, scripted), which is shaped the same way. Use when lanes should live somewhere other than Tade's own PTYs, or when another machine's Tade should be reached some other way or is linked wrongly.
---

# Adding a WorkspaceDriver

A driver decides **where a process physically lives**. It does not decide where you look at it.
The port is `packages/drivers/core/src/port.ts`; the reference implementation is
`packages/drivers/pty`.

## The job is: import the suite, run it, fix what's red

1. Create `packages/drivers/<name>` depending on `@tade/core` and `@tade/drivers-core` (plus
   whatever the backend needs), with `vitest` as a dev dependency.
2. `packages/drivers/<name>/test/conformance.test.ts`:
   ```ts
   import { testWorkspaceDriver } from '@tade/drivers-core/conformance'
   import { TmuxDriver } from '../src/index.ts'
   // The argument is a workspace name: two calls with the same one must look
   // at the same lanes, because that is what Tade being reopened is.
   testWorkspaceDriver('tmux', (workspace) => new TmuxDriver({ session: workspace }))
   ```
3. Implement until the suite passes. It covers the round-trip, output ordering, concurrent writes,
   resize, titles, replay, exit reporting, a quick command's first bytes, idempotent close, and
   typed errors.
4. Register it in `drivers` in `packages/workbench/src/registry.ts`. That map is the only place a
   driver name turns into an implementation.
5. Add the driver to the `workspace.driver` enum in `packages/core/src/config.ts`.

## Rules

- **Declare capabilities honestly.** `capabilities` says what the driver can do; call sites branch
  on those flags and never on `driver.id` (a lint plugin enforces it). A capability you declare
  must work; one you don't must throw `UnsupportedCapabilityError`, never fail silently.
- **Declare what it needs of the machine** (`programs`): each program it shells out to, what it is
  needed for in a clause, the arguments that make it print its version, and how to install it —
  `{ command: 'tmux', versionArgs: ['-V'], install: { brew: 'tmux', apt: 'tmux' } }`. That is what
  Settings › Updates, `tade update` and the setup wizard all fold together, so a driver that needs
  something of the machine is the only place that says so — and the exact command somebody is shown
  before it runs comes from here, never from a table in the wizard. Only declare an install you are
  sure of: a command that installs something else under the same name is worse than `instead`, which
  says where to get it. A driver that needs nothing declares nothing, which is an answer; the
  conformance suite refuses one nobody could look up or ask.
- **No implementation vocabulary in the port.** If you want to add `sendKeys`, `newWindow` or
  `selectPane` to the interface, the answer is no: find the neutral name, or it belongs in the
  driver's own module.
- **`capture` is the rendered screen, never the byte stream.** Plain text by default; with
  `styled: true`, the same rows with their colour and emphasis as SGR sequences and nothing else —
  no cursor moves, no clears — because the window draws them straight into a pane. A backend with a
  screen model (tmux `capture-pane -e`) gives this for free; one without has to build it from cells,
  as the pty driver does from its headless xterm.
- **A capture is a whole frame, and where the newest one is half drawn it is the one before it.** A
  window draws what it is handed four times a second on a beat that has nothing to do with the
  program's, so a capture taken while a repaint is arriving is the top of the new frame over the
  bottom of the old — rows from two moments on one screen, which is tearing, and which nothing in
  the rows can be inspected for afterwards. **Where a frame begins is declared by a program that
  uses synchronized output (DEC 2026) and by no other, so both cases have to be answered**: for the
  declared one, wait for the end of the update; for the rest, the only boundary left is the write
  itself stopping (`QUIET_MS`, five milliseconds, measured off Claude Code — which emits no 2026 at
  all — repainting in three to six writes over two to seven milliseconds with twenty of quiet after
  them). Wait for quiet **only on the alternate screen**: a lane that prints and keeps what it
  printed cannot tear, because a part-written last line is what the terminal it is in shows too, and
  making it wait is latency bought for nothing. Both waits are bounded, and past the bound hand back
  the last capture known whole — **once**, and then draw what there is, because two frames of a lane
  nobody can catch settled is a pane that has stopped, which is worse than a torn one
  (`packages/app/test/wire/frame.probe.test.ts` is the argument). Held to it by
  `packages/drivers/pty/test/capture.test.ts`, which counts torn frames rather than looking at them:
  every row carries its frame number, so a capture whose rows disagree is proof. It was one capture
  in six, one in five with four lanes repainting under load, and one in twenty of the real program
  scrolled at forty notches a second; all three are none now, for two thirds of a millisecond more a
  capture. Not in the conformance suite, because a driver reading somebody else's screen (tmux's)
  cannot keep the promise.
- **An emulator the driver owns never runs on the thread that draws.** Parsing every byte every
  lane prints, and holding thirty megabytes of screen per lane, was the window's largest cost. The
  pty driver's emulators run on a worker (`emulator.ts`, started by `thread.ts`, sharing only
  `protocol.ts`) and push a frame once it has settled, for a lane somebody is capturing; a capture is
  answered from that frame when it already holds everything the lane printed before the capture was
  asked, and from the next one otherwise — so an echo is never a frame behind. The process stays on
  the main thread: node-pty in a worker deadlocks on teardown (measured, in `thread.ts`). A thread
  that dies — or leaves a question unanswered for five seconds, which is stuck, not busy — is started
  again from each lane's replay, three times, and then every screen is the last one known — never an
  empty one — and both are said through `trouble`. A cached answer still goes
  round the event loop once, or a loop of captures starves the output it is waiting for. And
  whether a program wants the pointer is read off the newest numbers on the spot, never waited for:
  the window sends a turn's presses and typing in order without awaiting any (`wire/outbox.ts`),
  so a press that waited on the emulators would land after the typing that followed it.
- **`screen()` is what the text cannot say.** How many lines the lane holds — screen and
  scrollback together, which is the most `capture` can return — and where the cursor is, as a
  column and how many lines *back from the last line `capture` returns* it sits (negative when it is
  on the empty rows below that line, which is where a program that just printed a line leaves it).
  Measure both exactly the way your own `capture` measures, or the window draws a scrollbar and a
  block cursor in the wrong places. The suite checks that a capture asked for more lines than there
  are returns exactly `lines` of them. It also says **whose the scrolling is** (`scrolling`): a
  program on the alternate screen keeps no scrollback for the window to move, so it is `lane` when
  it also asked for the mouse and `nobody` when it did not, and `window` for everything that
  prints. Read it off the lane, never off what the lane was launched with — a shell becomes an
  editor the moment somebody types one.
  `screen()` also says **how much of the pointer the program asked for** (`pointing`): `nobody`
  where it never asked, `press` where it wants presses and releases, `drag` where it wants movement
  with a button held too. Apart from `scrolling`, because one lane answers the two differently — a
  program that prints its conversation keeps every line and may still want the click that opens
  one. A backend that reports "in any of the mouse modes" is not reporting "wants movement": tmux's
  `#{mouse_any_flag}` is the first, and `#{mouse_button_flag}`/`#{mouse_all_flag}` are the second.
- **`wheel()` hands a notch to a program that asked for the mouse, and `point()` hands it a press,
  a drag or a release**, both behind `capabilities.pointer`. Encode with `wheelBytes` and
  `pointerBytes` rather than by hand — `pointerBytes` is also where "only as much as it asked for"
  is decided, so a lane that wants presses and no movement is answered the same way by every driver
  instead of by whichever one remembered to check. Send nothing at all to a program that never
  asked: bytes it cannot read as a pointer are characters typed into it. Your backend has to be
  able to say which encoding was asked for (tmux `#{mouse_sgr_flag}`; the pty driver watches the
  mode go past in the output), because the two are not interchangeable.
- **`attachCommand` must always return something that works.** It is the escape hatch that lets a
  human see a lane whatever the backend is — and, with `remoteAttach`, the far half of a lane on
  another machine drawn as a pane of this one's window (`embedded`: nothing of the backend's own
  around it, no key kept back, the pointer the lane's). **Two terminals on two lanes each show their
  own**, which `tmux attach` does not: a session has one current window for all its clients. The
  suite's cases are `attaching.ts`; the tmux recipe is `drivers/tmux/src/attach.ts` — a grouped
  session per terminal, ended by a `client-detached` hook and **never `destroy-unattached`**, which
  ended the whole tmux server three runs in eight on 3.4 (Ubuntu 24.04's), as does making a window
  follow its clients' size while that session ends. Check a tmux change on 3.3a and 3.4 built in a
  `node:22` container, not only on the laptop's newer one.
- **`detach()` lets go, `shutdown()` ends it.** Closing Tade calls `detach`, and under a driver
  claiming `detach: true` that must leave every lane running. If lanes cannot outlive us and cannot
  be found again, `detach` ends them — leaving processes nobody can see, drive or stop is worse
  than either.
- **Lanes that outlive Tade must outlive Tade's service too.** A unit's default
  `KillMode=control-group` ends everything in its cgroup when it stops — whatever process group,
  session or `setsid` a child used — so a server a driver starts from inside `tade.service` dies
  with every restart of it. The tmux driver starts its server through `systemd-run --user --scope`
  when this process is a service of the user's manager (`scope.ts`: `userServiceOf` reads
  `/proc/self/cgroup`), names the scope after its socket and makes it unique, and where no scope
  can be made says so through `trouble` and starts plainly — agents a restart would end beat no
  agents. A driver of a separate server program does the same at the one command that can start
  it; `test/scope.test.ts` holds it with a `systemd-run` on PATH that records and then runs.
- **`adopt()` is what makes `detach: true` mean anything.** A fresh instance must be able to find
  the lanes a previous one left and return handles that can actually be written to, with the spec
  intact. Store whatever that needs on the backend's own objects, as the tmux driver stores the
  lane id and spec on the window.
- **Typed errors:** `LaneNotFoundError` for unknown lanes, `LaneClosedError` after close.
- **`open()` must not leave a phantom lane.** If the command can't launch, reject and register
  nothing (the PTY driver resolves the executable before spawning, because node-pty reports a
  failed exec asynchronously).
- Prefer capabilities the backend genuinely has: a mux server (tmux, wezterm, zellij) can offer
  `detach: true`; an emulator-driven driver (ghostty, kitty) usually cannot.

## What the second driver turned out to need

`packages/drivers/tmux` passed the suite once these were right. They are likely to matter for any
backend that is a separate program rather than a library:

- **Order writes yourself.** `pty.write` is synchronous, so call order survives for free. Every tmux
  write is a separate process, so concurrent writes land in whatever order they finish. A per-lane
  promise queue, appended to synchronously inside `write()`, is what makes the ordering test pass.
- **Send bytes, not text.** `send-keys -H` takes hex, so control characters and UTF-8 survive
  exactly instead of being interpreted as key names.
- **Ask the backend to keep dead processes.** `remain-on-exit on` leaves the pane holding its exit
  status, which is the only way to report an exit code. Set it before opening anything, or a
  fast-exiting command is gone before the option applies.
- **Address lanes by the backend's own id** (`@3`, from `new-window -P -F '#{window_id}'`), never by
  a name you chose: names get sanitised, truncated and renamed.
- **Keep the lane id where the backend keeps state** (tmux user options, `@tade-lane`), so `adopt`
  recovers lanes exactly rather than reverse-engineering window names.
- **Replay only what has already been delivered live.** If replay reads to the end of the buffer,
  the poller delivers the tail again and the subscriber sees it twice.
- **Start listening in the same breath as the process.** tmux runs one invocation's commands back
  to back before it next reads a pane, so `new-window … ; pipe-pane …` catches everything, and a
  `pipe-pane` of its own afterwards caught nothing from a `printf` and missed a `node -e` one time
  in six under load. That one invocation addresses the window by a unique name, the only exception
  to the rule above, because its id is not known until it returns. A pipe also makes tmux before
  3.8 read a dead pane to the end: it checks for unread bytes only on a pane with one.
- **A dead pane is not a written-down pipe.** tmux calls a pane dead once the last bytes are in
  the pipe, and `cat` may not have written them yet, so an exit reported then can arrive ahead of
  the bytes. From 3.8 tmux closes the pipe as the pane dies and `cat` says when it is done
  (`pipe.ts`). Before 3.8 the pipe stays open, and `pipe-pane` refuses a dead pane in every
  version, so there is nothing to wait for. Read which case you are in off `#{pane_pipe}`, never
  off a version number.
- **Anything the backend runs through a shell must be shell-quoted**, even though the backend itself
  is invoked with an argument array and no shell. **And whatever it reads itself must be read as
  given**: tmux ends a command at any argument that *ends* in `;`, so a lane's cwd or env value
  ending in one split `new-window` into `unknown command`. Everything a lane was given goes through
  `literal` (`pipe.ts`), which ends it in `\;`, tmux's own literal `;`, the same from 3.3a to 3.8.
- **Lanes open together, so what opening needs is made once.** A machine starts its agents at once,
  and every open that found no session made one: four opens on a fresh driver were one lane and
  three `duplicate session`. The first open makes it and the rest wait on that promise
  (`session.ts`); the conformance suite opens its eight quick lanes from cold to hold it.

## Native dependencies

If the backend needs a native module, check it works under pnpm's layout before building on it.
node-pty's `spawn-helper` loses its executable bit during extraction, which is why
`scripts/fix-pty-permissions.mjs` runs on postinstall.

## A RemoteLink is the same shape

`packages/remotes/core` is the other port this recipe covers: how this machine's Tade reaches
another machine's, as an owner device of its away view (REMOTE-TADE.md §2.5). One object holds any
number of remotes the way a driver holds any number of lanes; the registry is `REMOTE_LINKS` in
`@tade/workbench/remotes` (the lowest package both the window and the CLI depend on); capabilities
are declared (`pairs`, `identifies`, `terminals`); and `@tade/remotes-core/conformance` is the suite, run against **far ends
that are real away views** (`@tade/remotes-core/far`: `@tade/web`'s own listener in a home of its
own, owners minted into its device list), so a link is held to the protocol a VPS speaks and not to
a stand-in kinder than it. The two implementations are `scripted` (far ends by name out of a table,
over loopback) and `ssh`.

- **What an implementation brings is small**: how to pair and sign out, and how to reach one
  remote's loopback listener (`Reaching`). `linkOver` builds the rest — the stream follower, the
  cursor, the deadlines, the backoff, the presence — once (`follow.ts`), over rules that are pure
  (`held.ts`). An implementation may build its own; the suite holds it to the same things.
- **Nothing a frame draws waits on it.** `open`, `beat`, `wake` and `present` return at once and
  **never throw** — a remote that cannot be reached at all is a link that is down with the reason,
  and `linkOver` turns a `reaching` that throws into exactly that. A dial overtaken by another (a
  wake, a redial) is told so by its number, so a late answer never overwrites the one that replaced
  it.
- **The cursor is `(epoch, rev)`** and nothing reads `seq` or a byte offset; another epoch, a
  revision past ours, a gap or a delta that will not apply is a snapshot. **A held projection is
  never emptied by trouble** — down keeps it and its age (`heardAt`, this machine's clock).
- **Read a frame for its shape, not field by field** (`readSnapshot`): the away protocol adds a
  field without moving its version, and two machines are two installs, so a strict parse is a link
  that breaks the morning one of them updated. Only another `v` is refused, with "update the older".
  **So a held projection is anything the remote wrote, escape sequences included**, and nothing
  draws or prints it as it came: the window reads it through `machines.ts` alone, which reads each
  field as what it should be or not at all and reduces every string to text (core's `printable`); a
  link's `said` and a carry's answer go through `printable` too, because a parser's error quotes what
  it was sent and a `notice` frame is the remote's own words.
- **Ended is not down.** A `204` or `401` on the stream, or a `revoked` frame, is the remote saying
  this machine's session is over, and nothing redials it; only pairing again changes that.
- **Presence goes as an age, never a moment**, because the two clocks are two clocks, and only
  when it is new, no oftener than `PRESENCE_EVERY_MS` (`@tade/web`'s `presence.ts` is the far half).
- **The window writes transitions, not tries** (`wire/remotes.ts`): `remote_linked` once it holds a
  cursor, `remote_unlinked` down or ended, nothing for a redial — and `tade remote status` folds those
  lines (`linksSeen`) rather than asking the window.
- **A call is not the stream** (`call`, `call.ts`): one owner's request, with a deadline on all of it
  and a bound on what is read, over a stream the implementation opens for that call alone
  (`Transport.connect`) — so the CLI with no window open can make one, and one made beside a held
  link never disturbs it. It is what the carry rides on (`add-config-key`'s *What a remote is
  given*); the far end answers it as the real away view does.
- **A terminal there is the one connection a person is at** (`terminal`, with `terminals`): what to
  run here for `tade <words>` there, each word checked — a harness's own sign-in, typed into by the
  person, so the token goes where that harness keeps it and never through Tade. **`attach` is the
  same for an agent's lane**: the line is the remote's own (`/api/attach`, its driver's
  `attachCommand` — only that machine knows its socket, session and window), handed back to it as
  one line of printable text or not at all; how it gets there (`ssh -t`, or mosh where both
  machines have it) is the implementation's, said in `by` and never branched on.
- **`request` rides the held link** (its door, while live): what a window asks again and again — an
  agent's screen, a verb — so never a connection of its own, and never anything while the link is
  down. `call` is the one that makes its own, for the CLI with no window open.

What the ssh link turned out to need, each held by its tests:

- **One ControlMaster per remote, started with `-f`**, which exits 0 only once it has signed in and
  bound its forward (`ExitOnForwardFailure`) and lets go of its pipes, so `runProgram` can wait on it
  with a deadline. `-O check` finds one a crashed window left; `-O exit` lets one go.
- **The forward ends in a Unix socket made `0600`** (`StreamLocalBindMask=0177`, in the home's
  `runtimeDir`), not a loopback port every user of the machine can open — what goes through it is
  your keyboard on the other machine. `StreamLocalBindUnlink` clears the one a dead master left. The
  paths are hashes, because a socket path is capped near 104 bytes.
- **`BatchMode` always**: there is nobody at a terminal to answer, so a key with a passphrase fails at
  once with ssh's own words. The one connection that is not is `terminal`'s, which a person is at.
- **A machine never met is met on a press, by ssh's own verdict and ssh's own line** (`known.ts`).
  `identify` asks ssh under `StrictHostKeyChecking=yes` whether the host is known, new or changed,
  and for one that is not simply known lets ssh write what the host offers into a throwaway
  `known_hosts` (`accept-new`, nowhere real) — so a jump host, a `HostKeyAlias`, a hashed file and a
  second file are answered as for every other connection. `trust` looks again and appends exactly
  those lines to the first `UserKnownHostsFile` `ssh -G` names, only where the host offers exactly the
  fingerprints the person was shown, and **never past `changed`**: that is a machine in between or a
  machine rebuilt, so it is said with `ssh-keygen -R` and never done. `tade remote add` shows the
  fingerprints and asks, or takes `--accept-key` for each; a fresh `sshd` never met
  (`startSshd({ met: false })`) is what holds it.
- **The call goes over `ssh -S <control> -W 127.0.0.1:<port>`**: over the window's master where one is
  up, on its own where not, and never starts or ends one — a call from a shell must not leave a
  master nobody ends, nor end the one a window is reading.
- **One turn at a time per remote**: a wake that drops the master while a dial is signing in would
  start a second master over the first.
- **A command over SSH gets the system's PATH**, without the profile that put a version manager's
  `bin` on it — `tade` and the `node` it runs on are `command not found` there unless named whole
  (`--tade`, `remotes.<name>.tade`), and the destination and the command are refused at the schema
  for anything but their shape, because one becomes an argument to `ssh` and the other a word a
  remote shell reads.
- **mosh only where it can work**: `mosh` on this machine and `command -v mosh-server` answered there
  (over the master, kept ten minutes), never for an `ssh://…:port` destination mosh cannot take, and
  declared `optional` beside `ssh` (`MOSH_PROGRAM`) — remote links' programs are folded into what
  the machine needs (`workbench/src/programs.ts`), so a VPS lists it too. UDP 60000–61000 must be
  open there; where it is not, mosh says so in the pane, which says it is mosh.
- **Tested against a real `sshd`** run as the person running the suite (`test/sshd.ts`: keys made
  for the run, a client config, one real login before anything counts), and skipped with the reason
  where none will start — so its coverage moves with the machine (`MOVES`).

