import { byOf, printable, wentQuiet } from '@tade/core/pure'
import type { HistoryItem } from '@tade/harnesses-core'
import type { Turn } from '@tade/voice-core'
import { unwrapped } from './headings.ts'

// The conversation with the orchestrator, as it happens.
//
// It used to show only finished exchanges, so for as long as the orchestrator
// was working there was nothing to see: not what you had said, not which tool
// it reached for, and — worst — not that it had failed or why. This keeps every
// step as it arrives, and `transcriptLines` lays it out like a terminal you
// can read: your words, what it did, what it answered.
//
// Pure: events in, entries out. The view wraps them to a width.

/**
 * How a tool call went. `unknown` is one that answered in a record that does
 * not say whether it worked (`HistoryItem.ok`): never drawn as ok.
 */
export type ToolState = 'running' | 'ok' | 'failed' | 'unknown'

/** Who is speaking: the model you talk to, or Tade answering from its own grammar and its own work. */
export type Speaker = 'orchestrator' | 'tade'

/**
 * A line of a turn that ran on another of the person's machines, folded into
 * this machine's drawing of the one conversation as that machine's
 * projection carries it (`withThere`): which machine, its line's own id there,
 * and the call's id in the record where it is a tool. Drawn with the
 * machine's name as its mark; never written anywhere, never a `said`.
 */
export interface There {
  machine: string
  line: string
  call?: string
}

export type Entry = EntryOf & {
  /** Present only on a line of another machine's turn (`withThere`). */
  there?: There
  /**
   * Read back out of the harness's record (`withEarlier`, `withLater`) rather
   * than said here as it happened: it may have been said on any machine, so
   * another machine folding this one's lines in leaves it out.
   */
  read?: true
}

type EntryOf =
  /**
   * What was said *to* Tade, with the pictures that went along.
   *
   * `from` is who said it, as `byOf` writes it: `you` at the machine, or
   * `device <id>` from a paired device. **Never absent and never guessed**: a
   * request from a phone that read as something the person typed is the `said`
   * confusion one layer up, in the one place somebody actually reads the
   * words, and it is also what the window needs in order to say why its own
   * tools were narrowed for a few seconds.
   */
  | { kind: 'you'; text: string; images: string[]; at: number; from: string }
  /** Where Tade's own grammar sent it, and why: `start · checkout/refunds`. */
  | { kind: 'routed'; text: string; at: number }
  /** Words back: the orchestrator's (markdown), or a reply from Tade itself. */
  | { kind: 'said'; text: string; streaming: boolean; by: Speaker; at: number }
  /** Something Tade itself did or noticed: opened an agent, copied a path, a warning. */
  | { kind: 'tade'; text: string; at: number }
  /** A tool it reached for, and how that went. */
  | {
      kind: 'tool'
      id: string
      tool: string
      /** The arguments that tell you which one: a project, a command. */
      detail: string
      /**
       * Everything it was handed, as the harness gave it — kept so the away
       * view can show a device granted an agent's bytes the call itself
       * (`@tade/web`'s `callOf` cleans it there). Absent on a line made
       * before anything kept it.
       */
      input?: unknown
      /**
       * Something you ran yourself (`ran`): its answer is the window's alone and
       * in no harness's record, so the away view carries it with the row
       * rather than asking a record for it by `id`.
       */
      yours?: true
      state: ToolState
      /** What it answered: the reason, when it failed. */
      result: string
      /** The latest thing it said while working, for tools that report progress. */
      progress: string | null
      at: number
    }
  /** Something went wrong, in words you can act on. */
  | { kind: 'problem'; text: string; at: number }
  /** Something worth asking, offered with the words to ask it: click to send. */
  | { kind: 'suggestion'; text: string; ask: string; at: number }

