import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import { taskOrigin } from '@tade/core'
import type { Frame } from '../frame.ts'

// Width, words, paths, moments and numbers: the small answers every region of
// the window needs and none of them owns.
//
// These are here because the measurement said so rather than because a folder
// wanted filling — `shortened` alone is used 29 times across the drawing. A
// helper one region uses lives in that region's file; this one is for what is
// genuinely everybody's.

/** As much of a line as fits, ending at a word where one ends in time. */
export function cutAtWord(line: string, room: number): string {
  const cut = line.slice(0, room)
  const space = cut.lastIndexOf(' ')
  return space > room / 2 ? cut.slice(0, space) : cut
}

/** Text that fits a width, ending in `…` when it had to be cut. */
export function shortened(text: string, room: number): string {
  return visibleWidth(text) <= room ? text : truncateToWidth(text, Math.max(1, room), '…')
}

/**
 * A sentence that fits a width, ending in `…` when it had to be cut — and at
 * a word, where one ends in time. A word cut through its middle is the
 * difference between a line somebody reads and a fragment of one; a name or a
 * path has no words to cut at, which is why this is only for what was said.
 */
export function saidShort(text: string, room: number): string {
  if (visibleWidth(text) <= room) return text
  const hard = truncateToWidth(text, Math.max(1, room), '…')
  const body = hard.slice(0, -1)
  const space = body.lastIndexOf(' ')
  return space > body.length / 2 ? `${body.slice(0, space).trimEnd()}…` : hard
}

/** Plain words to a width, broken between words where it can be. */
export function wrapWords(text: string, width: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (!line) line = word
      else if (visibleWidth(`${line} ${word}`) <= width) line = `${line} ${word}`
      else {
        lines.push(line)
        line = word
      }
      while (visibleWidth(line) > width) {
        lines.push(truncateToWidth(line, width, ''))
        line = line.slice(truncateToWidth(line, width, '').length)
      }
    }
    lines.push(line)
  }
  return lines
}

/** A path in lines of a width, broken after a slash where it can be, and anywhere where it cannot. */
export function wrapPath(path: string, width: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const part of path.split(/(?<=\/)/)) {
    if (line !== '' && line.length + part.length > width) {
      lines.push(line)
      line = ''
    }
    line += part
    while (line.length > width) {
      lines.push(line.slice(0, width))
      line = line.slice(width)
    }
  }
  if (line !== '' || lines.length === 0) lines.push(line)
  return lines
}

/** The end of something too long, which for a branch is the part that names it. */
export function tailOf(text: string, room: number): string {
  return text.length <= room ? text : `…${text.slice(-Math.max(1, room - 1))}`
}

/** `src/payments/webhooks.test.ts` → `…/webhooks.test.ts`: the name is the part you know. */
export function shortPath(path: string, room: number): string {
  if (path.length <= room) return path
  const name = path.split('/').at(-1) ?? path
  const short = `…/${name}`
  return short.length <= room ? short : `…${name.slice(-Math.max(1, room - 1))}`
}

/** The first letter of a phrase as the start of a sentence. */
export function capitalised(text: string): string {
  return text ? `${text[0]?.toUpperCase() ?? ''}${text.slice(1)}` : text
}

/** `anthropic/claude-opus-5` reads as `claude-opus-5`: the provider is said separately. */
export function shortModel(model: string): string {
  return model.split('/').at(-1) ?? model
}

/** A task's name without its project, which the list it is in already says. */
export function inProject(project: string, text: string): string {
  return text.replaceAll(`${project}/`, '')
}

/** Who asked for queued work, in a word. */
export function askedBy(by: string | undefined): string {
  const origin = taskOrigin(by)
  return origin.kind === 'you' ? 'you' : origin.name
}

/**
 * Who asked, as short as the row under a name needs: the marks the
 * conversation is drawn with — ❯ what you said, ◆ the orchestrator — or an
 * extension's or a schedule's own name.
 */
export function askedMark(by: string | undefined): string {
  const origin = taskOrigin(by)
  return origin.kind === 'you' ? '❯' : origin.kind === 'orchestrator' ? '◆' : origin.name
}

// ── Moments, the way people read them ────────────────────────────────────────

export function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** A moment, said the way the frame says moments. */
export function clockOf(frame: Frame): (at: number) => string {
  return (
    frame.clock ??
    ((at) => {
      const time = new Date(at)
      return `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`
    })
  )
}

/**
 * How long a check took, to the second it took: `2.1s`, `1m 04s`. Not
 * `duration`, which rounds a minute and four seconds to a minute — the
 * seconds are the whole of what somebody watching a suite is reading.
 */
export function spell(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds))
  if (whole < 60) return `${seconds < 10 ? seconds.toFixed(1) : whole}s`
  return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, '0')}s`
}

// ── Numbers, the way people read them ────────────────────────────────────────

export function tokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M tok`
  if (count >= 1_000) return `${Math.round(count / 1_000)}k tok`
  return `${count} tok`
}

export function dollars(usd: number): string {
  return usd >= 100 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`
}
