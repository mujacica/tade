import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  type HarnessSpend,
  type HistoryAsk,
  type HistoryItem,
  type HistoryLine,
  type HistoryPage,
  historyIn,
  keptResult,
  momentOf,
  noHarnessSpend,
} from '@tade/harnesses-core'

// Reading what an agent did out of Claude Code's own transcript, rather than
// out of what it told us at the time.
//
// Claude Code keeps one JSONL file per conversation under
// `<config>/projects/<its encoding of the working directory>/<session id>.jsonl`.
// The encoding is its business and a liability to reimplement; the file name
// is the session id, which is ours, so looking for the name is both simpler
// and harder to break. The format is private: anything not recognised is
// skipped, and a transcript that cannot be read is a gap, never an error.

/** Where Claude Code keeps its settings, sign-in and transcripts, unless told otherwise. */
export function defaultConfigDir(home = homedir()): string {
  return join(home, '.claude')
}

/**
 * The conversation a task's agent talks in, for the life of the task: a UUID
 * made from the task's name, because Claude Code takes nothing else, and made
 * the same way every time, because that is what makes coming back ordinary.
 */
export function sessionIdFor(task: string): string {
  const hash = createHash('sha1').update(`tade:${task}`).digest()
  // A name-based UUID (version 5, RFC 4122 variant), so it reads as one.
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80
  const hex = hash.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/** A task's transcript, wherever Claude Code filed it. Null when it has none. */
export async function transcriptFor(task: string, configDir: string): Promise<string | null> {
  const name = `${sessionIdFor(task)}.jsonl`
  const root = join(configDir, 'projects')
  const dirs = await readdir(root).catch(() => [] as string[])
  for (const dir of dirs) {
    const entries = await readdir(join(root, dir)).catch(() => [] as string[])
    if (entries.includes(name)) return join(root, dir, name)
  }
  return null
}

interface Usage {
  input_tokens?: unknown
  output_tokens?: unknown
  cache_read_input_tokens?: unknown
  cache_creation_input_tokens?: unknown
}

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0

/**
 * What a transcript has spent, in tokens. Claude Code writes one line per
 * content block of a reply, each carrying the whole reply's usage, so replies
 * are counted once by their id. It records no price: dollars come from what it
 * says while it runs, and are never made up here.
 */
export function spentIn(text: string): HarnessSpend {
  const total = noHarnessSpend()
  const seen = new Set<string>()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      // A half-written last line is what a live transcript looks like.
      continue
    }
    if (typeof entry !== 'object' || entry === null) continue
    const { type, message } = entry as { type?: unknown; message?: unknown }
    if (type !== 'assistant' || typeof message !== 'object' || message === null) continue
    const { id, model, usage } = message as { id?: unknown; model?: unknown; usage?: Usage }
    if (!usage || typeof usage !== 'object') continue
    if (typeof id === 'string') {
      if (seen.has(id)) continue
      seen.add(id)
    }
    // A reply Claude Code made up itself — an API error said as a message — cost nothing.
    if (model === '<synthetic>') continue
    const input = count(usage.input_tokens)
    const output = count(usage.output_tokens)
    const cacheRead = count(usage.cache_read_input_tokens)
    const cacheWrite = count(usage.cache_creation_input_tokens)
    total.input += input
    total.output += output
    total.cacheRead += cacheRead
    total.cacheWrite += cacheWrite
    total.tokens += input + output + cacheRead + cacheWrite
    total.messages += 1
    if (typeof model === 'string') total.model = model
  }
  return total
}

/** What a task's agent has spent, from its transcript. Nothing, when it has none. */
export async function spentOn(task: string, configDir: string): Promise<HarnessSpend> {
  const file = await transcriptFor(task, configDir)
  if (!file) return noHarnessSpend()
  return spentIn(await readFile(file, 'utf8').catch(() => ''))
}

/**
 * Whether the turn that ended was cut short by a person rather than finished:
 * Claude Code says so in its transcript and nowhere else — no hook runs.
 */
export function interruptedIn(tail: string): boolean {
  const lines = tail.trim().split('\n')
  for (let n = lines.length - 1; n >= 0; n--) {
    let entry: { type?: unknown; message?: { content?: unknown } }
    try {
      entry = JSON.parse(lines[n] ?? '')
    } catch {
      continue
    }
    if (entry.type === 'assistant') return false
    if (entry.type !== 'user') continue
    const content = entry.message?.content
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((part) => (part as { text?: unknown }).text ?? '').join('')
          : ''
    if (text.startsWith('[Request interrupted by user')) return true
    return false
  }
  return false
}

/**
 * The turn under way at the end of a transcript, and when it began where it
 * says; null when none is. What a window taking an agent back reads, because
 * no hook says anything until that turn ends: a reply cut off waiting on a
 * tool it called, an answer it has not replied to, or words it has not
 * answered yet are a turn; a reply that ended, or a turn somebody cut short,
 * is not. Its own slash commands between turns are not words said to it.
 */
