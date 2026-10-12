import { constants, copyFileSync, existsSync, rmSync, statSync } from 'node:fs'
import { cpus, loadavg } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LaneId } from '@tade/core'
import { PtyDriver } from '@tade/drivers-pty'
import type { Size } from '../test/bench.ts'
import { seedHome } from './capture.ts'

// How long opening the window takes: from `tade app` being started to the
// first frame it draws, and then to when it stops moving.
//
//   pnpm bench open                       a seeded home: two projects and a journal of nothing
//   pnpm bench open --journal ~/.tade     the same home with that home's journal and index in it
//   pnpm bench open --runs 5              how many opens (each on a home of its own)
//
// `--journal` copies `events.jsonl` and its index (`events.jsonl.db` and its
// write-ahead log) and nothing else — no lanes, task files, schedules or
// config — so nothing can reopen or start, and what is timed is the journal's
// part of an open on a journal the size of a real one. Each run copies it
// afresh, because an open is allowed to rewrite both, and a second open of the
// same copy measures a journal the first one has already tidied.
//
// The first frame is the end of the window's first synchronized update
// (`ESC[?2026l`), which pi-tui wraps every frame in: the first byte is the
// alternate screen being entered, which costs nothing and draws nothing, so it
// is reported beside the frame and never instead of it. "Still" is the last
// byte before 1.5 s of nothing at all, which a spinner that keeps turning may
// never give; then it says so rather than reporting the deadline.

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..', '..')

/** The end of a synchronized update: one frame, written whole. */
const FRAME_END = '\x1b[?2026l'

/** Quiet for this long is a window that has stopped moving. */
const STILL_MS = 1_500

/** The longest an open is waited for, which is past anything ever measured. */
const MOST_MS = 120_000

/** Derived files that go with the journal, which a copy without is a stale index. */
const JOURNAL = ['events.jsonl', 'events.jsonl.db', 'events.jsonl.db-wal']

interface Opened {
  firstByte: number | null
  firstFrame: number | null
  still: number | null
}

/**
 * Copy a journal and its index into `home`, as they were at one moment.
 *
 * The home being copied from may have a window open on it, appending as it
 * goes; a copy of the journal from before an append beside an index from after
 * it disagree, and an index that disagrees with its journal is rebuilt — which
 * is the thing being measured, caused by the measuring. So the sizes are read
 * before and after, and a copy something was appended during is taken again.
 * A clone where the file system has them, so the window for that is short.
 */
function copyJournal(from: string, home: string): string | null {
  const sizes = () =>
    JOURNAL.map((name) => statSync(join(from, name), { throwIfNoEntry: false })?.size)
  if (!existsSync(join(from, 'events.jsonl'))) return `there is no events.jsonl in ${from}`
  for (let attempt = 0; attempt < 5; attempt++) {
    const before = sizes().join()
    for (const name of JOURNAL) {
      rmSync(join(home, name), { force: true })
      if (existsSync(join(from, name))) {
        copyFileSync(join(from, name), join(home, name), constants.COPYFILE_FICLONE)
      }
    }
    if (sizes().join() === before) return null
  }
  return `${from} was written to during every copy of it, so the index copied may disagree with the journal`
}

/** Open the window once on `home` and time it. */
async function openOnce(home: string, size: Size, run: number): Promise<Opened> {
  const driver = new PtyDriver({ attachCommand: (id) => `tade attach ${id}` })
  const lane = `bench/open/${run}` as LaneId
  const at: Opened = { firstByte: null, firstFrame: null, still: null }
  let last = 0
  let seen = ''
  try {
    const started = performance.now()
    const open = await driver.open({
      id: lane,
      cwd: repo,
      command: process.execPath,
      args: [join(repo, 'packages', 'cli', 'src', 'bin.ts'), 'app'],
      cols: size.width,
      rows: size.height,
      env: {
        TADE_HOME: home,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        NO_COLOR: '',
      },
    })
    const stop = driver.onOutput(lane, (bytes) => {
      const now = performance.now() - started
      last = now
      at.firstByte ??= now
      if (at.firstFrame !== null) return
      seen += Buffer.from(bytes).toString('latin1')
      if (seen.includes(FRAME_END)) at.firstFrame = now
    })
    try {
      while (performance.now() - started < MOST_MS) {
        await new Promise((done) => setTimeout(done, 20))
        if (at.firstFrame !== null && performance.now() - started - last >= STILL_MS) {
          at.still = last
          break
        }
      }
    } finally {
      stop()
    }
    // A clean stop, as quitting would be: the CLI turns SIGTERM into one, and
    // a window killed outright leaves its home locked for the next run.
    const pid = open.pid ?? (await driver.get(lane))?.pid ?? null
    if (pid !== null) {
      const exited = new Promise<void>((done) => {
        try {
          driver.onExit(lane, () => done())
        } catch {
          // The lane has already gone, which is the outcome being waited for.
          done()
        }
      })
      process.kill(pid, 'SIGTERM')
      await Promise.race([exited, new Promise((done) => setTimeout(done, 10_000))])
    }
  } finally {
    await driver.shutdown().catch(() => {})
  }
  return at
}

const ms = (value: number | null): string => (value === null ? '—' : `${Math.round(value)} ms`)

/** `pnpm bench open`: time to the first frame, `runs` times. */
export async function benchOpen(opts: {
  size: Size
  runs: number
  journal: string | null
  say: (text: string) => void
}): Promise<void> {
  const { say } = opts
  const title = `opening the window at ${opts.size.name}, on ${opts.journal ? `a seeded home with the journal of ${opts.journal}` : 'a seeded home'}`
  say(`\n${title}\n${'─'.repeat(title.length)}`)
  if (opts.journal) {
    const bytes = statSync(join(opts.journal, 'events.jsonl'), { throwIfNoEntry: false })?.size
    if (bytes !== undefined) say(`events.jsonl is ${(bytes / 1_048_576).toFixed(1)} MB`)
  }
  const frames: number[] = []
  for (let run = 0; run < opts.runs; run++) {
    const seeded = seedHome()
    try {
      const trouble = opts.journal ? copyJournal(opts.journal, seeded.home) : null
      if (trouble) say(`! ${trouble}`)
      const at = await openOnce(seeded.home, opts.size, run)
      if (at.firstFrame !== null) frames.push(at.firstFrame)
      // The load is per run and not once under the table, because these runs
      // take seconds each and the machine moves under them.
      const [one] = loadavg()
      say(
        `run ${run + 1}: first byte ${ms(at.firstByte)} · first frame ${ms(at.firstFrame)} · still ${at.firstFrame === null ? '—' : at.still === null ? 'never, in two minutes' : ms(at.still)} · load ${(one ?? 0).toFixed(1)} on ${cpus().length} cores`,
      )
    } finally {
      rmSync(seeded.base, { recursive: true, force: true })
    }
  }
  if (frames.length === 0) {
    say('! no run drew a frame, so there is no time to first frame to report')
    return
  }
  const sorted = frames.toSorted((a, b) => a - b)
  say(
    `first frame: best ${ms(sorted[0] ?? null)} · median ${ms(sorted[Math.floor(sorted.length / 2)] ?? null)} · worst ${ms(sorted.at(-1) ?? null)} over ${frames.length} run(s) · node ${process.versions.node}`,
  )
}
