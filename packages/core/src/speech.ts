// What a voice should say, out of what a model wrote.
//
// A model answers in Markdown: fences, paths, bold, tables, triple quotes.
// Read out loud that becomes "backtick backtick backtick t s", and then the
// whole answer, when what was wanted was the finding. Both are settled here.
//
// Two jobs, kept apart. `speakable` takes the markup out and leaves the words
// — everything Tade says goes through it, however short. `spokenSummary` also
// stops: a few sentences, and the rest stays on the screen where it can be
// read. Pure, so what gets said is a diff in review rather than a mood.

export interface SpeechLimits {
  /** Sentences said out loud before the rest is left to the screen. */
  sentences: number
  /** ...and characters, whichever runs out first. */
  chars: number
}

/**
 * Three clauses is the most anyone follows down one earbud, which is the same
 * reason `describeWork` stops at three. Long enough for a finding and why.
 */
export const SPOKEN_LIMITS: SpeechLimits = { sentences: 3, chars: 320 }

/** Said once when an answer was longer than anyone wants read to them. */
export const REST_ON_SCREEN = 'The rest is on screen.'

/**
 * The words of a piece of Markdown: no fences, no code, no paths read out
 * segment by segment, no emphasis, no link targets. Never an empty answer
 * where there were words — only where there was nothing but markup.
 */
export function speakable(markdown: string): string {
  const lines = scanBlocks(markdown)
    .without.split('\n')
    .map(speakableLine)
    .filter((line) => line !== '')
  if (lines.length === 0) return ''
  if (lines.length === 1) return lines[0] ?? ''
  // Joined into one breath, so a heading does not run into the line under it.
  return lines
    .map((line, i) => (i === lines.length - 1 || /[.!?:,;]$/.test(line) ? line : `${line}.`))
    .join(' ')
}

/**
 * The short of it: the leading sentences, and a word about the rest. A model
 * leads with its finding and follows with the detail, so the front of an
 * answer is the summary — and what is cut is on the screen, not lost.
 */
export function spokenSummary(markdown: string, limits: Partial<SpeechLimits> = {}): string {
  const { sentences, chars } = { ...SPOKEN_LIMITS, ...limits }
  const words = speakable(markdown)
  if (words === '') return ''

  const parts = splitSentences(words)
  const kept: string[] = []
  let length = 0
  for (const part of parts) {
    if (kept.length >= Math.max(1, sentences)) break
    if (kept.length > 0 && length + 1 + part.length > chars) break
    kept.push(part)
    length += (kept.length > 1 ? 1 : 0) + part.length
  }

  // One sentence longer than the whole budget is still said, cut at a word:
  // stopping dead is worse than a sentence that trails off.
  const first = kept[0] ?? ''
  if (kept.length === 1 && first.length > chars) kept[0] = clip(first, chars)
  const said = kept.join(' ')
  return said === words ? said : `${said} ${REST_ON_SCREEN}`
}

/**
 * A reply as it streams: the sentences that can be said now, and what has to
 * wait. A code fence that has not closed yet waits for its other half, because
 * half a fence is exactly the "triple backtick" nobody wants read to them.
 */
export function speakableSoFar(buffered: string): { say: string[]; keep: string } {
  const { without, open } = scanBlocks(buffered)
  const pending = open === -1 ? '' : buffered.slice(open)

  const say: string[] = []
  let rest = without
  for (let end = SENTENCE_END.exec(rest); end; end = SENTENCE_END.exec(rest)) {
    const sentence = rest.slice(0, end.index + end[0].length)
    rest = rest.slice(end.index + end[0].length)
    const words = speakable(sentence)
    if (words !== '') say.push(words)
  }
  return { say, keep: rest + pending }
}

/** Where a sentence stops: punctuation and a breath, or a line of its own. */
const SENTENCE_END = /[.!?]\s+|\n+/

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

function clip(text: string, chars: number): string {
  const cut = text.slice(0, chars)
  const space = cut.lastIndexOf(' ')
  return (space > chars / 2 ? cut.slice(0, space) : cut).trim()
}