export function turnIn(text: string): { since: number | null } | null {
  const lines = text.trimEnd().split('\n')
  let under = false
  for (let n = lines.length - 1; n >= 0; n--) {
    let entry: {
      type?: unknown
      timestamp?: unknown
      isSidechain?: unknown
      isMeta?: unknown
      isCompactSummary?: unknown
      message?: { stop_reason?: unknown; content?: unknown }
    }
    try {
      entry = JSON.parse(lines[n] ?? '')
    } catch (err) {
      // A half-written last line is what a live transcript looks like.
      if (err instanceof SyntaxError) continue
      throw err
    }
    if (typeof entry !== 'object' || entry === null || entry.isSidechain === true) continue
    if (entry.type === 'assistant') {
      if (under) continue
      const stop = entry.message?.stop_reason
      // Still replying, or waiting on what it called; any other reason ended it.
      if (stop === 'tool_use' || stop === null || stop === undefined) under = true
      else return null
      continue
    }
    if (entry.type !== 'user' || entry.isMeta === true || entry.isCompactSummary === true) continue
    const content = entry.message?.content
    if (Array.isArray(content) && content.some((part) => part?.type === 'tool_result')) {
      under = true
      continue
    }
    const said =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((part) => (part as { text?: unknown }).text ?? '').join('')
          : ''
    if (said.startsWith('<command-') || said.startsWith('<local-command-')) continue
    if (said.startsWith('[Request interrupted by user')) return under ? { since: null } : null
    return { since: momentOf(entry.timestamp) || null }
  }
  return under ? { since: null } : null
}

/**
 * A page of a task's conversation, out of its transcript (`historyIn`), with
 * each tool called by the name the adapter gives it.
 */
export async function historyOn(
  task: string,
  configDir: string,
  ask: HistoryAsk,
  named: (tool: string) => string,
): Promise<HistoryPage> {
  return historyIn(await transcriptFor(task, configDir), ask, (line) => historyLine(line, named))
}

/** A picture it was pointed at, as `promptWithImages` writes one. */
const PICTURE = /^\[picture: (.+)\]$/

/**
 * What one transcript line says, or null for any line that is not a part of
 * the conversation as it was had: its own bookkeeping, a side conversation of
 * a subagent, what it says about its own commands, and anything unrecognised.
 */
export function historyLine(
  text: string,
  named: (tool: string) => string = (tool) => tool,
): HistoryLine | null {
  let entry: unknown
  try {
    entry = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof entry !== 'object' || entry === null) return null
  const { type, message, timestamp, isSidechain, isMeta, isCompactSummary } = entry as Record<
    string,
    unknown
  >
  // A summary it wrote of itself after compacting is not something anybody said.
  if (isSidechain === true || isMeta === true || isCompactSummary === true) return null
  if (type !== 'user' && type !== 'assistant') return null
  if (typeof message !== 'object' || message === null) return null
  const at = momentOf(timestamp)
  const content = (message as { content?: unknown }).content
  const parts: Record<string, unknown>[] =
    typeof content === 'string'
      ? [{ type: 'text', text: content }]
      : Array.isArray(content)
        ? content.filter(
            (part): part is Record<string, unknown> => typeof part === 'object' && part !== null,
          )
        : []
  const line: HistoryLine = { items: [], results: [], opens: false }
  if (type === 'user') {
    const words: string[] = []
    const images: string[] = []
    for (const part of parts) {
      if (part.type === 'text' && typeof part.text === 'string') words.push(part.text)
      else if (part.type === 'image') images.push('picture')
      else if (part.type === 'tool_result' && typeof part.tool_use_id === 'string') {
        const failed = part.is_error === true
        line.results.push({
          id: part.tool_use_id,
          ok: !failed,
          result: keptResult(resultText(part.content)),
        })
      }
    }
    const said = words.join('\n')
    // What it says about its own commands, and a turn somebody cut short:
    // neither was said to it by anybody.
    if (said.trim() === '' || /^\s*(<[a-z-]+>|\[Request interrupted)/.test(said)) return line
    const kept = said.split('\n')
    while (kept.length > 0) {
      const picture = PICTURE.exec(kept.at(-1) ?? '')
      if (!picture?.[1]) break
      images.unshift(picture[1])
      kept.pop()
    }
    line.items.push({ kind: 'sent', text: kept.join('\n').trimEnd(), images, at })
    line.opens = true
    return line
  }
  for (const part of parts) {
    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
      line.items.push({ kind: 'reply', text: part.text, at })
    } else if (part.type === 'tool_use' && typeof part.id === 'string') {
      const item: HistoryItem = {
        kind: 'tool',
        id: part.id,
        tool: named(String(part.name ?? '')),
        input: part.input ?? {},
        ok: null,
        result: '',
        at,
      }
      line.items.push(item)
    }
  }
  return line
}

/** A tool's answer as words, however the transcript kept it. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) =>
      typeof part === 'object' && part !== null && 'text' in part ? String(part.text) : '',
    )
    .join('\n')
}
