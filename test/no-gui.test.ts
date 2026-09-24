import { execFile, execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { audioSpawns, desktopSpawns, forgetMachineSpawns } from './no-gui.ts'

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
  forgetMachineSpawns()
  return tried
}

/** The same, for the other half of the rule. */
async function triesAudio(what: () => unknown): Promise<readonly string[]> {
  try {
    await what()
  } catch {
    // Refused is the point.
  }
  const tried = audioSpawns()
  forgetMachineSpawns()
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

// The other hardware a test does not own. A microphone opened in CI is the
// same bug as a Finder window: nobody sees it happen, and on somebody's laptop
// it is a recording light coming on during a call. Speech out is worse, being
// audible; and whisper.cpp is a minute of a runner's time per clip.
describe('a test may never reach the microphone, the speakers, or a speech model', () => {
  it('refuses the recorder, and says what was tried', async () => {
    expect(
      await triesAudio(() => spawn('ffmpeg', ['-f', 'avfoundation', '-i', ':0', '/tmp/x.wav'])),
    ).toEqual(['ffmpeg -f avfoundation -i :0 /tmp/x.wav'])
    expect(await triesAudio(() => spawn('sox', ['-d', '/tmp/x.wav']))).toEqual([
      'sox -d /tmp/x.wav',
    ])
    expect(await triesAudio(() => spawn('arecord', ['/tmp/x.wav']))).toEqual(['arecord /tmp/x.wav'])
  })

  it('refuses to make the machine audible, on either platform', async () => {
    expect(await triesAudio(() => spawn('say', ['-r', '190', 'Refunds is blocked']))).toEqual([
      'say -r 190 Refunds is blocked',
    ])
    expect(await triesAudio(() => spawn('spd-say', ['--wait', 'hello']))).toEqual([
      'spd-say --wait hello',
    ])
    expect(await triesAudio(() => spawn('afplay', ['/tmp/blocked.wav']))).toEqual([
      'afplay /tmp/blocked.wav',
    ])
    expect(await triesAudio(() => spawn('paplay', ['/tmp/blocked.wav']))).toEqual([
      'paplay /tmp/blocked.wav',
    ])
  })

  it('refuses a speech model, which costs minutes rather than hardware', async () => {
    // The conformance suite asks every transcriber to transcribe silence. On a
    // machine that really has whisper.cpp and a model, that ran the model.
    expect(await triesAudio(() => spawn('whisper-cli', ['-m', 'ggml.bin', '-f', 'x.wav']))).toEqual(
      ['whisper-cli -m ggml.bin -f x.wav'],
    )
  })

  it('holds however the caller reached child_process', async () => {
    // The speaker's own runner is `execFile`, which never touches `spawn`.
    expect(await triesAudio(() => execFile('say', ['hello'], () => {}))).toEqual(['say hello'])
  })

  it('says which seam to use instead, rather than only refusing', async () => {
    await expect(
      new Promise((_resolve, reject) => {
        const child = spawn('ffmpeg', ['-i', ':0'])
        child.once('error', reject)
      }),
    ).rejects.toThrow(/ScriptedRecorder/)
    forgetMachineSpawns()
  })

  it('leaves alone the words that only look like one of them', async () => {
    // `main` was one of whisper.cpp's binary names and is far too common to
    // claim; a fixture called `rec.sh` is not `rec`.
    expect(await triesAudio(() => spawn('echo', ['say']))).toEqual([])
    expect(await triesAudio(() => spawn('git', ['log', '--oneline', '-1']))).toEqual([])
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
