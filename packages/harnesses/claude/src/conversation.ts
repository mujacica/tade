import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import {
  appendLines,
  type ConversationFormat,
  type ConversationLine,
  derivedHex,
  ifMissing,
} from '@tade/harnesses-core'
import { folderFor } from './sessions.ts'
import { sessionIdFor, transcriptFor } from './transcript.ts'

// Claude Code's record of a conversation, read for replicating it
// (`ConversationFormat`, `@tade/harnesses-core`'s `conversation.ts`).
//
// Its format is private, so this is narrow on purpose. An entry of the tree is
// a line with a `uuid`, a `parentUuid` and a type it is known to give one
// (`TREE`); bookkeeping is a line without one, of a type it is known to write
// (`KEPT`) — what a request cost, the request it sent, which mode it was in,
// where it was told to come back to — and stays on the machine that wrote it.
// Anything else is a shape this does not know, and stops the merge.
//
// **Every byte is kept but the ones named.** A line is taken only where
// writing it back out of what it parsed to gives the line exactly — Claude
// Code writes them with `JSON.stringify`, and every one of the 79,006 entries
// of a month's orchestrator record does — so replacing one field keeps every
// other key where it was and every other byte as it was. The fields touched:
// `cwd` (blanked to compare, set to this machine's on the way in), and on a
// copy `uuid` and `parentUuid`. The session id needs nothing: it is made from
// the task's name (`sessionIdFor`), so it is the same on every machine.
//
// **A large tool result is kept beside the record**, in the folder named for
// the session (`besideOf`), and an entry names it by an absolute path into the
// config folder of the machine that wrote it — "Full output saved to: …/<id>/
// tool-results/<file>", and `persistedOutputPath` — which the model reads
// when it needs more than the preview. That path is the one other thing
// touched: blanked to `<tade:beside>/tool-results/<file>` to compare, and set
// to this machine's folder on the way in, where the file itself is put after
// it has travelled with the entries (`beside`, `conversation-share.ts`). A
// path written some other way — `~/`, a folder with a space in it — is left
// as it was, and its file does not travel.
//
// **Where `--resume` comes back to** was read out of the 2.1.311 that runs
// here: the last `last-prompt` line's `leafUuid`, unless the record's last
// entry descends from it, and the entry with the newest timestamp only where
// neither says. So a merge ends with a `last-prompt` naming the last copy
// (`pointer`), which is bookkeeping and stays here like the rest; held by a
// test against a record that pins it, and to be checked again when Claude
// Code moves forward.

/** The entries of its tree that Tade knows. */
const TREE = new Set(['user', 'assistant', 'attachment', 'system', 'progress'])

/** Its bookkeeping that Tade knows, each kept by the machine that wrote it. */
const KEPT = new Set([
  'agent-color',
  'agent-name',
  'agent-setting',
  'ai-title',
  'api-request',
  'api-request-blob',
  'api-request-shape',
  'artifact-autoreact-ledger',
  'artifact-comment-monitor',
  'atis-latch',
  'attribution-snapshot',
  'bridge-session',
  'content-replacement',
  'cost-state',
  'custom-title',
  'dev-mods',
  'ended-by-model',
  'file-history-delta',
  'file-history-snapshot',
  'fork-context-ref',
  'frame-link',
  'history-suppression',
  'isolation-latch',
  'last-prompt',
  'memory-mode',
  'mode',
  'permission-mode',
  'pr-link',
  'queue-operation',
  'relocated',
  'summary',
  'tag',
  'tools-used',
  'worktree-state',
])

type Entry = Record<string, unknown>

/** What a path into a record's side folder is written as in a canonical line. */
const BESIDE = '<tade:beside>'

/**
 * A large tool result's path as Claude Code writes it, under any account's
 * folder and any session's (a conversation carried from another keeps naming
 * where it was): the file's name there is the first group.
 */
const RESULT_AT =
  /(?<![\w.~-])(?:\/[^/"\\\s<>]+)+?\/projects\/[^/"\\\s]+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(tool-results\/[A-Za-z0-9_-](?:[A-Za-z0-9_.-]{0,126}[A-Za-z0-9_-])?)/g

/** The same, blanked in a canonical line. */
const RESULT_NAMED =
  /<tade:beside>\/(tool-results\/[A-Za-z0-9_-](?:[A-Za-z0-9_.-]{0,126}[A-Za-z0-9_-])?)/g

/** A line with every large result's path blanked, and the files it names. */
function blanked(line: string): {
  text: string
  beside: { name: string; path: string | null }[]
} {
  if (!line.includes('/tool-results/')) return { text: line, beside: [] }
  const beside: { name: string; path: string | null }[] = []
  for (const [, name] of line.matchAll(RESULT_NAMED))
    beside.push({ name: name as string, path: null })
  const text = line.replace(RESULT_AT, (path: string, name: string) => {
    beside.push({ name, path })
    return `${BESIDE}/${name}`
  })
  return { text, beside }
}

/** What a line parsed to, where writing that back out gives the line exactly. */
function parsed(line: string): Entry | string {
  let entry: unknown
  try {
    entry = JSON.parse(line)
  } catch (err) {
    if (err instanceof SyntaxError) return 'a line that is not JSON'
    throw err
  }
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return 'a line that is not an object'
  }
  if (JSON.stringify(entry) !== line)
    return 'a line written in a way Tade cannot copy byte for byte'
  return entry as Entry
}