/** What the orchestrator did, in the terms a surface draws. */
export type ThinkerEvent =
  | { type: 'delta'; text: string }
  | { type: 'message'; text: string }
  | { type: 'tool'; id: string; tool: string; input: unknown }
  | { type: 'progress'; id: string; text: string }
  | { type: 'tool_done'; id: string; ok: boolean; text: string }
  /** The turn ended on this tool having said nothing after it. */
  | { type: 'quiet'; tool: string }
  | { type: 'idle' }
  | { type: 'failed'; reason: string }
  | { type: 'error'; reason: string }
  /** Something wrong with it that is not a turn's, said whole: tools it started without. */
  | { type: 'problem'; text: string }
  | { type: 'exited'; code: number | null }

export interface Transcript {
  entries: Entry[]
  /** When the orchestrator started on what you asked, while it is still on it. */
  thinking: number | null
  /**
   * You stopped the turn it was on, rather than it finishing.
   *
   * Kept because a stopped turn and a silent one look identical from here —
   * both end with nothing said — and only one of them is the failure this
   * conversation exists to report. Cleared the moment the next turn starts,
   * so it is never read against a turn it was not about.
   */
  stopped: boolean
  /**
   * When each of Tade's own lines was last said, kept or not, for as long as
   * saying it again would be dropped (`tadeDid`).
   */
  heard: Record<string, number>
  /**
   * More of the conversation than is shown, in its harness's own record:
   * where to read the page before the first entry from, and whether that is
   * being read. Null when there is nothing earlier. Once an entry has fallen
   * off the top no cursor joins up, so it is `READ_FROM_END`.
   */
  earlier: { cursor: string; asking: boolean } | null
}

/** Enough to scroll back through a morning; older entries fall off the top. */
export const TRANSCRIPT_MAX = 300

/**
 * Whether the orchestrator is on a turn right now.
 *
 * Derived like an agent's own mark and remembered nowhere: it was handed
 * something and has not gone idle again, which is the whole of what its run
 * state is. There is no lane to read it off — the thing you talk to runs
 * headlessly in another process — and the entries are not it either: a tool
 * line left running is something *you* started (`ran`), and an answer still
 * on screen is a turn that ended.
 *
 * One rule because five surfaces draw it — the window's own title
 * (`titleMark`), its tab at the foot (`bottomTabs`), the room the
 * conversation is given (`conversing`), whether a frame is worth drawing
 * (`turning`) and what escape means (`escapeMeans`) — and five
 * readings of one fact drift apart.
 */
export function onATurn(transcript: Transcript): boolean {
  return transcript.thinking !== null
}

export function emptyTranscript(): Transcript {
  return { entries: [], thinking: null, stopped: false, heard: {}, earlier: null }
}

/**
 * The cursor that reads the record from its end (`Earlier`), passing over what
 * is newer than the first line shown: lines fell off the top, so no cursor the
 * record gave joins up with what is shown any more.
 */
export const READ_FROM_END = ''

function push(transcript: Transcript, entry: Entry): Transcript {
  const entries = [...transcript.entries, entry]
  // What somebody scrolled back for is kept while they are reading it: only
  // what is said now makes the oldest fall off.
  const room = Math.max(TRANSCRIPT_MAX, transcript.entries.length)
  if (entries.length <= room) return { ...transcript, entries }
  // **What fell off is still there to read**, in the record: offered again,
  // read from its end past what is still shown, so nothing said is only gone.
  return {
    ...transcript,
    entries: entries.slice(-room),
    earlier: { cursor: READ_FROM_END, asking: false },
  }
}

/**
 * The conversation as it went before what is shown, put above it.
 *
 * What was sent is taken apart again (`unwrapped`): the news that went with it
 * is said as the line Tade drew when it told it, the person's words as theirs,
 * a paired device's as the device's, and what Tade told it on its own as
 * Tade's. A message under no heading was sent as it was typed, or as Tade
 * composed it; `theirs` says which, from what the person is recorded as having
 * said, so a sentence of Tade's is never drawn as somebody's.
 *
 * A tool whose answer was never recorded is drawn as one that did not answer,
 * which is the one thing about it that is known; one whose record does not say
 * whether it worked is `unknown`, never ok.
 */
