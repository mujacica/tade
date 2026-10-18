import { ChildProcess } from 'node:child_process'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect } from 'vitest'

// A test's home directory is an empty one of its own, never the home of
// whoever runs the suite.
//
// Loaded by every test file (`setupFiles` in `vitest.config.ts`), before
// anything is imported that could read `os.homedir()`. Two reasons, and the
// second is the one that was measured:
//
//  - **What a home holds is the person's, not the suite's.** A test that falls
//    back to `~/.pi`, `~/.claude` or `~/.codex` reads somebody's real agent
//    transcripts and writes into them: the suite had left 26,705 pi sessions
//    in one laptop's `~/.pi/agent/sessions`, and one workbench test went red on
//    every machine that had run the suite before.
//  - **A home that big is slow, and only here.** Finding one session scans
//    every folder under that root, so the more often the suite had run, the
//    slower it got: `orchestrator.test.ts` took 64 s against 18 s with an empty
//    home, and the whole suite 328 s against 265 s. CI never saw it, because
//    a runner's home is empty — which is the home every test here was already
//    written for, so this is reality and not a kindness.
//
// The vitest process itself keeps the real home: `test/one-suite.ts` runs
// there, and the turn it takes is this machine's, in this machine's Tade home.
//
// pi's agent directory moves out of the home when `PI_CODING_AGENT_DIR` says
// so, and its sessions when `PI_CODING_AGENT_SESSION_DIR` does, and Tade
// follows both there (`sessionsOf`), so they go too.
//
// Claude Code's folder moves when `CLAUDE_CONFIG_DIR` says so, and Tade sets
// it for every agent it starts on an account, so a suite run by an agent
// inherits the agent's own folder: `backup.test.ts` backed up that agent's
// real conversations and restored them over themselves, leaving six tests red
// only when an agent ran them. It goes too.

//
// Tade's own home goes with it, and that one is the person's running Tade:
// `TADE_HOME`, and `TADE_EXTENSIONS` and `TADE_SKILLS` that Tade hands its
// orchestrator's tools, would point a test straight back at it. Moving `~` was
// all that kept every workbench a test opened from committing in the real
// `~/.tade/extensions`, because the config's default was that path whatever
// the home (`extensionsRoot` says what it is now). So a spawn that runs in the
// person's Tade home is refused and fails the test that made it, the way
// `no-gui.ts` refuses the desktop: `git add -A` is a spawn, and so is every
// other way a test could write there through git. The one place inside it a
// test may run is the checkout this suite runs from, which Tade's batched
// full checks put under the home (`batchDir`). The synchronous forms do not
// pass through the patch, as there.

/** The person's own Tade home, every way it can be named, read before anything here moves it. */
const PERSONS_TADE = [
  process.env.TADE_HOME,
  process.env.TADE_EXTENSIONS,
  process.env.TADE_SKILLS,
  process.env.HOME && join(process.env.HOME, '.tade'),
  passwdHome() && join(passwdHome() ?? '', '.tade'),
].flatMap((one) => (one ? [...new Set([resolve(one), real(one)])] : []))

/** The checkout this suite runs from, which a batched full run keeps under the home. */
const OWN_CHECKOUT = real(fileURLToPath(new URL('..', import.meta.url)))

process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), 'tade-test-home-')))
delete process.env.PI_CODING_AGENT_DIR
delete process.env.PI_CODING_AGENT_SESSION_DIR
delete process.env.CLAUDE_CONFIG_DIR
delete process.env.TADE_HOME
delete process.env.TADE_EXTENSIONS
delete process.env.TADE_SKILLS

/** The home the account database gives, which no variable moves; none on a uid without an entry. */
function passwdHome(): string | null {
  try {
    return userInfo().homedir
  } catch {
    return null
  }
}

function real(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

const within = (path: string, root: string) =>
  path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)

/** Whether a folder is the person's Tade home or inside it, and not this suite's own checkout. */
export function inPersonsTade(dir: string, roots: readonly string[] = PERSONS_TADE): boolean {
  const at = [resolve(dir), real(dir)]
  if (at.some((one) => within(one, OWN_CHECKOUT))) return false
  return at.some((one) => roots.some((root) => within(one, root)))
}

/** The folders a spawn runs in: its `cwd`, and git's `-C`. */
function placesOf(cwd: unknown, args: readonly string[]): string[] {
  const places = typeof cwd === 'string' ? [cwd] : [process.cwd()]
  args.forEach((arg, i) => {
    if (arg === '-C' && args[i + 1]) places.push(resolve(places[0] ?? '', args[i + 1] ?? ''))
  })
  return places
}

const SEEN = Symbol.for('tade.persons-tade.spawns')
const PATCHED = Symbol.for('tade.persons-tade.patched')
const globals = globalThis as Record<symbol, unknown>

/** Every spawn a test tried in the person's Tade home, in order. Empty is the only passing answer. */
export function personsTadeSpawns(): readonly string[] {
  return (globals[SEEN] as string[] | undefined) ?? []
}

/** Take the record back, for the one test that is about the guard. */
export function forgetPersonsTadeSpawns(): void {
  globals[SEEN] = []
}

/** What node calls internally, as in `no-gui.ts`: `args` starts with argv[0]. */
type Spawner = (opts: { file: string; args?: string[]; cwd?: unknown }) => unknown
const internals = ChildProcess.prototype as unknown as { spawn: Spawner }

if (!globals[PATCHED]) {
  globals[PATCHED] = true
  forgetPersonsTadeSpawns()
  const realSpawn = internals.spawn
  internals.spawn = function guarded(this: ChildProcess, opts) {
    const args = (opts.args ?? []).slice(1)
    const place = placesOf(opts.cwd, args).find((one) => inPersonsTade(one))
    if (place) {
      const said = `${[opts.file, ...args].join(' ')} in ${place}`
      ;(globals[SEEN] as string[]).push(said)
      throw new Error(
        `a test tried to run ${said}, which is the Tade home of whoever runs the suite. ` +
          'Give it a home of its own — `mkrepo().home`, or `TADE_HOME` set to a temp folder.',
      )
    }
    return realSpawn.call(this, opts)
  }
}

// Reported per test, so a caller that caught the refusal — `recordAuthored`
// never throws — cannot swallow it.
afterEach(() => {
  const tried = personsTadeSpawns()
  if (tried.length === 0) return
  forgetPersonsTadeSpawns()
  expect.unreachable(
    `this test ran ${tried.length} process(es) in the person's own Tade home: ${tried.join(', ')}`,
  )
})
