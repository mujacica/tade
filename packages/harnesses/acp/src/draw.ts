import type { Drawn, Said } from './client.ts'

// What an ACP agent's lane shows: its conversation, drawn the way the
// orchestrator's strip draws Tade's (`app/src/transcript-view.ts`) — what you
// said after `❯`, its answers after `◆`, each tool it reaches for as a line of
// its own that spins while it runs and turns `✓` or `✗` after, and anything
// that went wrong after a red `✗`, in words. An ACP agent has no terminal of
// its own to put in a lane, so this is what is there instead.
//
// Pure: events in, lines out, so it can be held to what it draws without a
// terminal. `lane.ts` writes the lines; what is finished is printed once and
// scrolls away like any terminal's, and only what is still moving at the
// bottom — a reply arriving, a tool running, the line you type on — is drawn
// again in place.

export type Entry =
  | { kind: 'you'; text: string }
  | { kind: 'said'; text: string; streaming: boolean }
  | { kind: 'tool'; id: string; title: string; state: 'running' | 'ok' | 'failed'; result: string }
  | { kind: 'note'; text: string }
  | { kind: 'problem'; text: string }

export interface Screen {
  entries: Entry[]
  /** How many entries are printed for good, above the part still drawn again. */
  printed: number
  /** When the turn under way started, while it is. */
  thinking: number | null
  /** A tool call waiting on Tade to allow it: the line read back before approving. */
  held: string | null
  /** What is being typed. */
  draft: string
}

export function emptyScreen(): Screen {
  return { entries: [], printed: 0, thinking: null, held: null, draft: '' }
}

/** How a lane paints: the strip's tones, or nothing at all where colour is off. */
export interface Paint {
  you(text: string): string
  signal(text: string): string
  busy(text: string): string
  done(text: string): string
  bad(text: string): string
  hint(text: string): string
}

const sgr = (codes: string) => (text: string) => (text ? `\x1b[${codes}m${text}\x1b[0m` : text)
const same = (text: string) => text

/** The window's own tones (`app/src/skin.ts`): amber for Tade and what it does, and so on. */
export function paintFor(colour: boolean): Paint {
  if (!colour) return { you: same, signal: same, busy: same, done: same, bad: same, hint: same }
  return {
    you: sgr('38;5;255;1'),
    signal: sgr('38;5;214;1'),
    busy: sgr('38;5;214'),
    done: sgr('38;5;114'),
    bad: sgr('38;5;203'),
    hint: sgr('38;5;246'),
  }
}

const SPINNER = '⠋⠙⠸⢰⣠⣄⡆⠇'
const SPIN_MS = 100

export function spinner(now: number): string {
  return SPINNER[Math.floor(now / SPIN_MS) % SPINNER.length] ?? '⠋'
}

function push(screen: Screen, entry: Entry): Screen {
  return { ...screen, entries: [...screen.entries, entry] }
}

/** Whatever was arriving has arrived. */
function settleSaying(screen: Screen): Screen {
  const last = screen.entries.at(-1)
  if (last?.kind !== 'said' || !last.streaming) return screen
  return { ...screen, entries: [...screen.entries.slice(0, -1), { ...last, streaming: false }] }
}

/** What the lane itself has to say, or what was sent. */
export function drawn(screen: Screen, event: Drawn): Screen {
  const settled = settleSaying(screen)
  switch (event.kind) {
    case 'you':
      return push({ ...settled, held: null }, { kind: 'you', text: event.text })
    case 'note':
      return push(settled, { kind: 'note', text: event.text })
    case 'problem':
      return push(settled, { kind: 'problem', text: event.text })
  }
}

