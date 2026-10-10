import { basename } from 'node:path'
import { stripTerminalSequences, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import type { Hit, Target } from './hits.ts'
import { type Linker, linkedRow } from './links.ts'
import { spinner } from './model.ts'
import type { Skin } from './skin.ts'
import { type Entry, type Transcript, toolName } from './transcript.ts'
import { fit, type Pointer, Row } from './ui.ts'
import { markdownLines } from './viewer.ts'

// The conversation with the orchestrator, laid out like a terminal you read:
// your words after `❯`, what it did as a line each — spinning while it works,
// `✓` or `✗` after — and its answers as formatted text. Nothing is cut at the
// edge; long lines wrap, because the part past the edge is usually the reason.

export interface Line {
  text: string
  /** Row-relative: every hit is on row 0. */
  hits: Hit[]
}

/** Formatting the same answer at the same width again is wasted work on every frame. */
const formatted = new Map<string, string[]>()

function markdown(text: string, width: number, plain: boolean): string[] {
  const key = `${width}\0${plain ? 1 : 0}\0${text}`
  const hit = formatted.get(key)
  if (hit) return hit
  const lines = markdownLines(text, width, plain)
  while (lines.length > 0 && stripTerminalSequences(lines.at(-1) ?? '').trim() === '') lines.pop()
  if (formatted.size > 400) formatted.clear()
  formatted.set(key, lines)
  return lines
}

/** Text wrapped to a width, with the first line led by `lead` and the rest indented to match. */
function wrapped(
  text: string,
  width: number,
  lead: string,
  paint: (text: string) => string,
): string[] {
  const indent = ' '.repeat(visibleWidth(lead))
  const room = Math.max(8, width - visibleWidth(lead))
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    const pieces = paragraph === '' ? [''] : wrapTextWithAnsi(paragraph, room)
    for (const piece of pieces) out.push(`${out.length === 0 ? lead : indent}${paint(piece)}`)
  }
  return out
}

export function transcriptLines(
  transcript: Transcript,
  width: number,
  skin: Skin,
  pointer: Pointer,
  now: number,
  linkers: readonly Linker[] = [],
  /**
   * Escape stops the turn, as its harness declares it can. Said beside the
   * spinner and nowhere else: the one moment the key does anything is the one
   * moment worth saying it, which is where every harness says it too.
   */
  stoppable = false,
): Line[] {
  const lines: Line[] = []
  const plainText = (text: string) => lines.push({ text: fit(text, width), hits: [] })
  const linked = (text: string) => lines.push(linkedRow(text, width, skin, pointer, linkers))

  // Nothing said yet: how to read what will be.
  if (transcript.entries.length === 0) {
    plainText(
      ` ${skin.you('❯')} ${skin.hint('what you say   ')}${skin.signal('◆')} ${skin.hint('the orchestrator   ')}${skin.busy('●')} ${skin.hint('what Tade did   ')}${skin.done('✓')}${skin.bad('✗')} ${skin.hint('its tools')}`,
    )
  }

  transcript.entries.forEach((entry, index) => {
    // A breath before each thing you said, so exchanges read as exchanges.
    if (entry.kind === 'you' && index > 0) plainText('')
    for (const line of entryLines(entry, width, skin, now)) {
      if (line.linkable) linked(line.text)
      else if (line.target) {
        const row = new Row(width, skin, pointer)
        row.text(line.text)
        row.right((r) => r.button('ask', line.target as Target).space())
        const built = row.build()
        lines.push({ text: built.text, hits: built.hits })
      } else plainText(line.text)
    }
  })

  const last = transcript.entries.at(-1)
  const busy =
    transcript.thinking !== null &&
    !(last?.kind === 'said' && last.streaming) &&
    !transcript.entries.some((entry) => entry.kind === 'tool' && entry.state === 'running')
  if (busy && transcript.thinking !== null) {
    const seconds = Math.max(0, Math.floor((now - transcript.thinking) / 1000))
    const said = [
      'thinking',
      ...(seconds >= 2 ? [`${seconds}s`] : []),
      ...(stoppable ? ['esc stops it'] : []),
    ].join(' · ')
    plainText(`  ${skin.busy(spinner(now))} ${skin.hint(said)}`)
  }
  return lines
}

