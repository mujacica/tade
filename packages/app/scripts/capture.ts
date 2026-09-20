import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LaneId } from '@tade/core'
import { PtyDriver } from '@tade/drivers-pty'
import type { Box } from './ansi-svg.ts'
import { type Grid, THEME, type Theme, toCells, unknownSgr } from './terminal.ts'

// A picture of Tade, taken of Tade.
//
// `pictures.ts` draws the README's pictures from the scenarios the golden
// tests protect — the real renderer over made-up state, which is fast, exact
// and reaches every corner of the window, including the ones that need an
// agent and a bill. What it cannot tell you is whether the program a person
// installs paints what that renderer draws: between the two sit the alt
// screen, the frame loop, the terminal's own idea of a colour and the size of
// the window it was given.
//
// So this takes the other picture. It runs the real `tade` binary in a real
// terminal — Tade's own pty driver, which keeps a real terminal emulator per
// lane — presses real keys at it, and photographs whatever is on the screen.
// Nothing is drawn here and nothing is recreated: what comes back is what the
// program painted.
//
// It is not a second source for the README. It cannot be: an agent at work is
// a model and a bill, and a picture of the window that needs neither would be
// the made-up one again. It is the check on the first source, and the way to
// see a change in the program rather than in a test.

/** One picture: what to press first, and which part of the screen to keep. */
export interface Take {
  name: string
  /** What it shows, for the page and for anybody who cannot see it. */
  about: string
  /**
   * Pressed in order before the picture is taken. A named key (`ctrl+k`,
   * `f1`, `esc`) or a run of characters to type; a number is that many
   * milliseconds of waiting, for something the window has gone to fetch.
   */
  press?: readonly (string | number)[]
  crop?: Box | 'panel'
  title?: string
}

/** What one take came back with. */
export interface Taken {
  take: Take
  grid: Grid
  /** The rows as the terminal holds them, for a diff against a golden. */
  rows: string[]
  /** Escape codes in the stream that nothing here could read, by shape. */
  unknown: string[]
}

export interface CaptureOptions {
  cols?: number
  rows?: number
  theme?: Theme
  /**
   * A Tade home to open, instead of a disposable one seeded with real
   * repositories. Your own, to photograph your own window — which takes the
   * home's lock, so it fails honestly while a window of yours is open.
   */
  home?: string
  /** Where `tade` is: this repository's own CLI unless given. */
  command?: { command: string; args: string[] }
  /** Said as each take is reached. */
  onTake?: (take: Take, at: number, of: number) => void
}

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..', '..')

/**
 * The model the seeded home names for its orchestrator.
 *
 * Only so that setting up is finished: nothing is asked of it here, and the
 * window says so in its own strip when it cannot be reached. A model that
 * does not exist would be a lie on screen; this one is real and unused.
 */
const MODEL = 'anthropic/claude-opus-5'

/**
 * The keys a window is worth pressing, as the bytes a terminal sends.
 *
 * The window asks its terminal for the kitty keyboard protocol (it has to:
 * push-to-talk needs to know when a key is *let go*), so anything with a
 * modifier on it arrives as `CSI unicode ; modifiers u`. A plain control
 * character still works and is what a terminal without the protocol would
 * send, so those are written the short way.
 */
function keystroke(name: string): string {
  const named: Record<string, string> = {
    enter: '\r',
    tab: '\t',
    'shift+tab': '\x1b[Z',
    esc: '\x1b',
    escape: '\x1b',
    space: ' ',
    backspace: '\x7f',
    up: '\x1b[A',
    down: '\x1b[B',
    right: '\x1b[C',
    left: '\x1b[D',
    f1: '\x1bOP',
  }
  const known = named[name.toLowerCase()]
  if (known !== undefined) return known
  const parts = name.toLowerCase().split('+')
  const key = parts.pop() ?? ''
  const mods = new Set(parts)
  // Not a key name at all: characters to type, one after another.
  if (mods.size === 0 && key.length !== 1) return name
  if (mods.size === 1 && mods.has('ctrl') && /^[a-z]$/.test(key)) {
    return String.fromCharCode(key.charCodeAt(0) - 96)
  }
  const modifiers =
    1 + (mods.has('shift') ? 1 : 0) + (mods.has('alt') ? 2 : 0) + (mods.has('ctrl') ? 4 : 0)
  return `\x1b[${key.codePointAt(0) ?? 63};${modifiers}u`
}

/** A repository with something in it, the way a person's would be. */
function seedRepo(root: string, name: string): void {
  mkdirSync(root, { recursive: true })
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Tade',
    GIT_AUTHOR_EMAIL: 'tade@tade.invalid',
    GIT_COMMITTER_NAME: 'Tade',
    GIT_COMMITTER_EMAIL: 'tade@tade.invalid',
  }
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, env, stdio: 'pipe', encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'README.md'), `# ${name}\n`)
  writeFileSync(join(root, 'package.json'), `{ "name": "${name}" }\n`)
  writeFileSync(join(root, 'src', 'webhooks.ts'), 'export function constructEvent() {}\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'the first commit')
}

/**
 * A home to open on: real repositories, a real config, nothing running.
 *
 * Deliberately no cleverness — no pre-written journal, no lanes invented on
 * disk. A picture taken of a home somebody made up is the made-up picture
 * again, with more moving parts.
 */
