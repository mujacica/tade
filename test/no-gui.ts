import { ChildProcess } from 'node:child_process'
import { Socket } from 'node:net'
import { afterEach, expect } from 'vitest'

// A test suite may never reach the machine it runs on, or somebody else's
// push service.
//
// This is loaded by every test file (`setupFiles` in `vitest.config.ts`),
// because the rule is the repository's and not one package's. It exists
// because the window's tests really did spawn `open` on a fixture worktree,
// and so macOS Finder opened — over and over, on somebody's machine, every
// time an agent ran `pnpm check`. A suite that is meant to finish in under
// thirty seconds with no network reaching the desktop is worse than a network
// call: a socket does not steal focus.
//
// Three families, for the same reason and with the same answer. **The
// desktop** is what started this. **Audio** is the other end of the same mistake: a
// microphone opened in CI, a machine that says a sentence out loud while
// somebody is on a call, or whisper.cpp spending a minute of a runner's time
// transcribing four hundred milliseconds of silence. Both are hardware the
// test does not own, and both already have a seam to go through instead — the
// recorder takes a `spawn`, the speaker takes a `run`, the engines take a
// `run` or a `fetch`, and `ScriptedRecorder` and `ScriptedTranscriber` exist
// precisely so that nothing above them needs one.
//
// **A push service** is the third, and it is not hardware: it is *Apple's,
// Google's or Mozilla's*, and a notification sent from a test is a
// notification on somebody's phone — or a request to a stranger from a
// runner, with a signing key and an endpoint on it. It is not hypothetical
// either: the away harness's `refresh()` beats the window, so a test that
// subscribed a device and then refreshed would make the real sender post to
// whatever endpoint its fixture named. The seam is there (`Pusher`, with
// `scriptedPusher` beside it); this is what makes forgetting it a failure
// rather than a request.
//
// The push guard stands on the **socket** rather than on a spawn, because the
// sender is in this process: `net.Socket.prototype.connect` is the one object
// every TCP connection shares, `https.request` and `fetch` included, and
// patching `node:https`'s export could not hold against a module that
// captured `request` when it loaded. It refuses by **host**, so the suite's
// own listeners on loopback are untouched — everything else about them is the
// point of those tests.
//
// Two halves, because either alone would have let this through:
//
//  - the spawn is refused, so nothing opens even while the guard is being
//    reported;
//  - and the attempt is written down, so a caller that catches the refusal
//    cannot swallow it. `reveal` and `openPlace` both turn a failed opener
//    into a line in the strip, which is right for a person and would have
//    hidden this entirely.
//
// It patches `ChildProcess.prototype.spawn` rather than the module's exports:
// that is the one object every asynchronous form shares — `spawn`, `exec` and
// `execFile` all end up there — so it holds however a caller imported them,
// which patching an ESM named import cannot. The synchronous forms
// (`spawnSync` and friends) do not pass through it and cannot be patched at
// all under ESM; `no-gui.test.ts` covers those by reading the sources.

/** The programs that hand something to the desktop. Spawning one is the bug. */
const DESKTOP = new Set([
  'open',
  'xdg-open',
  'gnome-open',
  'kde-open',
  'gio',
  'wslview',
  'explorer',
  'explorer.exe',
])

/**
 * The programs that open a microphone, make a noise, or run a speech model.
 * Each is hardware or minutes that the test does not own: `ffmpeg` and the
 * capture tools open an input device, `say` and the players make the machine
 * audible, and the whisper binaries burn a runner's CPU on a model.
 */
const AUDIO = new Set([
  // Capture.
  'ffmpeg',
  'ffplay',
  'sox',
  'rec',
  'arecord',
  'parecord',
  // Sound out, and speech out.
  'say',
  'afplay',
  'aplay',
  'paplay',
  'spd-say',
  // Speech in: a model, and the minutes it takes.
  'whisper',
  'whisper-cli',
  'whisper-cpp',
])

/**
 * The push services Tade could ever post a notification to.
 *
 * Suffixes rather than names, because each of them answers on a per-device
 * subdomain — `wns2-par02p.notify.windows.com`, and a region per Apple
 * datacentre. `googleapis.com` is the broadest of the four and deliberately
 * so: a test has no business reaching any of it, and `endpoint.ts`'s own
 * refusal of the retired GCM host is a different rule for a different reason.
 */
const PUSH = ['push.apple.com', 'googleapis.com', 'push.services.mozilla.com', 'notify.windows.com']

/** Which hardware or service a test would reach, or null where it reaches none. */
export type Reach = 'the desktop' | 'audio' | 'a push service'

/** `cmd /c start …` is how Windows opens a thing; `cmd` on its own is not. */
function reaches(file: string, args: readonly string[]): Reach | null {
  const program = file.split(/[/\\]/).at(-1) ?? file
  if (program === 'cmd' || program === 'cmd.exe')
    return args.includes('start') ? 'the desktop' : null
  if (program === 'gio') return args[0] === 'open' ? 'the desktop' : null
  if (DESKTOP.has(program)) return 'the desktop'
  // `main` is one of whisper.cpp's old binary names and far too common a word
  // to claim: the recorder and the engines are reached through their seams,
  // and a program called `main` in a fixture is somebody else's.
  return AUDIO.has(program) ? 'audio' : null
}

