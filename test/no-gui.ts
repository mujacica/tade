import { ChildProcess } from 'node:child_process'
import { afterEach, expect } from 'vitest'

// A test suite may never reach the machine it runs on.
//
// This is loaded by every test file (`setupFiles` in `vitest.config.ts`),
// because the rule is the repository's and not one package's. It exists
// because the window's tests really did spawn `open` on a fixture worktree,
// and so macOS Finder opened — over and over, on somebody's machine, every
// time an agent ran `pnpm check`. A suite that is meant to finish in under
// thirty seconds with no network reaching the desktop is worse than a network
// call: a socket does not steal focus.
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

/** `cmd /c start …` is how Windows opens a thing; `cmd` on its own is not. */
function opensDesktop(file: string, args: readonly string[]): boolean {
  const program = file.split(/[/\\]/).at(-1) ?? file
  if (program === 'cmd' || program === 'cmd.exe') return args.includes('start')
  if (program === 'gio') return args[0] === 'open'
  return DESKTOP.has(program)
}

const SEEN = Symbol.for('tade.desktop.spawns')

/** What a test tried to open on the desktop, in order. Empty is the only passing answer. */
export function desktopSpawns(): readonly string[] {
  return ((globalThis as Record<symbol, unknown>)[SEEN] as string[] | undefined) ?? []
}

/** Take the record back, for the one test that is *about* the guard. */
export function forgetDesktopSpawns(): void {
  ;(globalThis as Record<symbol, unknown>)[SEEN] = []
}

const PATCHED = Symbol.for('tade.desktop.patched')
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
  forgetDesktopSpawns()
  const real = internals.spawn
  internals.spawn = function guarded(this: ChildProcess, opts) {
    const args = (opts.args ?? []).slice(1)
    if (opensDesktop(opts.file, args)) {
      const said = [opts.file, ...args].join(' ')
      ;(globals[SEEN] as string[]).push(said)
      throw new Error(
        `a test tried to open ${said} on this machine. Tests never reach the desktop: ` +
          'hand the window an `open` of your own — see `AppOptions.open`, and the wire ' +
          "harness's `opened`.",
      )
    }
    return real.call(this, opts)
  }
}

// Reported per test, so the failure names the test that did it — and so a
// caller that caught the refusal cannot quietly turn it into a notice.
afterEach(() => {
  const tried = desktopSpawns()
  if (tried.length === 0) return
  forgetDesktopSpawns()
  expect.unreachable(
    `this test tried to open ${tried.length} thing(s) on the machine it runs on: ${tried.join(', ')}`,
  )
})