function seedHome(): { home: string; base: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'tade-capture-')))
  const home = join(base, 'home')
  mkdirSync(home, { recursive: true })
  for (const name of ['checkout', 'search']) seedRepo(join(base, name), name)
  writeFileSync(
    join(home, 'config.yaml'),
    [
      'projects:',
      ...['checkout', 'search'].flatMap((name) => [`  ${name}:`, `    root: ${join(base, name)}`]),
      'workspace:',
      '  driver: pty',
      // Named so the window opens rather than the wizard: setting up is what a
      // machine with nothing on it sees, and it is a screen of its own. On a
      // machine with no harness signed in at all the wizard still comes up —
      // correctly, and the picture says so.
      'orchestrator:',
      `  model: ${MODEL}`,
      '',
    ].join('\n'),
  )
  return { home, base }
}

/** Nothing has come out of the lane for a while: the window has finished drawing. */
async function settle(driver: PtyDriver, lane: LaneId, quiet: number, most: number): Promise<void> {
  let last = Date.now()
  const stop = driver.onOutput(lane, () => {
    last = Date.now()
  })
  const until = Date.now() + most
  try {
    while (Date.now() < until && Date.now() - last < quiet) {
      await new Promise((done) => setTimeout(done, 40))
    }
  } finally {
    stop()
  }
}

/**
 * Run the real window and photograph it, take by take.
 *
 * One window for all of them, because opening one takes seconds and because
 * that is how a person uses it: the takes are pressed one after another, each
 * ending where the last one left off. `esc` closes what the one before opened.
 */
export async function capture(takes: readonly Take[], opts: CaptureOptions = {}): Promise<Taken[]> {
  const cols = opts.cols ?? 120
  const rows = opts.rows ?? 34
  const theme = opts.theme ?? THEME
  const seeded = opts.home ? null : seedHome()
  const home = opts.home ?? seeded?.home ?? ''
  const driver = new PtyDriver({ attachCommand: (id) => `tade attach ${id}` })
  const lane = 'capture/window/app' as LaneId
  const run = opts.command ?? {
    command: process.execPath,
    args: [join(repo, 'packages', 'cli', 'src', 'bin.ts'), 'app'],
  }
  const out: Taken[] = []
  try {
    await driver.open({
      id: lane,
      cwd: repo,
      command: run.command,
      args: run.args,
      cols,
      rows,
      env: {
        TADE_HOME: home,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        // Colour is what is being photographed, so a machine that has turned
        // it off everywhere must not turn it off here.
        NO_COLOR: '',
      },
    })
    // The first screen takes longest: the workbench opens, the extensions
    // load and the orchestrator is sent for.
    await settle(driver, lane, 1_200, 30_000)
    for (const [at, take] of takes.entries()) {
      opts.onTake?.(take, at + 1, takes.length)
      for (const press of take.press ?? []) {
        if (typeof press === 'number') {
          await new Promise((done) => setTimeout(done, press))
          continue
        }
        await driver.write(lane, Buffer.from(keystroke(press), 'utf8'))
        await settle(driver, lane, 250, 4_000)
      }
      await settle(driver, lane, 400, 6_000)
      const screen = await driver.capture(lane, { lines: rows, styled: true })
      const lines = screen.split('\n')
      while (lines.length < rows) lines.push('')
      const missed = new Set<string>()
      const grid = lines.map((line) => toCells(line, theme, (code) => missed.add(`SGR ${code}`)))
      const width = grid.reduce((most, row) => Math.max(most, row.length), 0)
      for (const row of grid)
        while (row.length < width) row.push({ ch: ' ', width: 1, ...blankPen() })
      out.push({ take, grid, rows: lines, unknown: [...missed] })
    }
  } finally {
    // The lane is this process's own child, so letting go of it is ending it:
    // there is nobody else to drive a window nobody can see.
    await driver.shutdown().catch(() => {})
    if (seeded) rmSync(seeded.base, { recursive: true, force: true })
  }
  return out
}

const blankPen = () => ({
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  reverse: false,
})

/**
 * The window as a person meets it, and the screens a machine with no agents
 * running can actually reach.
 *
 * Every one of these is a real key press away from the one before it. Nothing
 * that needs an agent is here — there is no agent to have — which is exactly
 * the line between what this can check and what the scenarios are for.
 */
export const TAKES: readonly Take[] = [
  {
    name: 'first-open',
    about: 'Tade opened on a project with nothing running yet: its repository, branch and files.',
    title: 'tade — a new project',
  },
  {
    name: 'keys',
    about: 'The keys sheet, as f1 opens it.',
    press: ['f1'],
    crop: 'panel',
  },
  {
    name: 'settings',
    about: 'Settings over the window, as ctrl+, opens it.',
    press: ['esc', 'ctrl+,'],
    crop: 'panel',
  },
  {
    name: 'extensions',
    about: 'The Extensions panel: what is ready, what needs setting up, what is turned off.',
    press: ['esc', 'ctrl+shift+e', 500],
    crop: 'panel',
  },
  {
    name: 'search',
    about: 'ctrl+k: one box over agents, files in every worktree and the lines inside them.',
    press: ['esc', 'ctrl+k', 'webhook', 400],
    crop: 'panel',
  },
  {
    name: 'a-terminal',
    about: 'A terminal opened in the project, in its own lane, with a real shell in it.',
    press: ['esc', 'ctrl+t', 600],
    title: 'tade — a terminal',
  },
]

/** Every code in a take's stream that nothing could read: empty is the answer wanted. */
export function unreadable(taken: readonly Taken[]): string[] {
  return [...new Set(taken.flatMap((one) => one.unknown))]
}

export { unknownSgr }
