import { createHash } from 'node:crypto'

// One orchestrator conversation on every machine: the part of it every harness
// shares, and the merge.
//
// A harness's record of a conversation is not a transcript. pi's and Claude
// Code's are both append-only trees of entries, each with an id and its
// parent's, so two machines that carried on while they could not reach each
// other hold two branches of one tree — never two conversations. Replicating
// one is therefore a grow-only set of entries keyed by id, the shape notes and
// feeds already have; and two branches are made one by appending, never by
// rewriting.
//
// **What travels is the conversation, and only the conversation.** Each line a
// harness writes is one of three things (`ConversationLine`): an entry of the
// tree, the harness's own bookkeeping for this machine — what a request cost,
// which mode it was in, the request it sent, which is most of Claude Code's
// file by bytes and none of the conversation — or a shape the harness's reader
// does not know. Bookkeeping stays where it was written. A shape nobody knows
// **stops the merge**: both branches stay exactly as they are and the reason
// is said, because a guess about the structure of somebody else's private
// format is how a conversation gets corrupted quietly.
//
// **The merge is a pure function of the two branches** (`mergeConversations`),
// so both machines compute it byte for byte with nobody deciding: the same
// answer whichever is handed first, nothing new when it is run again, and every
// entry either side had still there. The trunk is the branch that went its own
// way first; onto the trunk's last entry go one marker and verbatim copies of
// the other branch's messages under ids derived from the originals, so the
// model reads both sides in order. Past a budget the copies stop at a whole
// turn and the marker counts what stayed in the tree uncopied: a summary goes
// beside the words, never in place of them, and nothing here can write one —
// writing one is a model's job, and a model is not a pure function.
//
// Canonical lines: an entry's text with this machine's own fields (its working
// directory) blanked, so two machines' copies of one entry compare equal. Each
// harness's format writes them back for where it is (`localised`).

/** One line of a harness's record, as its format reads it. */
export type ConversationLine =
  | {
      kind: 'entry'
      id: string
      /** Its parent's id; null for a root. */
      parent: string | null
      /** When it was written, as the record says it: ISO, compared as text. */
      at: string
      /**
       * Part of what the model is sent — what somebody said, a reply, a tool's
       * answer — rather than an entry about the conversation. What is copied
       * onto the trunk.
       */
      message: boolean
      /** Begins a turn: words said to it, not a tool's answer. Where the budget cuts. */
      opens: boolean
      /** A side conversation (a subagent's), never on the main path. */
      side: boolean
      /** The line with this machine's own fields blanked. */
      text: string
    }
  /** The harness's own bookkeeping, for this machine: never replicated, never merged. */
  | { kind: 'kept' }
  /** A shape this reader does not know, and why: what stops a merge. */
  | { kind: 'unknown'; why: string }

/** An entry of the tree, read. */
export type ConversationEntry = Extract<ConversationLine, { kind: 'entry' }>

/**
 * How one harness's record is read and written, for replicating it. Pure, and
 * declared by the adapter that owns the format: nothing else reads another
 * harness's records.
 */
export interface ConversationFormat {
  /** What one line is. */
  read(line: string): ConversationLine
  /** A canonical line written back for this machine. */
  localised(text: string, here: { cwd: string }): string
  /** A copy of an entry under another id and parent: every other byte as it was. */
  copied(text: string, to: { id: string; parent: string }): string
  /** The entry Tade writes before the copies, in the shape of `like` (the trunk's last entry). */
  marker(m: { id: string; parent: string; text: string; at: string; like: string }): string
  /**
   * A line that points the harness at where to come back to, appended after a
   * merge where the harness reads one (Claude Code's `last-prompt`): its own
   * bookkeeping, so it is never replicated. Null where the harness needs none.
   */
  pointer(leaf: string, text: string, like: string): string | null
  /** The line a record begins with where it has one (pi's header), for a record made here. */
  header(here: { cwd: string; session: string; at: string }): string | null
  /** An id derived from a seed: the same on every machine, and the shape the harness's are. */
  idFor(seed: string): string
}

/** How many bytes of the other branch are copied onto the trunk, at most, in whole turns. */
export const MERGE_BUDGET = 256 * 1024