/** What a signal the lane sends Tade looks like in the lane. */
export function signalled(screen: Screen, said: Said, now: number): Screen {
  const last = screen.entries.at(-1)
  switch (said.type) {
    case 'turn_started':
      return { ...screen, thinking: now }
    case 'message_delta':
      if (last?.kind === 'said' && last.streaming && screen.entries.length > screen.printed) {
        return {
          ...screen,
          entries: [...screen.entries.slice(0, -1), { ...last, text: last.text + said.text }],
        }
      }
      return push(settleSaying(screen), { kind: 'said', text: said.text, streaming: true })
    case 'message':
      // The whole block, which is the truth about what the parts added up to.
      if (last?.kind === 'said' && last.streaming && screen.entries.length > screen.printed) {
        return {
          ...screen,
          entries: [
            ...screen.entries.slice(0, -1),
            { kind: 'said', text: said.text, streaming: false },
          ],
        }
      }
      if (last?.kind === 'said' && last.text === said.text) return screen
      return push(settleSaying(screen), { kind: 'said', text: said.text, streaming: false })
    case 'tool_call': {
      const input = (said.input ?? {}) as { title?: unknown; command?: unknown }
      const title =
        typeof input.command === 'string'
          ? input.command
          : typeof input.title === 'string'
            ? input.title
            : said.tool
      return push(settleSaying(screen), {
        kind: 'tool',
        id: said.callId,
        title,
        state: 'running',
        result: '',
      })
    }
    case 'tool_result': {
      const at = screen.entries.findLastIndex(
        (entry) => entry.kind === 'tool' && entry.id === said.callId,
      )
      const was = screen.entries[at]
      if (at < 0 || was?.kind !== 'tool') return screen
      const done: Entry = {
        ...was,
        state: said.ok ? 'ok' : 'failed',
        result: said.summary ?? '',
      }
      // Printed already, so it cannot be drawn again: how it went is a line of its own.
      if (at < screen.printed) return push(screen, done)
      const entries = [...screen.entries]
      entries[at] = done
      return { ...screen, entries }
    }
    case 'idle':
      return { ...settleSaying(screen), thinking: null, held: null }
    case 'turn_done':
      return settleSaying(screen)
    case 'failed':
      return push(
        { ...settleSaying(screen), thinking: null },
        { kind: 'problem', text: said.error },
      )
    case 'exited':
      return push(
        { ...settleSaying(screen), thinking: null },
        { kind: 'problem', text: `the agent exited${said.code === null ? '' : ` (${said.code})`}` },
      )
    case 'permission_request':
      return { ...screen, held: said.summary }
    case 'permission_resolved':
      return { ...screen, held: null }
    default:
      return screen
  }
}

/** Text wrapped to a width, the first line led by `lead` and the rest indented to match. */
export function wrapped(text: string, width: number, lead: string, leadWidth: number): string[] {
  const room = Math.max(8, width - leadWidth)
  const indent = ' '.repeat(leadWidth)
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    for (const piece of wrapLine(paragraph, room)) {
      out.push(`${out.length === 0 ? lead : indent}${piece}`)
    }
  }
  return out
}

/** One line cut at spaces where it can be and mid-word where it cannot, never dropping any of it. */
function wrapLine(line: string, room: number): string[] {
  const chars = [...line]
  if (chars.length <= room) return [line]
  const out: string[] = []
  let rest = chars
  while (rest.length > room) {
    let cut = rest.lastIndexOf(' ', room)
    if (cut <= 0) cut = room
    out.push(rest.slice(0, cut).join('').trimEnd())
    rest = [...rest.slice(cut).join('').trimStart()]
  }
  out.push(rest.join(''))
  return out
}

/** The lines one entry is drawn as. */
export function entryLines(entry: Entry, width: number, paint: Paint, now: number): string[] {
  switch (entry.kind) {
    case 'you':
      return paintAfterLead(wrapped(entry.text, width, '❯ ', 2), paint.you('❯'), paint.you)
    case 'said': {
      const lines = wrapped(entry.text.replace(/\n+$/, ''), width, '◆ ', 2)
      const out = paintAfterLead(lines, paint.signal('◆'), same)
      if (entry.streaming && out.length > 0) out[out.length - 1] = `${out.at(-1)}${paint.busy('▍')}`
      return out
    }
    case 'tool': {
      const mark =
        entry.state === 'running'
          ? paint.busy(spinner(now))
          : entry.state === 'ok'
            ? paint.done('✓')
            : paint.bad('✗')
      const paintTitle = entry.state === 'failed' ? paint.bad : paint.hint
      const head = wrapped(entry.title, width, '    ', 4).map(
        (line, i) => `${i === 0 ? `  ${mark} ` : '    '}${paintTitle(line.slice(4))}`,
      )
      if (entry.state === 'failed' && entry.result) {
        return [...head, ...wrapped(entry.result, width, '    ', 4).map(paint.bad)]
      }
      if (entry.state === 'ok' && entry.result) {
        const first = entry.result.split('\n').find((line) => line.trim() !== '') ?? ''
        if (first)
          return [...head, ...wrapped(first.trim(), width, '    ', 4).slice(0, 1).map(paint.hint)]
      }
      return head
    }
    case 'note':
      return paintAfterLead(wrapped(entry.text, width, '● ', 2), paint.busy('●'), paint.hint)
    case 'problem':
      return paintAfterLead(wrapped(entry.text, width, '✗ ', 2), paint.bad('✗'), paint.bad)
  }
}

