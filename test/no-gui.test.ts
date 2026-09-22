import { execFile, execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { desktopSpawns, forgetDesktopSpawns } from './no-gui.ts'

// The guard in `no-gui.ts`, held to its word.
//
// A test suite that opens Finder is the bug this is about: the window's tests
// spawned `open` on a fixture worktree, so a folder called `app-refunds` kept
// appearing on somebody's screen every time an agent ran the checks. Refusing
// it once is not enough — the next test to reach the desktop has to fail,
// loudly, naming itself.

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The guard records the attempt as well as refusing it; take it back after each check. */
async function tries(what: () => unknown): Promise<readonly string[]> {
  try {
    await what()
  } catch {
    // Refused is the point. What was tried is read from the record.
  }
  const tried = desktopSpawns()
  forgetDesktopSpawns()
  return tried
}

describe('a test may never reach the desktop', () => {
  it('refuses the file manager, and says what was tried', async () => {
    expect(await tries(() => spawn('open', ['-R', '/tmp/app-refunds']))).toEqual([
      'open -R /tmp/app-refunds',
    ])
  })

  it('refuses the openers of the other two platforms', async () => {
    expect(await tries(() => spawn('xdg-open', ['/tmp/x']))).toEqual(['xdg-open /tmp/x'])
    expect(await tries(() => spawn('cmd', ['/c', 'start', '""', 'https://example.com']))).toEqual([
      'cmd /c start "" https://example.com',
    ])
  })

  it('holds however the caller reached child_process', async () => {
    // `execFile` never touches the `spawn` export, so a guard on that export
    // alone would have missed it.
    expect(await tries(() => execFile('open', ['/tmp/x'], () => {}))).toEqual(['open /tmp/x'])
  })

  it('lets everything else through, because the suite spawns real git and real shells', async () => {
    expect(
      await tries(
        () =>
          new Promise<void>((done) => {
            const child = spawn('git', ['--version'])
            child.once('close', () => done())
          }),
      ),
    ).toEqual([])
    // `cmd` is the desktop only when it is starting something.
    expect(await tries(() => spawn('echo', ['start']))).toEqual([])
  })
})

// The synchronous forms — `spawnSync`, `execSync`, `execFileSync` — do not go
// through `ChildProcess.prototype`, and an ESM named import of a builtin
// cannot be patched, so the guard above cannot see them. That hole is closed
// by reading the sources instead: nowhere in the repository does anything hand
// a desktop opener straight to child_process. The window builds its openers in
// `editor.ts` and starts them through one seam (`AppOptions.open`), which the
// guard above already holds.
describe('nothing spawns a desktop opener directly', () => {
  /** The guard's own test has to name them in order to prove it refuses them. */
  const ALLOWED = new Set(['test/no-gui.test.ts'])

  /** A desktop opener handed to child_process as a literal, in any of its forms. */
  const SPAWNS_AN_OPENER =
    /(?:spawn(?:Sync)?|exec(?:File|FileSync|Sync)?)\(\s*'(?:open|xdg-open|gnome-open|kde-open|wslview|explorer(?:\.exe)?)'/

  function tracked(): string[] {
    return execFileSync('git', ['ls-files', '*.ts'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter((line) => line !== '')
  }

  it('hands one to child_process nowhere', () => {
    const guilty = tracked()
      .filter((path) => !ALLOWED.has(path))
      .filter((path) => {
        // A file git tracks and nobody has on disk is a deletion somebody has
        // not committed yet — several agents share this checkout — not a file
        // that reaches the desktop.
        try {
          return SPAWNS_AN_OPENER.test(readFileSync(join(ROOT, path), 'utf8'))
        } catch {
          return false
        }
      })
    expect(guilty).toEqual([])
  })

  it('would notice a new one, including the forms the guard cannot see', () => {
    expect(SPAWNS_AN_OPENER.test("spawnSync('xdg-open', [dir])")).toBe(true)
    expect(SPAWNS_AN_OPENER.test("execFileSync('open', ['-R', path])")).toBe(true)
    // What an opener *is* is a value, and saying so is what the tests do.
    expect(SPAWNS_AN_OPENER.test("expect(o).toEqual({ command: 'open', args: [path] })")).toBe(
      false,
    )
    expect(SPAWNS_AN_OPENER.test("case 'open':")).toBe(false)
  })
})