/** What one branch is called, by the machine it came from: what the marker names. */
export interface Branch {
  /** What that machine calls itself (`machineLabel` there), so both name it alike. */
  name: string
  /** Its canonical lines, in the order its record holds them. */
  lines: readonly string[]
}

/** What merging two branches came to. */
export type Merged =
  /** One holds everything the other does: nothing is forked, only what is missing is appended. */
  | { ok: true; fork: null; lines: string[] }
  | {
      ok: true
      fork: {
        /** The branch the other was appended onto. */
        trunk: string
        /** The branch whose messages were copied onto it. */
        other: string
        /** The marker's id, and the entry to come back to: the last copy, or the marker. */
        marker: string
        leaf: string
        /** Turns of the other branch copied, and left in the tree uncopied past the budget. */
        copied: number
        left: number
        /** The marker's words. */
        said: string
      }
      lines: string[]
    }
  /** It could not be merged, in words: both branches stay exactly as they are. */
  | { ok: false; why: string }

/** The entries of one branch, in its order, or why they cannot be read. */
export function entriesOf(
  format: ConversationFormat,
  branch: Branch,
): { ok: true; entries: ConversationEntry[] } | { ok: false; why: string } {
  const entries: ConversationEntry[] = []
  const seen = new Map<string, string>()
  for (const line of branch.lines) {
    if (line.trim() === '') continue
    const read = format.read(line)
    if (read.kind === 'kept') continue
    if (read.kind === 'unknown') {
      return {
        ok: false,
        why: `a line on ${branch.name} is of a shape Tade does not know (${read.why}), so it does not guess at it`,
      }
    }
    const before = seen.get(read.id)
    if (before !== undefined) {
      if (before === read.text) continue
      return {
        ok: false,
        why: `${branch.name} holds two different entries under one id, ${read.id}`,
      }
    }
    seen.set(read.id, read.text)
    entries.push(read)
  }
  return { ok: true, entries }
}

/**
 * The two branches made one: a pure function of them, the same whichever is
 * handed first, and nothing new when one already holds the other.
 *
 * Where neither holds everything the other does, the trunk is the branch whose
 * first entry of its own was written first (the earlier id on a tie), and the
 * answer is the trunk's entries, then the other's own, then one marker on the
 * trunk's last entry and copies of the other's messages after it — so every
 * entry either side had is still there and both machines append the same lines.
 */
export function mergeConversations(
  format: ConversationFormat,
  a: Branch,
  b: Branch,
  budget = MERGE_BUDGET,
): Merged {
  const readA = entriesOf(format, a)
  if (!readA.ok) return readA
  const readB = entriesOf(format, b)
  if (!readB.ok) return readB
  const inA = new Map(readA.entries.map((entry) => [entry.id, entry]))
  const inB = new Map(readB.entries.map((entry) => [entry.id, entry]))
  for (const [id, entry] of inA) {
    const there = inB.get(id)
    if (there && there.text !== entry.text) {
      return {
        ok: false,
        why: `${a.name} and ${b.name} hold different entries under one id, ${id}, so neither is taken over the other`,
      }
    }
  }
  const onlyA = readA.entries.filter((entry) => !inB.has(entry.id))
  const onlyB = readB.entries.filter((entry) => !inA.has(entry.id))
  if (onlyB.length === 0) return { ok: true, fork: null, lines: readA.entries.map((e) => e.text) }
  if (onlyA.length === 0) return { ok: true, fork: null, lines: readB.entries.map((e) => e.text) }

  const [firstA, firstB] = [onlyA[0] as ConversationEntry, onlyB[0] as ConversationEntry]
  const aFirst = firstA.at < firstB.at || (firstA.at === firstB.at && firstA.id < firstB.id)
  const [trunk, trunkOwn, other, otherOwn] = aFirst
    ? [{ name: a.name, entries: readA.entries }, onlyA, { name: b.name }, onlyB]
    : [{ name: b.name, entries: readB.entries }, onlyB, { name: a.name }, onlyA]
  const leafOf = [...trunkOwn].reverse().find((entry) => !entry.side) ?? trunkOwn.at(-1)
  if (!leafOf) return { ok: false, why: 'the trunk has no entry of its own to append onto' }

  // Whole turns of the other branch's messages, until the budget.
  const turns: ConversationEntry[][] = []
  for (const entry of otherOwn) {
    if (entry.side || !entry.message) continue
    if (entry.opens || turns.length === 0) turns.push([])
    turns.at(-1)?.push(entry)
  }
  const kept: ConversationEntry[][] = []
  let bytes = 0
  for (const turn of turns) {
    const size = turn.reduce((sum, entry) => sum + Buffer.byteLength(entry.text), 0)
    if (bytes + size > budget) break
    bytes += size
    kept.push(turn)
  }
  const left = turns.length - kept.length

  const own = [...trunkOwn, ...otherOwn]
  // Times as the records wrote them, compared as text: ISO sorts as it reads.
  const times = own.map((entry) => entry.at).sort()
  const from = times[0] ?? ''
  const to = times.at(-1) ?? ''
  // Ids made here step past every id either branch holds: pi's are 32 bits.
  const taken = new Set([...inA.keys(), ...inB.keys()])
  const fresh = (seed: string): string => {
    let id = format.idFor(seed)
    for (let n = 1; taken.has(id); n++) id = format.idFor(`${seed}#${n}`)
    taken.add(id)
    return id
  }
  const marker = fresh(`merge:${leafOf.id}:${otherOwn[0]?.id ?? ''}:${otherOwn.at(-1)?.id ?? ''}`)
  const said = markerWords({
    trunk: trunk.name,
    other: other.name,
    from,
    to,
    copied: kept.length,
    left,
  })
  const lines = [...trunk.entries.map((e) => e.text), ...otherOwn.map((e) => e.text)]
  lines.push(
    format.marker({ id: marker, parent: leafOf.id, text: said, at: to, like: leafOf.text }),
  )
  let parent = marker
  for (const entry of kept.flat()) {
    const id = fresh(`copy:${marker}:${entry.id}`)
    lines.push(format.copied(entry.text, { id, parent }))
    parent = id
  }
  return {
    ok: true,
    fork: {
      trunk: trunk.name,
      other: other.name,
      marker,
      leaf: parent,
      copied: kept.length,
      left,
      said,
    },
    lines,
  }
}