interface Drawn {
  text: string
  /** Links and file references in it can be clicked. */
  linkable?: boolean
  /** A button at the end of it, for a suggestion. */
  target?: Target
}

function entryLines(entry: Entry, width: number, skin: Skin, now: number): Drawn[] {
  switch (entry.kind) {
    case 'you': {
      const out: Drawn[] = wrapped(entry.text, width, `${skin.you('❯')} `, skin.you).map(
        (text) => ({
          text,
        }),
      )
      // **Whose words these are, drawn where somebody reads them.** Only when
      // they are not the person's own: a line saying *you* above everything
      // the person typed is noise on every exchange, and the one case that
      // needs saying is the one that would otherwise read as theirs. The id is
      // what the journal and the device list name a phone by, so the line
      // joins up with both.
      if (entry.from !== '' && entry.from !== 'you') {
        out.push({ text: `  ${skin.hint(`from ${entry.from}, not from you`)}` })
      }
      for (const image of entry.images) {
        out.push({ text: `  ${skin.hint(`▣ ${basename(image)}`)}` })
      }
      return out
    }
    case 'routed':
      return [{ text: skin.hint(`  → ${entry.text}`) }]
    case 'said': {
      const room = Math.max(10, width - 2)
      const lines = [...markdown(entry.text, room, !skin.colour)]
      if (entry.streaming && lines.length > 0) {
        // After the words, not after the padding that fills the line out.
        // biome-ignore lint/suspicious/noControlCharactersInRegex: colour codes are what it steps past.
        const tail = (lines.at(-1) ?? '').replace(/ +((?:\x1b\[[0-9;]*m)*)$/, '$1')
        lines[lines.length - 1] = `${tail}${skin.busy('▍')}`
      }
      // Who is answering, on its first line: the orchestrator, or Tade itself.
      const mark = entry.by === 'orchestrator' ? skin.signal('◆') : skin.busy('●')
      return lines.map((text, i) => ({ text: `${i === 0 ? mark : ' '} ${text}`, linkable: true }))
    }
    case 'tade':
      return wrapped(entry.text, width, `${skin.busy('●')} `, skin.hint).map((text) => ({
        text,
        linkable: true,
      }))
    case 'tool': {
      const mark =
        entry.state === 'running'
          ? skin.busy(spinner(now))
          : entry.state === 'ok'
            ? skin.done('✓')
            : skin.bad('✗')
      const name = toolName(entry.tool)
      const head = `  ${mark} ${entry.state === 'failed' ? skin.bad(name) : skin.hint(name)}${
        entry.detail ? skin.hint(` · ${entry.detail}`) : ''
      }`
      const out: Drawn[] = [{ text: head, linkable: true }]
      if (entry.state === 'running' && entry.progress) {
        out.push({ text: `    ${skin.hint(entry.progress)}` })
      } else if (entry.state === 'failed' && entry.result) {
        // The whole reason: this is the line people came looking for.
        for (const text of wrapped(entry.result, width, '    ', skin.bad)) {
          out.push({ text, linkable: true })
        }
      } else if (entry.state === 'ok' && entry.result) {
        const first = entry.result.split('\n').find((line) => line.trim() !== '') ?? ''
        out.push({ text: `    ${skin.hint(first.trim())}`, linkable: true })
      }
      return out
    }
    case 'problem':
      return wrapped(entry.text, width, `${skin.bad('✗')} `, skin.bad).map((text) => ({
        text,
        linkable: true,
      }))
    case 'suggestion':
      return [
        {
          text: `  ${skin.signal('?')} ${entry.text}`,
          target: { kind: 'action', name: `ask:${entry.ask}` },
        },
      ]
  }
}
