// What a run's output says, read back out of what it printed.
//
// A run already carries a `summary` — one line, the last thing the command
// said — and that is all the record ever claimed. But "8 failed" is not what a
// person wants from a red suite: they want how many passed, which files the
// formatter would change, where the type errors are. All of that was printed;
// nothing here asks anything again.
//
// So this is a reader of other people's output, and it obeys the rule every
// other one in Tade does: **nothing is invented**. A number appears here only
// where the command printed it, in a shape we know; an output nothing here
// recognises reads as no counts and no places, which the window says as "it
// printed nothing we can break down" rather than as a green tick. It never
// throws — a tail is a few thousand characters of someone else's format, cut
// mid-line at the front, and a parser that throws on that takes the page with
// it.

/** One number a command printed about itself: `404 passed`, `8 failed`. */
export interface CheckCount {
  /** As the command said it: `passed`, `failed`, `skipped`, `errors`, `files checked`. */
  label: string
  count: number
  /** How it reads: a failure is bad, a pass is good, a count is neither. */
  tone: 'good' | 'bad' | 'quiet'
}

/** A file the command named, and what it said about it. */
export interface CheckPlace {
  path: string
  /** Where in it, as printed: `12:3`. Null where it named no place. */
  at: string | null
  /** What it said: `TS2345: Argument of type…`, `lint/complexity/noForEach`. */
  note: string | null
}

/** What one run's output amounts to: its numbers, and the files it named. */
export interface CheckOutcome {
  counts: readonly CheckCount[]
  places: readonly CheckPlace[]
  /** Files it named beyond the ones kept. */
  more: number
  /** Whether anything here was recognised at all. */
  read: boolean
}

const NOTHING: CheckOutcome = { counts: [], places: [], more: 0, read: false }

/** How many files are kept unless the caller wants fewer or more. */
const PLACES = 6

/**
 * Read a run's output. `places` caps the files kept; the rest are counted in
 * `more`, because a type error in forty files is a fact and forty rows is not
 * a page.
 */
export function readOutcome(tail: string, opts: { places?: number } = {}): CheckOutcome {
  const text = plain(tail)
  if (text.trim() === '') return NOTHING
  const lines = text.split('\n')
  const counts: CheckCount[] = []
  const places: CheckPlace[] = []
  for (const read of READERS) {
    read(lines, counts, places)
  }
  if (counts.length === 0 && places.length === 0) return NOTHING
  const kept = Math.max(1, opts.places ?? PLACES)
  const unique = dedupe(places)
  return {
    counts,
    places: unique.slice(0, kept),
    more: Math.max(0, unique.length - kept),
    read: true,
  }
}

/** Every reader, tried in turn: an output can be two tools' at once (`pnpm check`). */
const READERS: ((lines: readonly string[], counts: CheckCount[], places: CheckPlace[]) => void)[] =
  [readVitest, readJest, readBiome, readTsc]

/**
 * Vitest, which says it twice — files and tests — and is read for the tests,
 * since that is the number somebody asked for. Its failures are the `❯` and
 * `FAIL` lines above the summary.
 */
function readVitest(lines: readonly string[], counts: CheckCount[], places: CheckPlace[]): void {
  const summary = lines.filter((line) => /^\s*Tests\s{2,}/.test(line)).at(-1)
  if (summary) counts.push(...bars(summary.replace(/^\s*Tests\s+/, '')))
  const files = lines.filter((line) => /^\s*Test Files\s{2,}/.test(line)).at(-1)
  if (files) {
    const failed = bars(files.replace(/^\s*Test Files\s+/, '')).find(
      (one) => one.label === 'failed',
    )
    // Only the failing file count: "152 passed" twice over is noise.
    if (failed) counts.push({ ...failed, label: 'files failed' })
  }
  if (!summary && !files) return
  for (const line of lines) {
    const fail = /^\s*(?:FAIL|❯)\s+(\S+\.[A-Za-z]\w*)(?::(\d+:\d+))?(?:\s*>\s*(.*))?\s*$/.exec(line)
    if (fail?.[1]) {
      places.push({ path: fail[1], at: fail[2] ?? null, note: (fail[3] ?? '').trim() || null })
    }
  }
}