/** The marker's words: Tade's sentence, in front of what happened on the other side. */
export function markerWords(m: {
  trunk: string
  other: string
  from: string
  to: string
  copied: number
  left: number
}): string {
  const span = `${clock(m.from)}–${clock(m.to)} UTC`
  const all = m.copied + m.left
  const turns = `${all} turn${all === 1 ? '' : 's'}`
  const head = `[Tade] While ${m.trunk} and ${m.other} could not reach each other, ${span}, this conversation went on on both. What follows is what happened on ${m.other} (${turns}), copied word for word after what happened on ${m.trunk}.`
  if (m.left === 0) return head
  return `${head} Only the first ${m.copied} fit here; the last ${m.left} stay in this conversation's record on both machines, uncopied, and the person can be asked about them.`
}

/** A record's time as `HH:MM`, read off the ISO text itself: the same on every machine. */
function clock(at: string): string {
  return /T(\d\d:\d\d)/.exec(at)?.[1] ?? at
}

/** The lines of `merged` that `local` does not hold yet, in order: all a machine ever appends. */
export function appendixFor(
  format: ConversationFormat,
  local: readonly string[],
  merged: readonly string[],
): string[] {
  const held = new Set<string>()
  for (const line of local) {
    const read = format.read(line)
    if (read.kind === 'entry') held.add(read.id)
  }
  return merged.filter((line) => {
    const read = format.read(line)
    return read.kind === 'entry' && !held.has(read.id)
  })
}

/** Where one branch stands, to compare with another without sending it: how many entries, and their ids hashed sorted. */
export interface ConversationSummary {
  entries: number
  /** sha256 over the sorted ids, one per line: equal sets, equal hashes, whatever the order. */
  ids: string
}

export function conversationSummary(ids: Iterable<string>): ConversationSummary {
  const sorted = [...new Set(ids)].sort()
  return {
    entries: sorted.length,
    ids: createHash('sha256').update(sorted.join('\n')).digest('hex'),
  }
}

/**
 * A name-based id, as hex, out of a seed: what each format makes its derived
 * ids from (a v5-shaped UUID for Claude Code, eight hex for pi).
 */
export function derivedHex(seed: string): string {
  return createHash('sha1').update(`tade:conversation:${seed}`).digest('hex')
}