export function withEarlier(
  transcript: Transcript,
  items: readonly HistoryItem[],
  cursor: string | null,
  theirs: (text: string) => boolean,
): Transcript {
  const entries: Entry[] = []
  for (const item of items) {
    if (item.kind === 'reply') {
      entries.push({
        kind: 'said',
        text: item.text,
        streaming: false,
        by: 'orchestrator',
        at: item.at,
      })
    } else if (item.kind === 'tool') {
      entries.push({
        kind: 'tool',
        id: item.id,
        tool: item.tool,
        detail: toolDetail(item.input),
        input: item.input,
        state:
          item.result === null
            ? 'failed'
            : item.ok === null
              ? 'unknown'
              : item.ok
                ? 'ok'
                : 'failed',
        // A page of history holds the start of a long answer: the window marks
        // where it stops, and the away view reads the whole when it is opened.
        result:
          item.result === null
            ? 'no answer to it was recorded'
            : item.cut
              ? `${item.result}\n…`
              : item.result,
        progress: null,
        at: item.at,
      })
    } else {
      const { news, heading, words } = unwrapped(item.text)
      const at = item.at
      if (news.length > 0) {
        entries.push({ kind: 'tade', text: `told the orchestrator: ${news.join('; ')}`, at })
      }
      const mine = heading === 'them' || (heading === null && theirs(words))
      if (mine || heading === 'away') {
        const from = mine ? 'you' : 'a paired device'
        entries.push({ kind: 'you', text: words, images: item.images, at, from })
      } else if (words.trim() !== '') {
        const first = words.trim().split('\n')[0] ?? ''
        const told = first.length > 160 ? `${first.slice(0, 159)}…` : first
        entries.push({ kind: 'tade', text: `told the orchestrator: ${told}`, at })
      }
    }
  }
  return {
    ...transcript,
    // Read, not said here: another machine folding this one's lines leaves these out.
    entries: [...entries.map((entry): Entry => ({ ...entry, read: true })), ...transcript.entries],
    earlier: cursor ? { cursor, asking: false } : null,
  }
}

/**
 * What was said in the conversation after what is shown — on another machine,
 * taken into this one's record between turns — put below it, drawn as
 * `withEarlier` draws a page. Only what is newer than the newest line shown,
 * so a page read twice adds nothing.
 *
 * **Marked with the machine that said it**, as a turn folded as it ran there
 * is (`withThere`), where `saidOn` names one for when it was written — Tade's
 * news that went with it included — because this is the only way some of it
 * arrives: what was said there while the machines could not reach each other,
 * past what that machine's projection carries, and a turn Tade composed there,
 * whose news no projection folds. What nobody could say whose it was is drawn
 * unmarked, never guessed.
 */
export function withLater(
  transcript: Transcript,
  items: readonly HistoryItem[],
  theirs: (text: string) => boolean,
  saidOn: ReadonlyMap<number, string> = new Map(),
): Transcript {
  const last = transcript.entries.reduce((most, entry) => Math.max(most, entry.at), 0)
  const newer = items.filter((item) => item.at > last)
  if (newer.length === 0) return transcript
  // **A turn already drawn as it ran there is not drawn again** when its
  // record arrives: each line folded from another machine (`withThere`) stands
  // for one item, matched once, and an item that matched takes the news Tade
  // told with it along, which was that machine's to draw.
  const folded = transcript.entries.filter((entry) => entry.there !== undefined)
  const used = new Set<Entry>()
  const made: Entry[] = []
  for (const item of newer) {
    const drawn = withEarlier({ ...transcript, entries: [] }, [item], null, theirs).entries
    const matched = drawn.some((entry) => {
      const twin = folded.find((one) => !used.has(one) && sameLine(one, entry))
      if (twin === undefined) return false
      used.add(twin)
      return true
    })
    if (matched) continue
    const machine = saidOn.get(item.at)
    made.push(
      ...(machine === undefined ? drawn : drawn.map((entry, n) => marked(entry, machine, n))),
    )
  }
  if (made.length === 0) return transcript
  return { ...transcript, entries: [...transcript.entries, ...made] }
}