/**
 * Blocks taken out in one pass: what is left to say, and where a block that
 * nobody has closed yet begins (-1 when none does). Both come from the same
 * scan because they are the same question asked of a finished answer and of
 * one still arriving.
 */
function scanBlocks(text: string): { without: string; open: number } {
  const out: string[] = []
  let from = 0
  let openedAt = -1
  let marker: string | null = null
  for (const found of text.matchAll(/```|~~~|"""|'''/g)) {
    const fence = found[0]
    if (marker === null) {
      marker = fence
      openedAt = found.index
      out.push(text.slice(from, found.index))
    } else if (fence === marker) {
      marker = null
      openedAt = -1
      from = found.index + fence.length
    }
  }
  // An unterminated block takes the rest with it: nothing else can be said
  // about text we cannot see the end of.
  if (marker === null) out.push(text.slice(from))
  return { without: out.join(''), open: openedAt }
}

function speakableLine(raw: string): string {
  let line = raw.trim()
  if (line === '') return ''
  // A rule across the page is a pause, not a word.
  if (/^([-*_=])\1{2,}$/.test(line)) return ''
  // The dashes under a table's header, likewise.
  if (/^\|?[\s:|-]+\|[\s:|-]*$/.test(line)) return ''
  if (line.startsWith('|')) {
    line = line
      .split('|')
      .map((cell) => cell.trim())
      .filter((cell) => cell !== '')
      .join(', ')
  }

  line = line
    .replace(/^>+\s?/, '') // quoted
    .replace(/^#{1,6}\s*/, '') // a heading is a sentence
    .replace(/^[-*+]\s+/, '') // a bullet
    .replace(/^\d+[.)]\s+/, '') // a numbered one
    .replace(/^\[[ xX]\]\s*/, '') // a checkbox
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // a picture says nothing
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // a link says its words
    .replace(/<https?:\/\/[^>]*>/g, '')
    .replace(/\bhttps?:\/\/\S+/g, '')
    .replace(/`([^`]*)`/g, (_, code: string) => sayCode(code))
    .replace(/<\/?[a-zA-Z][^>]*>/g, '') // html
    .replace(/[`]{1,3}|"""|'''/g, '')
    .replace(/(\*\*|__|~~)(.*?)\1/g, '$2')
    .replace(/(?<![\w*])\*(?!\s)([^*]+?)\*(?![\w*])/g, '$1')
    .replace(/(?<![\w_])_(?!\s)([^_]+?)_(?![\w_])/g, '$1')

  line = line.replace(/\S*\/\S*/g, (token) => sayPath(token))

  return line
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .trim()
}

/**
 * Inline code, where it is words. `pnpm check` is a thing to say;
 * `this.opts.speaker.speak(text)` is a thing to look at, and is dropped rather
 * than spelled out.
 */
function sayCode(code: string): string {
  const said = code.trim()
  if (said === '') return ''
  if (said.includes('/')) {
    const path = sayPath(said)
    return path.length <= 40 ? path : ''
  }
  return said.length <= 30 && /^[A-Za-z0-9][\w .@-]*$/.test(said) ? said : ''
}

/**
 * A path, as much of it as is worth hearing: the file's own name. Nobody needs
 * "packages slash app slash source slash app dot t s" read to them.
 *
 * Only where it is really a path — rooted, or deep, or ending in a file. One
 * slash between two words is "and/or" far more often than it is a directory.
 */
function sayPath(token: string): string {
  const [, path = '', tail = ''] = /^(.*?)([.,;:!?)\]]*)$/.exec(token) ?? []
  if (!path.includes('/') || !/[a-zA-Z]/.test(path)) return token
  const parts = path.split('/').filter((part) => part !== '')
  const last = parts.at(-1) ?? ''
  const rooted = /^[~./]?\//.test(path)
  if (parts.length > 2 || rooted || /\.[a-zA-Z0-9]{1,5}$/.test(last)) return `${last}${tail}`
  return token
}
