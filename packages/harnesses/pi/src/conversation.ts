import { existsSync } from 'node:fs'
import { readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import {
  appendLines,
  type ConversationFormat,
  type ConversationLine,
  derivedHex,
  ifMissing,
} from '@tade/harnesses-core'
import { sessionIdFor } from './adapter.ts'

// pi's record of a conversation, read for replicating it (`ConversationFormat`,
// `@tade/harnesses-core`'s `conversation.ts`).
//
// A session file is a header (`type: session`, with the working directory it
// was started in) and then entries of a tree, each with `id`, `parentId` and a
// type pi defines (`SessionEntry` in its `session-manager.d.ts`). The header is
// this machine's own — the folder it names is where pi looks — so it stays
// here, and a record made here begins with one of its own. Every entry
// travels as it is: none carries a machine's path.
//
// **Where pi comes back to** is the last entry of the file, so a merge's last
// line is its last copy and nothing has to point anywhere (`pointer` is null).
//
// **Its ids are eight hex characters**, 32 bits, so two machines can make the
// same one for different entries over a long conversation. The merge refuses
// such a pair in words rather than choosing (`mergeConversations`), and the ids
// it derives itself step past every id either branch holds.

/** The entry types of pi's tree, as its session manager defines them. */
const TREE = new Set([
  'message',
  'thinking_level_change',
  'model_change',
  'usage',
  'compaction',
  'branch_summary',
  'custom',
  'custom_message',
  'context_edit',
  'label',
  'session_info',
])

type Entry = Record<string, unknown>

export const PI_CONVERSATION: ConversationFormat = {
  read(line): ConversationLine {
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch (err) {
      if (err instanceof SyntaxError) return { kind: 'unknown', why: 'a line that is not JSON' }
      throw err
    }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { kind: 'unknown', why: 'a line that is not an object' }
    }
    const one = entry as Entry
    if (JSON.stringify(one) !== line) {
      return { kind: 'unknown', why: 'a line written in a way Tade cannot copy byte for byte' }
    }
    if (one.type === 'session') return { kind: 'kept' }
    if (typeof one.type !== 'string' || !TREE.has(one.type)) {
      return { kind: 'unknown', why: `an entry of type ${String(one.type)}` }
    }
    if (typeof one.id !== 'string' || one.id === '') {
      return { kind: 'unknown', why: `an entry of type ${one.type} whose id is not text` }
    }
    if (one.parentId !== null && typeof one.parentId !== 'string') {
      return {
        kind: 'unknown',
        why: `an entry of type ${one.type} whose parentId is neither text nor null`,
      }
    }
    const role = (one.message as { role?: unknown } | undefined)?.role
    const message = one.type === 'message' || one.type === 'custom_message'
    return {
      kind: 'entry',
      id: one.id,
      parent: one.parentId,
      at: typeof one.timestamp === 'string' ? one.timestamp : '',
      message,
      opens: one.type === 'message' && role === 'user',
      side: false,
      text: line,
    }
  },

  localised(text) {
    return text
  },

  copied(text, to) {
    return JSON.stringify({ ...(JSON.parse(text) as Entry), id: to.id, parentId: to.parent })
  },

  marker({ id, parent, text, at }) {
    // pi's own way of putting words of Tade's in front of the model: drawn
    // apart from what the person typed, and sent to it as theirs would be.
    return JSON.stringify({
      type: 'custom_message',
      id,
      parentId: parent,
      timestamp: at,
      customType: 'tade-merge',
      content: text,
      display: true,
    })
  },

  pointer() {
    return null
  },

  header({ cwd, session, at }) {
    return JSON.stringify({ type: 'session', version: 3, id: session, timestamp: at, cwd })
  },

  idFor(seed) {
    return derivedHex(seed).slice(0, 8)
  },
}

/**
 * Where a task's headless record is here: the newest pi keeps for it in
 * `dir` (`--session-dir`), or a new name in the shape pi gives one.
 */
export async function piRecordFor(task: string, dir: string): Promise<string> {
  const suffix = `_${sessionIdFor(task)}.jsonl`
  const found = (await readdir(dir).catch(ifMissing([] as string[])))
    .filter((name) => name.endsWith(suffix))
    .sort()
    .at(-1)
  if (found) return join(dir, found)
  return join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}${suffix}`)
}

/**
 * Canonical lines appended to a task's headless record here — begun with a
 * header of this machine's where there was none — in order, so the last of
 * them is where pi comes back to. Only ever appends.
 */
export async function piTakeInto(
  task: string,
  cwd: string,
  dir: string,
  lines: readonly string[],
): Promise<void> {
  if (lines.length === 0) return
  const record = await piRecordFor(task, dir)
  const head = existsSync(record)
    ? []
    : [
        PI_CONVERSATION.header({
          cwd: await realpath(cwd).catch(ifMissing(cwd)),
          session: sessionIdFor(task),
          at: new Date().toISOString(),
        }) ?? '',
      ]
  await appendLines(record, [...head, ...lines])
}