/** `Tests:  3 failed, 40 passed, 43 total` — jest, and everything that copied it. */
function readJest(lines: readonly string[], counts: CheckCount[], _places: CheckPlace[]): void {
  if (counts.length > 0) return
  const line = lines.filter((one) => /^\s*Tests:\s/.test(one)).at(-1)
  if (!line) return
  for (const part of line.replace(/^\s*Tests:\s*/, '').split(',')) {
    const one = /^\s*(\d+)\s+([a-z]+)\s*$/.exec(part)
    if (one?.[1] && one[2] && one[2] !== 'total') {
      counts.push({ label: one[2], count: Number(one[1]), tone: toneOf(one[2]) })
    }
  }
}

/**
 * Biome: `Checked 493 files in 297ms.`, `Found 9 errors.`, and a header line
 * per diagnostic — `packages/app/src/view.ts:12:1 lint/… ━━━`. The `ci ━━━`
 * banner at the end is the command naming itself, not a file.
 */
function readBiome(lines: readonly string[], counts: CheckCount[], places: CheckPlace[]): void {
  const checked = lines.map((line) => /^Checked (\d+) files? in /.exec(line)).find(Boolean)
  if (checked?.[1]) {
    counts.push({ label: 'files checked', count: Number(checked[1]), tone: 'quiet' })
  }
  for (const word of ['errors', 'warnings', 'infos']) {
    const one = lines
      .map((line) => new RegExp(`^Found (\\d+) (?:${word}|${word.slice(0, -1)})\\.`).exec(line))
      .find(Boolean)
    if (one?.[1]) {
      counts.push({
        label: word,
        count: Number(one[1]),
        tone: word === 'errors' ? 'bad' : 'quiet',
      })
    }
  }
  if (!checked) return
  for (const line of lines) {
    const one =
      /^(\S*[./]\S*?)(?::(\d+:\d+))?\s+((?:format|lint|assist|organizeImports)\S*)\s+/.exec(line)
    if (one?.[1])
      places.push({ path: one[1].replace(/^\.\//, ''), at: one[2] ?? null, note: one[3] ?? null })
  }
}

/** `packages/app/src/view.ts(12,3): error TS2345: …`, and `Found 5 errors in 2 files.` */
function readTsc(lines: readonly string[], counts: CheckCount[], places: CheckPlace[]): void {
  const errors: CheckPlace[] = []
  for (const line of lines) {
    const one = /^(\S+)\((\d+),(\d+)\): error (TS\d+: .*)$/.exec(line)
    if (one?.[1]) errors.push({ path: one[1], at: `${one[2]}:${one[3]}`, note: one[4] ?? null })
  }
  const found = lines
    .map((line) => /^Found (\d+) errors? in (\d+) files?\./.exec(line))
    .find(Boolean)
  if (found?.[1]) {
    counts.push({ label: 'type errors', count: Number(found[1]), tone: 'bad' })
  } else if (errors.length > 0) {
    // What the tail holds, which may be the end of a longer list: said as
    // what it is rather than as the total, which nobody printed.
    counts.push({ label: 'type errors', count: errors.length, tone: 'bad' })
  }
  places.push(...errors)
}

/** `4 failed | 2072 passed | 3 skipped (2079)` → the three numbers, in that order. */
function bars(text: string): CheckCount[] {
  const out: CheckCount[] = []
  for (const part of text.split('|')) {
    const one = /^\s*(\d+)\s+([a-z]+)\s*(?:\(\d+\))?\s*$/.exec(part)
    if (one?.[1] && one[2]) out.push({ label: one[2], count: Number(one[1]), tone: toneOf(one[2]) })
  }
  return out
}

function toneOf(word: string): CheckCount['tone'] {
  if (word === 'passed') return 'good'
  if (word === 'failed') return 'bad'
  return 'quiet'
}

/** One row per file and place: the same error printed twice is one place. */
function dedupe(places: readonly CheckPlace[]): CheckPlace[] {
  const seen = new Set<string>()
  const out: CheckPlace[] = []
  for (const place of places) {
    const key = `${place.path}:${place.at ?? ''}:${place.note ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(place)
  }
  return out
}

// Built from character codes rather than written as escapes: an escape in a
// regex literal is usually a mistake, and here it is the whole point.
const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const SEQUENCES = [
  new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, 'g'),
  new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g'),
  new RegExp(`${ESC}[()][A-Za-z0-9]`, 'g'),
]

/**
 * The text without what a terminal would have eaten: colour, cursor moves and
 * the carriage returns a progress line rewrites itself with.
 */
function plain(text: string): string {
  let out = text
  for (const sequence of SEQUENCES) out = out.replace(sequence, '')
  return out.replace(/\r/g, '\n')
}