/**
 * A line read back out of the record, marked as said on `machine`: its line
 * there is a tool's call id, or when it was written and what it is, and a tool
 * is asked for by its call's id there, as one folded as it ran is.
 */
function marked(entry: Entry, machine: string, n: number): Entry {
  const there: There =
    entry.kind === 'tool'
      ? { machine, line: `record:${entry.id}`, call: entry.id }
      : { machine, line: `record:${entry.at}:${entry.kind}:${n}` }
  return { ...entry, there }
}

/**
 * One line of another machine's conversation, as its projection carries it
 * (`@tade/app`'s `RemoteLine`, read structurally): enough to draw it.
 */
export interface ThereLine {
  /** Its own id there: stable, what a later look at the same line is matched by. */
  id: string
  /** When, in this machine's clock; null where it did not say. */
  at: number | null
  kind: string
  /** Who asked: `you` there, or `device <id>`. Null for its own lines. */
  from: string | null
  text: string
  tool: string | null
  outcome: ToolState | null
  streaming: boolean
  /** Where that machine says it came from: null for its own line, said there as it happened. */
  there: string | null
  /** That machine read it back out of its record, so it may have been said anywhere. */
  read: boolean
  /** A tool's call id in the record. */
  call: string | null
}

/** The kinds of another machine's line that are its turn: not its news, not what it offers to ask. */
const FOLDED = new Set(['asked', 'reply', 'own', 'routed', 'tool', 'problem'])

/**
 * Another machine's turns of the one conversation, put into this one's
 * drawing of it as they happen there, each with that machine's name for a
 * mark — so a line typed on the Mac and its answer streaming on ipax are in
 * one strip on both, in time order, whichever machine ran the turn.
 *
 * **Only that machine's own lines**, said there as they happened: a line it
 * folded in from somewhere else (`there`) or read back out of its record
 * (`read`) may be this machine's own turn coming back, and is left out. Only
 * what was said from `since` on — when this window started folding — since
 * what came before is this one's record to draw (`Earlier`). A line already
 * drawn from the record here is not drawn again (`sameLine`).
 *
 * Each line is matched by its id there, so a reply still arriving grows in
 * place and a tool that answered changes its mark. Returns the same transcript
 * where nothing moved, which is what keeps a quiet frame quiet.
 *
 * Pure. `own` is this machine's device on that machine (`device <id>`), so
 * what was typed here and asked there reads as the person's.
 */
export function withThere(
  transcript: Transcript,
  machine: string,
  lines: readonly ThereLine[],
  since: number,
  own: string | null = null,
): Transcript {
  const at = new Map<string, number>()
  transcript.entries.forEach((entry, index) => {
    if (entry.there?.machine === machine) at.set(entry.there.line, index)
  })
  const recorded = transcript.entries.filter((entry) => entry.read === true)
  const used = new Set<Entry>()
  let entries: Entry[] | null = null
  for (const line of lines) {
    if (line.there !== null || line.read || line.at === null || !FOLDED.has(line.kind)) continue
    const made = thereEntry(line, line.at, machine, own)
    const index = at.get(line.id)
    if (index !== undefined) {
      const was = (entries ?? transcript.entries)[index]
      if (was === undefined || sameDrawing(was, made)) continue
      entries ??= [...transcript.entries]
      entries[index] = made
      continue
    }
    if (line.at < since) continue
    const twin = recorded.find((one) => !used.has(one) && sameLine(one, made))
    if (twin !== undefined) {
      used.add(twin)
      continue
    }
    entries ??= [...transcript.entries]
    // In time order: after everything said at or before it.
    let place = entries.length
    while (place > 0 && (entries[place - 1]?.at ?? 0) > made.at) place -= 1
    entries.splice(place, 0, made)
    // Indexes after it moved along by one.
    for (const [id, i] of at) if (i >= place) at.set(id, i + 1)
    at.set(line.id, place)
  }
  if (entries === null) return transcript
  const room = Math.max(TRANSCRIPT_MAX, transcript.entries.length)
  if (entries.length <= room) return { ...transcript, entries }
  return {
    ...transcript,
    entries: entries.slice(-room),
    earlier: { cursor: READ_FROM_END, asking: false },
  }
}

