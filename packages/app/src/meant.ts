import { fuzzy, looksLikePath, parseQuery, type SearchEntry } from './search.ts'

// Asking what a sentence meant, when matching its letters was not enough.
//
// `search.ts` matches letters. A sentence is not letters to match — "stop
// whoever is on the refunds thing" shares almost none of its characters with
// "Stop refunds", and fuzzy is right to find nothing. So when somebody writes
// a sentence, what is already in the list can be put to somebody who reads
// sentences — *alongside* whatever the letters found, never instead of it.
//
// The division is deliberate: code does the recall — which handful of the
// things Tade can do are worth putting to anybody — and whoever answers does
// the precision. Nothing here invents an entry, and nothing here runs one.
//
// What is put forward is a name, where it is, and what is happening about it
// (`about`), which is the half that makes this answer "what is going on" and
// not only "which of these names". It is also the half that leaves the
// machine, so how much of it does is bounded here and whether any of it does
// at all is a person's (`surfaces.search.context`).

/** Words a sentence carries that say nothing about what is wanted. */
const NOISE = new Set([
  'a',
  'an',
  'and',
  'are',
  'can',
  'do',
  'for',
  'from',
  'i',
  'in',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'please',
  'that',
  'the',
  'this',
  'to',
  'up',
  'was',
  'what',
  'where',
  'which',
  'with',
  'you',
])

/** Short of this, a sentence is a prefix somebody is still typing. */
export const SENTENCE_MIN = 8

/**
 * The words of a sentence that say anything about what is wanted.
 *
 * One reading, read twice: by what picks the shortlist out, and by what
 * decides whether the letters already answered. Two readings of "which words
 * does this sentence carry" is how the two halves come to disagree about the
 * same sentence.
 */
export function wordsIn(raw: string): string[] {
  return parseQuery(raw)
    .text.toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((word) => word.length >= 3 && !NOISE.has(word))
}

/** Whether what is in the box is a sentence rather than the start of a name. */
export function isSentence(raw: string): boolean {
  const { scope, text } = parseQuery(raw)
  if (scope === 'text') return false
  // A path is never one, however many words its folders are made of. This is
  // the one guard that keeps a pasted path out of everything that reads a
  // sentence, because `worthAsking` asks this first.
  if (looksLikePath(raw)) return false
  return text.length >= SENTENCE_MIN && text.trim().split(/\s+/).length >= 2
}

/**
 * Whether asking anybody is worth it: a sentence, and nothing came back that is
 * plainly the whole of it.
 *
 * It used to be "and the letters matched nothing at all", which is too tight in
 * exactly the way that matters. A sentence is long and a name is short, so what
 * a sentence matches is never the name and is always letters scattered down
 * some long label — the letters of `what the run` are all in
 * `Telemetry › What the brief counts`, in order, and mean nothing by it. One
 * such match was enough to silence the question for good: over three-word
 * sentences made of the words somebody would actually type, 418 of them came
 * back with one weak match apiece and were never asked about.
 *
 * So what counts as an answer is every word of the sentence that carries
 * meaning, said outright in one row's own name (`answered`). Anything short of
 * that, the question is still worth putting.
 *
 * Asking alongside is safe because what comes back only ever *adds* rows: the
 * letters keep everything they found and the order they found it in. Lines
 * inside files never counted and still do not — a sentence that appears in
 * somebody's code is not an answer to what they asked for.
 */
export function worthAsking(raw: string, found: readonly SearchEntry[]): boolean {
  if (!isSentence(raw)) return false
  const words = wordsIn(raw)
  return !found.some(
    (entry) => entry.kind !== 'file' && entry.kind !== 'match' && answered(words, entry),
  )
}

/**
 * Whether one row is plainly the whole of what was typed: every word of it
 * that carries any meaning, said outright in that row's own name.
 *
 * Two words at least, and that is the whole of the difference between this and
 * what it replaced. One word of a sentence found is a word found — "what is
 * the coverage" leaves `coverage`, and an agent called `coverage` answering it
 * is exactly the guess that made this feature necessary. Every word of it in
 * one name is somebody typing the name of a thing, which is already the first
 * row of the list.
 */
function answered(words: readonly string[], entry: SearchEntry): boolean {
  if (words.length < 2) return false
  const name = `${entry.label} ${entry.detail ?? ''}`.toLowerCase()
  return words.every((word) => name.includes(word))
}

/** How far above a name spelling a word, what is happening saying it outright counts. */
const SAID = 1_000

/**
 * How well one word of a sentence picks an entry out: what its name spells,
 * and a long way above that, what is happening about it saying that word in so
 * many letters.
 *
 * This is the recall half, and it is where the whole of "search knows what is
 * happening" lives: `coverage` is in the name of nothing and in what one agent
 * is doing, so without this the shortlist is a list of names and whoever reads
 * it is being asked to guess.
 */
function picks(word: string, entry: SearchEntry): number | null {
  const named = fuzzy(word, `${entry.label} ${entry.detail ?? ''}`)
  if ((entry.about ?? '').toLowerCase().includes(word)) return (named?.score ?? 0) + SAID
  return named?.score ?? null
}

/**
 * The few things worth putting to somebody, for a sentence the letters could
 * not place: whatever each word of it finds, and then the things Tade can do,
 * in the order it already keeps them — which is what needs you, then what you
 * can do here, then everything else.
 */
export function shortlist(
  raw: string,
  entries: readonly SearchEntry[],
  most: number,
): SearchEntry[] {
  const words = wordsIn(raw)
  const picked = new Map<string, SearchEntry>()
  for (const word of words) {
    const ranked = entries
      .map((entry) => ({ entry, score: picks(word, entry) }))
      .filter((one) => one.score !== null)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 3)
    for (const { entry } of ranked) if (!picked.has(entry.id)) picked.set(entry.id, entry)
  }
  // Topped up in the order the window keeps them, so a sentence whose words
  // match nothing at all is still answered with the things there are to do
  // rather than with nothing.
  for (const entry of entries) {
    if (picked.size >= most) break
    if (entry.kind === 'file' || entry.kind === 'match') continue
    if (!picked.has(entry.id)) picked.set(entry.id, entry)
  }
  return [...picked.values()].slice(0, most)
}

/**
 * How much of what is happening goes with one choice.
 *
 * A bound, because a shortlist is two dozen choices and every one of them
 * carries a paragraph: what one ask costs is this times that, and a number
 * nobody wrote down is a number that grows. Enough for what a thing is and
 * what is being done to it; the rest is on screen, where somebody is already
 * looking.
 */
export const ABOUT_ASKED = 300

/** What is happening about something, as much of it as one ask carries. */
export function askedAbout(about: string | undefined): string | undefined {
  if (!about) return undefined
  const said = about.replace(/\s+/g, ' ').trim()
  if (said === '') return undefined
  return said.length <= ABOUT_ASKED ? said : `${said.slice(0, ABOUT_ASKED)}…`
}