/** Whether a user entry is words said to it, rather than a tool's answer or its own command. */
function opens(entry: Entry): boolean {
  if (entry.type !== 'user') return false
  const content = (entry.message as { content?: unknown } | undefined)?.content
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.some((part) => (part as { type?: unknown })?.type === 'tool_result')
          ? null
          : content.map((part) => String((part as { text?: unknown })?.text ?? '')).join('')
        : null
  if (text === null) return false
  return !/^\s*(<command-|<local-command-|\[Request interrupted)/.test(text)
}

export const CLAUDE_CONVERSATION: ConversationFormat = {
  read(line): ConversationLine {
    const entry = parsed(line)
    if (typeof entry === 'string') return { kind: 'unknown', why: entry }
    const type = entry.type
    if (typeof type !== 'string') return { kind: 'unknown', why: 'a line with no type' }
    if (!('uuid' in entry)) {
      return KEPT.has(type)
        ? { kind: 'kept' }
        : { kind: 'unknown', why: `a line of type ${type} with no uuid` }
    }
    if (!TREE.has(type)) return { kind: 'unknown', why: `an entry of type ${type}` }
    const { uuid, parentUuid, timestamp } = entry
    if (typeof uuid !== 'string' || uuid === '') {
      return { kind: 'unknown', why: `an entry of type ${type} whose uuid is not text` }
    }
    if (parentUuid !== null && typeof parentUuid !== 'string') {
      return {
        kind: 'unknown',
        why: `an entry of type ${type} whose parentUuid is neither text nor null`,
      }
    }
    const side = entry.isSidechain === true
    const message = (type === 'user' || type === 'assistant') && entry.isMeta !== true
    const { text, beside } = blanked(
      typeof entry.cwd === 'string' ? JSON.stringify({ ...entry, cwd: '' }) : line,
    )
    return {
      kind: 'entry',
      id: uuid,
      parent: parentUuid,
      at: typeof timestamp === 'string' ? timestamp : '',
      message,
      opens: message && !side && opens(entry),
      side,
      text,
      ...(beside.length > 0 ? { beside } : {}),
    }
  },

  localised(text, here) {
    const entry = JSON.parse(text) as Entry
    const line = typeof entry.cwd === 'string' ? JSON.stringify({ ...entry, cwd: here.cwd }) : text
    const folder = here.beside
    if (folder === undefined) return line
    // Escaped as JSON would, since it lands inside a string of the line.
    const at = JSON.stringify(folder).slice(1, -1)
    return line.replace(RESULT_NAMED, (_, name: string) => `${at}/${name}`)
  },

  besideOf(record) {
    return record.replace(/\.jsonl$/, '')
  },

  copied(text, to) {
    return JSON.stringify({ ...(JSON.parse(text) as Entry), parentUuid: to.parent, uuid: to.id })
  },

  marker({ id, parent, text, at, like }) {
    const from = JSON.parse(like) as Entry
    // The envelope its own words come in, so it reads it as one of them.
    return JSON.stringify({
      parentUuid: parent,
      isSidechain: false,
      type: 'user',
      message: { role: 'user', content: text },
      uuid: id,
      timestamp: at,
      userType: 'external',
      ...(typeof from.entrypoint === 'string' ? { entrypoint: from.entrypoint } : {}),
      cwd: '',
      sessionId: from.sessionId,
      ...(typeof from.version === 'string' ? { version: from.version } : {}),
    })
  },

  pointer(leaf, text, like) {
    const from = JSON.parse(like) as Entry
    return JSON.stringify({
      type: 'last-prompt',
      lastPrompt: text.slice(0, 200),
      leafUuid: leaf,
      sessionId: from.sessionId,
    })
  },

  header() {
    return null
  },

  idFor(seed) {
    // Shaped like its own ids: a name-based UUID (version 5, RFC 4122 variant).
    const hex = derivedHex(seed).slice(0, 32).split('')
    hex[12] = '5'
    hex[16] = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16)
    const h = hex.join('')
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
  },
}

/**
 * Where a task's record is here: wherever Claude Code filed it, or — where it
 * has none yet — the folder it files `cwd`'s conversations in, which is where
 * the next `--resume` launched in `cwd` looks.
 */
export async function recordFor(task: string, cwd: string, configDir: string): Promise<string> {
  return (
    (await transcriptFor(task, configDir)) ??
    join(await folderFor(cwd, configDir), `${sessionIdFor(task)}.jsonl`)
  )
}

/**
 * Canonical lines appended to a task's record here, each with this machine's
 * working directory, then a `last-prompt` naming `leaf`, so `--resume` comes
 * back to the end of what was appended. Only ever appends.
 */
export async function takeInto(
  task: string,
  cwd: string,
  configDir: string,
  lines: readonly string[],
  leaf: string | null,
): Promise<void> {
  if (lines.length === 0) return
  const record = await recordFor(task, cwd, configDir)
  const here = await realpath(cwd).catch(ifMissing(cwd))
  const beside = CLAUDE_CONVERSATION.besideOf?.(record)
  const written = lines.map((line) =>
    CLAUDE_CONVERSATION.localised(line, { cwd: here, ...(beside ? { beside } : {}) }),
  )
  const like = lines.at(-1) as string
  const point = leaf
    ? CLAUDE_CONVERSATION.pointer(leaf, 'what happened on another machine', like)
    : null
  await appendLines(record, point ? [...written, point] : written)
}