function thereEntry(line: ThereLine, at: number, machine: string, own: string | null): Entry {
  const there: There = {
    machine,
    line: line.id,
    ...(line.call === null ? {} : { call: line.call }),
  }
  switch (line.kind) {
    case 'asked':
      return {
        kind: 'you',
        text: line.text,
        images: [],
        at,
        // The person at that machine's keyboard, or at this one through its
        // link, is the person; a paired device is said as who it is.
        from: line.from === null || line.from === own ? 'you' : line.from,
        there,
      }
    case 'reply':
      return {
        kind: 'said',
        text: line.text,
        streaming: line.streaming,
        by: 'orchestrator',
        at,
        there,
      }
    case 'own':
      return { kind: 'said', text: line.text, streaming: line.streaming, by: 'tade', at, there }
    case 'routed':
      return { kind: 'routed', text: line.text, at, there }
    case 'tool':
      return {
        kind: 'tool',
        // Never a call id of this machine's own, which a turn here updates by.
        id: `there:${machine}:${line.id}`,
        tool: line.tool ?? 'a tool',
        detail: '',
        state: line.outcome ?? 'unknown',
        result: '',
        progress: null,
        at,
        there,
      }
    default:
      return { kind: 'problem', text: line.text, at, there }
  }
}

/** Whether two drawings of one line are the same, so a look that moved nothing changes nothing. */
function sameDrawing(one: Entry, other: Entry): boolean {
  if (one.kind !== other.kind || one.at !== other.at) return false
  if (one.kind === 'tool' && other.kind === 'tool') return one.state === other.state
  if (one.kind === 'said' && other.kind === 'said') {
    return one.text === other.text && one.streaming === other.streaming
  }
  return 'text' in one && 'text' in other && one.text === other.text
}

/**
 * Whether a line drawn from the record and a line folded from another
 * machine's projection are the same thing said: the same kind, and the same
 * call or the same words. Words are compared without anything path-shaped,
 * which the projection takes out (`withoutPaths`) and the record keeps, and
 * by their start, which is plenty to tell two sayings apart.
 */
export function sameLine(one: Entry, other: Entry): boolean {
  if (one.kind !== other.kind) return false
  if (one.kind === 'tool' && other.kind === 'tool') {
    const calls = [
      one.there?.call ?? (one.there ? null : one.id),
      other.there?.call ?? (other.there ? null : other.id),
    ]
    if (calls[0] !== null && calls[1] !== null) return calls[0] === calls[1]
    return toolName(one.tool) === toolName(other.tool)
  }
  if (one.kind === 'said' && other.kind === 'said') {
    return one.by === other.by && wordsKey(one.text) === wordsKey(other.text)
  }
  if (one.kind === 'you' && other.kind === 'you') return wordsKey(one.text) === wordsKey(other.text)
  return false
}