/** Lines wrapped with a plain two-cell lead, the lead swapped for its painted mark and the rest painted. */
function paintAfterLead(lines: string[], mark: string, body: (text: string) => string): string[] {
  return lines.map((line, i) => `${i === 0 ? `${mark} ` : '  '}${body(line.slice(2))}`)
}

/** Whether an entry can still change, and so is drawn again rather than printed for good. */
function moving(entry: Entry): boolean {
  return (
    (entry.kind === 'said' && entry.streaming) ||
    (entry.kind === 'tool' && entry.state === 'running')
  )
}

export interface Frame {
  /** Lines to print for good, above everything else. */
  print: string[]
  /** How many entries that prints, counted from the first. */
  printed: number
  /** The lines drawn again in place at the bottom. The last is the one you type on. */
  live: string[]
}

/**
 * What to put on the terminal now. Everything up to the first thing still
 * moving is printed for good; the rest is drawn at the bottom, and if that
 * would be taller than `rows` allows, the oldest of it is printed for good
 * too — a tool that finishes after its line has scrolled away is said again,
 * on a line of its own.
 */
export function frame(
  screen: Screen,
  width: number,
  rows: number,
  paint: Paint,
  now: number,
): Frame {
  const room = Math.max(3, rows - 1)
  let printed = screen.printed
  while (printed < screen.entries.length && !moving(screen.entries[printed] as Entry)) printed++
  const footer = footerLines(screen, width, paint, now)
  const liveOf = (from: number) =>
    screen.entries.slice(from).flatMap((entry) => entryLines(entry, width, paint, now))
  let live = liveOf(printed)
  while (live.length + footer.length > room && printed < screen.entries.length) {
    printed++
    live = liveOf(printed)
  }
  const print = screen.entries
    .slice(screen.printed, printed)
    .flatMap((entry) => entryLines(entry, width, paint, now))
  return { print, printed, live: [...live, ...footer] }
}

function footerLines(screen: Screen, width: number, paint: Paint, now: number): string[] {
  const out: string[] = []
  const last = screen.entries.at(-1)
  const quiet =
    !(last?.kind === 'said' && last.streaming) &&
    !screen.entries
      .slice(screen.printed)
      .some((entry) => entry.kind === 'tool' && entry.state === 'running')
  if (screen.held !== null) {
    out.push(
      ...wrapped(`waiting for Tade to allow: ${screen.held}`, width, `  ◇ `, 4).map(paint.hint),
    )
  } else if (screen.thinking !== null && quiet) {
    const seconds = Math.max(0, Math.floor((now - screen.thinking) / 1000))
    const words = ['thinking', ...(seconds >= 2 ? [`${seconds}s`] : []), 'esc stops it'].join(' · ')
    out.push(`  ${paint.busy(spinner(now))} ${paint.hint(words)}`)
  }
  // The line you type on: always last, and never wrapped — what does not fit scrolls.
  const room = Math.max(4, width - 3)
  const draft = [...screen.draft.replace(/\n/g, '⏎')]
  const shown =
    draft.length > room ? `…${draft.slice(draft.length - room + 1).join('')}` : draft.join('')
  out.push(`${paint.you('❯')} ${shown}`)
  return out
}

/** Whether anything on screen moves by itself, so the lane redraws on a timer only then. */
export function animating(screen: Screen): boolean {
  return (
    screen.thinking !== null ||
    screen.entries
      .slice(screen.printed)
      .some((entry) => entry.kind === 'tool' && entry.state === 'running')
  )
}