/** What to do instead, in the words of the seam that is already there. */
const INSTEAD: Record<Reach, string> = {
  'the desktop':
    'Tests never reach the desktop: hand the window an `open` of your own — see ' +
    "`AppOptions.open`, and the wire harness's `opened`.",
  audio:
    'Tests never open a microphone, make a noise, or run a speech model: hand it a seam ' +
    "of your own — `FfmpegRecorder`'s `spawn`, `Speaker`'s `run`, `WhisperCppTranscriber`'s " +
    "`run`, `OpenAiTranscriber`'s `fetch` — or use `ScriptedRecorder` and `ScriptedTranscriber`.",
  'a push service':
    'Tests never reach a push service: a notification sent from a test lands on somebody’s ' +
    'phone. Use `scriptedPusher()`, or hand `pusher()` a `request` of your own — ' +
    '`packages/web/test/push-out.test.ts` does both.',
}

/** Whether connecting to this host would reach a push service. */
export function reachesPush(host: unknown): boolean {
  if (typeof host !== 'string' || host === '') return false
  const bare = host
    .toLowerCase()
    .replace(/^\[|]$/g, '')
    .replace(/\.$/, '')
  return PUSH.some((one) => bare === one || bare.endsWith(`.${one}`))
}

const SEEN = Symbol.for('tade.machine.spawns')

/** One refused spawn: what it would have reached, and the command it was. */
export interface MachineSpawn {
  reach: Reach
  said: string
}

/** Everything a test tried to reach, in order. Empty is the only passing answer. */
export function machineSpawns(): readonly MachineSpawn[] {
  return ((globalThis as Record<symbol, unknown>)[SEEN] as MachineSpawn[] | undefined) ?? []
}

/** What a test tried to open on the desktop, in order. */
export function desktopSpawns(): readonly string[] {
  return machineSpawns()
    .filter((one) => one.reach === 'the desktop')
    .map((one) => one.said)
}

/** What a test tried to record, play, say or transcribe with, in order. */
export function audioSpawns(): readonly string[] {
  return machineSpawns()
    .filter((one) => one.reach === 'audio')
    .map((one) => one.said)
}

/** Take the record back, for the one test that is *about* the guard. */
export function forgetMachineSpawns(): void {
  ;(globalThis as Record<symbol, unknown>)[SEEN] = []
}

const PATCHED = Symbol.for('tade.machine.patched')
const globals = globalThis as Record<symbol, unknown>

/**
 * What node calls internally: `file` is the program, and `args` starts with
 * argv[0], which is the program again. Not in the public types, because it is
 * not public — which is also why it is the one object every asynchronous form
 * shares, and so the only place a guard can stand.
 */
type Spawner = (opts: { file: string; args?: string[] }) => unknown
const internals = ChildProcess.prototype as unknown as { spawn: Spawner }

if (!globals[PATCHED]) {
  globals[PATCHED] = true
  forgetMachineSpawns()
  const real = internals.spawn
  internals.spawn = function guarded(this: ChildProcess, opts) {
    const args = (opts.args ?? []).slice(1)
    const reach = reaches(opts.file, args)
    if (reach) {
      const said = [opts.file, ...args].join(' ')
      ;(globals[SEEN] as MachineSpawn[]).push({ reach, said })
      throw new Error(`a test tried to reach ${reach} with ${said}. ${INSTEAD[reach]}`)
    }
    return real.call(this, opts)
  }
}

/**
 * What `net.Socket.prototype.connect` is called with.
 *
 * Two shapes, both public: an options object, or a port and an optional host.
 * Only the host is read — a port is nobody's business here, and a connection
 * with no host at all is loopback or a pipe.
 */
type Connect = (this: Socket, ...args: unknown[]) => Socket
const sockets = Socket.prototype as unknown as { connect: Connect }

const CONNECTED = Symbol.for('tade.push.patched')

if (!globals[CONNECTED]) {
  globals[CONNECTED] = true
  const real = sockets.connect
  sockets.connect = function guarded(this: Socket, ...args: unknown[]): Socket {
    const first = args[0]
    const host =
      typeof first === 'object' && first !== null
        ? (first as { host?: unknown }).host
        : typeof args[1] === 'string'
          ? args[1]
          : undefined
    if (reachesPush(host)) {
      const said = `a connection to ${String(host)}`
      ;(globals[SEEN] as MachineSpawn[]).push({ reach: 'a push service', said })
      throw new Error(
        `a test tried to reach a push service with ${said}. ${INSTEAD['a push service']}`,
      )
    }
    return real.apply(this, args)
  }
}

/** What a test tried to connect to a push service with, in order. */
export function pushConnects(): readonly string[] {
  return machineSpawns()
    .filter((one) => one.reach === 'a push service')
    .map((one) => one.said)
}

// Reported per test, so the failure names the test that did it — and so a
// caller that caught the refusal cannot quietly turn it into a notice.
afterEach(() => {
  const tried = machineSpawns()
  if (tried.length === 0) return
  forgetMachineSpawns()
  const said = tried.map((one) => `${one.said} (${one.reach})`).join(', ')
  expect.unreachable(
    `this test tried to reach the machine it runs on ${tried.length} time(s): ${said}`,
  )
})