/** Words as `sameLine` compares them: no path-shaped word, no marks, no case, the first 160 letters. */
function wordsKey(text: string): string {
  return text
    .split(/\s+/)
    .filter((word) => !/[/\\~…]/.test(word))
    .join(' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .slice(0, 160)
}

/** The page before what is shown is being read. */
export function askingEarlier(transcript: Transcript): Transcript {
  return transcript.earlier
    ? { ...transcript, earlier: { ...transcript.earlier, asking: true } }
    : transcript
}

/** You said something: shown at once, before anything has answered. */
export function youSaid(
  transcript: Transcript,
  text: string,
  at: number,
  images: readonly string[] = [],
): Transcript {
  return push(
    { ...transcript, stopped: false },
    { kind: 'you', text, images: [...images], at, from: 'you' },
  )
}

/**
 * A paired device said something: shown the same way, marked as theirs.
 *
 * **Its own function rather than a parameter on `youSaid`**, because the two
 * have different defaults and the wrong one is silent: a `from` that could be
 * left out would be left out, and the line would read as the person's. Here a
 * caller has to say which of the two doors it is.
 *
 * `byOf` writes the word, so the transcript, the journal and the projection
 * all name a device the same way — and none of them ever names it `you`.
 */
export function deviceSaid(
  transcript: Transcript,
  text: string,
  at: number,
  device: string,
): Transcript {
  return push(
    { ...transcript, stopped: false },
    { kind: 'you', text, images: [], at, from: byOf({ how: 'remote', device }) },
  )
}

/** The orchestrator has been handed something, and is working until it is idle again. */
export function thinking(transcript: Transcript, at: number): Transcript {
  return { ...transcript, thinking: transcript.thinking ?? at, stopped: false }
}

/**
 * You stopped the turn it was on.
 *
 * Everything it said and did up to here stays — it is what you were reading
 * when you decided to stop it — and the conversation is not ended: the next
 * thing you say carries on from exactly this point. A tool that was still
 * running never answered, and saying it is still running is the one thing
 * that would now be untrue.
 */
export function interrupted(transcript: Transcript): Transcript {
  const settled = settleStreaming(transcript)
  return {
    ...settled,
    thinking: null,
    stopped: true,
    entries: settled.entries.map((entry) =>
      entry.kind === 'tool' && entry.state === 'running'
        ? { ...entry, state: 'failed', result: 'you stopped it before it answered', progress: null }
        : entry,
    ),
  }
}

/**
 * An exchange Tade finished. Its own grammar says where it sent what you said
 * and answers; free text was the orchestrator's, whose words are already here
 * as they arrived — unless it never got that far, and the reply says why.
 */
export function fromTurn(transcript: Transcript, turn: Turn): Transcript {
  // The brief writes itself into the conversation as it is composed, with
  // what to ask about it; its reply is the same words again.
  if (turn.intent === 'brief') {
    const since = lastYou(transcript.entries)
    if (transcript.entries.slice(since + 1).some((entry) => entry.kind === 'said'))
      return transcript
  }
  if (turn.intent === 'free') {
    const since = lastYou(transcript.entries)
    // A tool line is working, not answering. Counting one as an answer is
    // exactly how a turn that ended on a tool call got through here looking
    // finished: there was something on screen, so nothing said the turn had
    // gone quiet, and a tool that worked is the most convincing possible
    // picture of a model still thinking.
    const answered = transcript.entries
      .slice(since + 1)
      .some((entry) => entry.kind === 'said' || entry.kind === 'problem')
    const settled = { ...transcript, thinking: null }
    if (answered) return settled
    // You stopped it, so it saying nothing is the answer you asked for rather
    // than the silence below.
    if (transcript.stopped) return settled
    // Nothing shown and nothing said is the silence this conversation exists
    // to prevent: say that much, at least.
    if (turn.reply.trim() === '') {
      return push(settled, {
        kind: 'problem',
        text: 'The orchestrator finished without saying anything.',
        at: turn.at,
      })
    }
    return push(settled, {
      kind: 'said',
      text: turn.reply,
      streaming: false,
      by: 'tade',
      at: turn.at,
    })
  }
  const parts: string[] = [turn.intent]
  if (turn.task) parts.push(turn.task)
  if (turn.why) parts.push(`"${turn.why}"`)
  let next = push(transcript, { kind: 'routed', text: parts.join(' · '), at: turn.at })
  if (turn.reply)
    next = push(next, {
      kind: 'said',
      text: turn.reply,
      streaming: false,
      by: 'tade',
      at: turn.at,
    })
  return next
}

/** One thing the orchestrator did, folded into what is shown. */
export function fromThinker(transcript: Transcript, event: ThinkerEvent, at: number): Transcript {
  const entries = transcript.entries
  const last = entries.at(-1)
  switch (event.type) {
    case 'delta':
      if (last?.kind === 'said' && last.streaming && last.there === undefined) {
        return replaceLast(transcript, { ...last, text: last.text + event.text })
      }
      return push(thinking(transcript, at), {
        kind: 'said',
        text: event.text,
        streaming: true,
        by: 'orchestrator',
        at,
      })
    case 'message':
      // The whole block, which is the truth about what the parts added up to.
      if (last?.kind === 'said' && last.streaming && last.there === undefined) {
        return replaceLast(transcript, { ...last, text: event.text, streaming: false })
      }
      return push(transcript, {
        kind: 'said',
        text: event.text,
        streaming: false,
        by: 'orchestrator',
        at,
      })
    case 'tool':
      return push(thinking(settleStreaming(transcript), at), {
        kind: 'tool',
        id: event.id,
        tool: event.tool,
        detail: toolDetail(event.input),
        input: event.input,
        state: 'running',
        result: '',
        progress: null,
        at,
      })
    case 'progress':
      return updateTool(transcript, event.id, (entry) => ({ ...entry, progress: event.text }))
    case 'tool_done':
      return updateTool(transcript, event.id, (entry) => ({
        ...entry,
        state: event.ok ? 'ok' : 'failed',
        // A tool that answered with its own name said nothing worth repeating.
        result: event.text === entry.tool ? '' : event.text,
        progress: null,
      }))
    case 'quiet': {
      // The turn ended on a tool call and said nothing after it, which is the
      // silence this whole conversation exists to prevent: without this line
      // the spinner simply stops and the last thing on screen is a tool that
      // worked, so the person waits a while and then asks again for something
      // that already happened.
      //
      // Reported rather than answered, because only the turn that called the
      // tool knows what it said — Tade putting a "done" here would be making
      // one up, and a sentence nobody can trust is worse than silence. What
      // it can do is put the words that ask for the answer one click away,
      // rather than leaving the person to retype the question.
      const tool = toolName(event.tool)
      return suggest(
        push(settleStreaming(transcript), { kind: 'problem', text: wentQuiet(tool), at }),
        'ask it what it found',
        `you ran ${tool} and then said nothing: what did it answer, and what did you decide?`,
        at,
      )
    }
    case 'idle':
      return { ...settleStreaming(transcript), thinking: null }
    case 'failed':
      return push(
        { ...settleStreaming(transcript), thinking: null },
        { kind: 'problem', text: `The orchestrator stopped: ${event.reason}`, at },
      )
    case 'error': {
      const text = `The orchestrator could not answer: ${event.reason}`
      // pi reports a refused request and then its retry of it; the same words
      // twice in a row are one problem.
      if (last?.kind === 'problem' && last.text === text) return transcript
      // Still thinking: pi may be retrying, and `idle` says when it is not.
      return push(settleStreaming(transcript), { kind: 'problem', text, at })
    }
    case 'problem':
      // Its own sentence, and not "could not answer": the turn may well have
      // answered — without the tools it would have answered with.
      return push(settleStreaming(transcript), { kind: 'problem', text: event.text, at })
    case 'exited': {
      const running = entries.some((entry) => entry.kind === 'tool' && entry.state === 'running')
      let next: Transcript = { ...settleStreaming(transcript), thinking: null }
      if (running) {
        next = {
          ...next,
          entries: next.entries.map((entry) =>
            entry.kind === 'tool' && entry.state === 'running'
              ? { ...entry, state: 'failed', result: 'the orchestrator stopped before it answered' }
              : entry,
          ),
        }
      }
      return next
    }
  }
}

/** Words from Tade itself, not the orchestrator: a brief, an extension's answer. */
export function said(transcript: Transcript, text: string, at: number): Transcript {
  return push(transcript, { kind: 'said', text, streaming: false, by: 'tade', at })
}

/**
 * How long a line of Tade's own has to have gone unsaid before saying it again
 * is a second line: past a status beat or two, short of anybody pressing the
 * same thing again to see whether it worked.
 */
export const REPEAT_MS = 5_000

/**
 * Something Tade did or noticed, as a line of its own.
 *
 * The same line said again soon after — a warning every poll — is not said
 * twice, and *soon* is counted from the last time it was said, kept or not, so
 * a warning that goes on is one line for as long as it goes on. It used to be
 * any of the last twelve lines, however old: the second click on something
 * that failed the same way a minute later said nothing at all, and a click
 * with no answer reads as one that did not land.
 */
export function tadeDid(transcript: Transcript, text: string, at: number): Transcript {
  const last = transcript.heard[text]
  const heard: Record<string, number> = { [text]: at }
  for (const [said, when] of Object.entries(transcript.heard)) {
    if (said !== text && at - when < REPEAT_MS) heard[said] = when
  }
  if (last !== undefined && at - last < REPEAT_MS) return { ...transcript, heard }
  return push({ ...transcript, heard }, { kind: 'tade', text, at })
}

/**
 * Something you ran yourself — an extension's action — shown as a tool line
 * like the orchestrator's, without claiming the orchestrator is thinking.
 */
export function ran(
  transcript: Transcript,
  run: { id: string; tool: string; input: unknown },
  at: number,
): Transcript {
  return push(transcript, {
    kind: 'tool',
    id: run.id,
    tool: run.tool,
    detail: toolDetail(run.input),
    input: run.input,
    yours: true,
    state: 'running',
    result: '',
    progress: null,
    at,
  })
}

/** Something went wrong outside the orchestrator: shown where you were looking for the answer. */
export function problem(transcript: Transcript, text: string, at: number): Transcript {
  return push({ ...transcript, thinking: null }, { kind: 'problem', text, at })
}

/** Offer something worth asking, with the words that ask it. */
export function suggest(transcript: Transcript, text: string, ask: string, at: number): Transcript {
  return push(transcript, { kind: 'suggestion', text, ask, at })
}

/**
 * The few arguments that say which thing a tool was used on, as a short line:
 * `tade · "pnpm test"`. Long values are cut, and structure is not repeated.
 */
export function toolDetail(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const parts: string[] = []
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (parts.length >= 3) break
    if (typeof value === 'string' && value.trim() !== '') {
      // Made text before it is measured, or a cut lands inside an escape.
      const flat = printable(value).replace(/\s+/g, ' ').trim()
      const cut = flat.length > 48 ? `${flat.slice(0, 47)}…` : flat
      parts.push(/\s/.test(cut) || key === 'command' ? `"${cut}"` : cut)
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      parts.push(`${key} ${value}`)
    }
  }
  return parts.join(' · ')
}

/** A tool's name the way it reads: `tade_terminal_run` is "terminal run". */
export function toolName(tool: string): string {
  return tool.replace(/^tade_/, '').replace(/_/g, ' ')
}

function lastYou(entries: readonly Entry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i]?.kind === 'you') return i
  return -1
}

function replaceLast(transcript: Transcript, entry: Entry): Transcript {
  return { ...transcript, entries: [...transcript.entries.slice(0, -1), entry] }
}

function settleStreaming(transcript: Transcript): Transcript {
  const last = transcript.entries.at(-1)
  // Another machine's line is settled by that machine's projection, never by a turn here.
  return last?.kind === 'said' && last.streaming && last.there === undefined
    ? replaceLast(transcript, { ...last, streaming: false })
    : transcript
}

function updateTool(
  transcript: Transcript,
  id: string,
  change: (entry: Extract<Entry, { kind: 'tool' }>) => Entry,
): Transcript {
  let found = false
  const entries = transcript.entries.map((entry) => {
    if (found || entry.kind !== 'tool' || entry.id !== id) return entry
    found = true
    return change(entry)
  })
  return found ? { ...transcript, entries } : transcript
}
