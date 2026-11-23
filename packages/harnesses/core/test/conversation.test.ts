import { describe, expect, it } from 'vitest'
import {
  appendixFor,
  type Branch,
  type ConversationFormat,
  conversationSummary,
  derivedHex,
  entriesOf,
  mergeConversations,
} from '../src/conversation.ts'

// The merge is the hardest code in the shared brain, so it is held to its
// properties over many random partitions: the same lines whichever branch is
// handed first, nothing new when it is run again, every entry either side had
// still there, one marker, and the other side's messages copied word for word.

/** A format small enough to read in a failing case: one JSON object per line. */
const TOY: ConversationFormat = {
  read(line) {
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch {
      return { kind: 'unknown', why: 'a line that is not JSON' }
    }
    if (entry.kind === 'cost') return { kind: 'kept' }
    if (entry.kind !== 'say' && entry.kind !== 'note') {
      return { kind: 'unknown', why: `an entry of kind ${String(entry.kind)}` }
    }
    return {
      kind: 'entry',
      id: String(entry.id),
      parent: (entry.parent as string | null) ?? null,
      at: String(entry.at),
      message: entry.kind === 'say',
      opens: entry.kind === 'say' && entry.role === 'user',
      side: false,
      text: line,
    }
  },
  localised: (text) => text,
  copied: (text, to) => JSON.stringify({ ...JSON.parse(text), id: to.id, parent: to.parent }),
  marker: ({ id, parent, text, at }) =>
    JSON.stringify({ kind: 'say', role: 'user', id, parent, at, text }),
  pointer: () => null,
  header: () => null,
  idFor: (seed) => derivedHex(seed).slice(0, 12),
}

/** A small seeded generator, so a failing partition can be run again. */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Writer {
  lines: string[]
  leaf: string | null
}

/** One turn written onto a record: the person, then replies and notes. */
function turn(on: Writer, who: string, n: number, minute: number, pick: () => number): void {
  const at = (s: number) =>
    `2026-11-23T${String(10 + Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}.000Z`
  const write = (entry: Record<string, unknown>) => {
    on.lines.push(JSON.stringify({ ...entry, parent: on.leaf }))
    on.leaf = String(entry.id)
  }
  write({ kind: 'say', role: 'user', id: `${who}-${n}-u`, at: at(0), text: `${who} asks ${n}` })
  if (pick() < 0.3) on.lines.push(JSON.stringify({ kind: 'cost', usd: pick() }))
  if (pick() < 0.4) write({ kind: 'note', id: `${who}-${n}-n`, at: at(1), text: 'model change' })
  const replies = 1 + Math.floor(pick() * 3)
  for (let r = 0; r < replies; r++) {
    write({
      kind: 'say',
      role: 'assistant',
      id: `${who}-${n}-a${r}`,
      at: at(2 + r),
      text: 'x'.repeat(Math.floor(pick() * 200)),
    })
  }
}

/** A conversation both had, then each carrying on apart: the two branches. */
function partition(seed: number): { a: Branch; b: Branch } {
  const pick = seeded(seed)
  const shared: Writer = { lines: [], leaf: null }
  const common = Math.floor(pick() * 4)
  for (let n = 0; n < common; n++) turn(shared, 'both', n, n, pick)
  const a: Writer = { lines: [...shared.lines], leaf: shared.leaf }
  const b: Writer = { lines: [...shared.lines], leaf: shared.leaf }
  // Each side's own bookkeeping, which never travels.
  if (pick() < 0.5) b.lines.push(JSON.stringify({ kind: 'cost', usd: 1 }))
  const turnsA = Math.floor(pick() * 4)
  const turnsB = Math.floor(pick() * 4)
  for (let n = 0; n < turnsA; n++) turn(a, 'mac', n, 10 + Math.floor(pick() * 30), pick)
  for (let n = 0; n < turnsB; n++) turn(b, 'vps', n, 10 + Math.floor(pick() * 30), pick)
  return { a: { name: 'mac', lines: a.lines }, b: { name: 'vps', lines: b.lines } }
}

const ids = (lines: readonly string[]) => {
  const read = entriesOf(TOY, { name: 'x', lines })
  if (!read.ok) throw new Error(read.why)
  return read.entries.map((entry) => entry.id)
}

const SEEDS = Array.from({ length: 120 }, (_, n) => n + 1)

describe('merging two branches of one conversation', () => {
  it.each(SEEDS)('is the same whichever branch is handed first (seed %i)', (seed) => {
    const { a, b } = partition(seed)
    const ab = mergeConversations(TOY, a, b)
    const ba = mergeConversations(TOY, b, a)
    expect(ab.ok && ba.ok).toBe(true)
    if (!ab.ok || !ba.ok) return
    if (ab.fork) {
      // Byte for byte: both machines compute it, and nobody decides.
      expect(ba.lines).toEqual(ab.lines)
      expect(ba.fork).toEqual(ab.fork)
    } else {
      // One held the other: the same entries, nothing to mark.
      expect(new Set(ids(ba.lines))).toEqual(new Set(ids(ab.lines)))
      expect(ba.fork).toBeNull()
    }
  })

  it.each(SEEDS)('adds nothing when it is run again (seed %i)', (seed) => {
    const { a, b } = partition(seed)
    const merged = mergeConversations(TOY, a, b)
    if (!merged.ok) throw new Error(merged.why)
    const m = { name: 'merged', lines: merged.lines }
    for (const again of [
      mergeConversations(TOY, m, a),
      mergeConversations(TOY, b, m),
      mergeConversations(TOY, m, m),
    ]) {
      expect(again.ok).toBe(true)
      if (!again.ok) continue
      expect(again.fork).toBeNull()
      expect(new Set(ids(again.lines))).toEqual(new Set(ids(merged.lines)))
    }
    // Each machine appends what it lacks, and then holds the merged set.
    for (const side of [a, b]) {
      const after = [...side.lines, ...appendixFor(TOY, side.lines, merged.lines)]
      expect(new Set(ids(after))).toEqual(new Set(ids(merged.lines)))
      // Only ever appended: what it had is a prefix of what it has.
      expect(after.slice(0, side.lines.length)).toEqual(side.lines)
    }
  })

  it.each(SEEDS)(
    'keeps every entry, marks once, and copies the other side word for word (seed %i)',
    (seed) => {
      const { a, b } = partition(seed)
      const merged = mergeConversations(TOY, a, b)
      if (!merged.ok) throw new Error(merged.why)
      const all = new Set(ids(merged.lines))
      for (const id of [...ids(a.lines), ...ids(b.lines)]) expect(all.has(id)).toBe(true)
      const fork = merged.fork
      if (!fork) return
      const markers = merged.lines.filter((line) => line.includes('[Tade] While'))
      expect(markers).toHaveLength(1)
      const otherLines = fork.other === 'mac' ? a.lines : b.lines
      const own = new Set(ids(fork.other === 'mac' ? b.lines : a.lines))
      const theirs = otherLines.filter((line) => {
        const read = TOY.read(line)
        return read.kind === 'entry' && read.message && !own.has(read.id)
      })
      const at = merged.lines.indexOf(markers[0] as string)
      const copies = merged.lines.slice(at + 1)
      expect(copies).toHaveLength(theirs.length)
      copies.forEach((copy, n) => {
        const { id: _i, parent: _p, ...rest } = JSON.parse(copy)
        const { id: _o, parent: _q, ...was } = JSON.parse(theirs[n] as string)
        expect(rest).toEqual(was)
      })
      // The path the harness comes back along runs leaf → copies → marker → the trunk's own.
      const byId = new Map(merged.lines.map((line) => [JSON.parse(line).id, JSON.parse(line)]))
      let walk = byId.get(fork.leaf)
      const path: string[] = []
      while (walk) {
        path.push(walk.id)
        walk = walk.parent ? byId.get(walk.parent) : undefined
      }
      expect(path).toContain(fork.marker)
      const trunkLines = fork.trunk === 'mac' ? a.lines : b.lines
      expect(path).toContain(ids(trunkLines).at(-1))
    },
  )
})

describe('what stops a merge, and the budget', () => {
  it('stops at a line of a shape it does not know, and says which side and why', () => {
    const { a, b } = partition(7)
    const strange = { ...b, lines: [...b.lines, JSON.stringify({ kind: 'telepathy', id: 'z' })] }
    const merged = mergeConversations(TOY, a, strange)
    expect(merged).toEqual({
      ok: false,
      why: 'a line on vps is of a shape Tade does not know (an entry of kind telepathy), so it does not guess at it',
    })
  })

  it('refuses two different entries under one id rather than choosing', () => {
    const one = JSON.stringify({
      kind: 'say',
      role: 'user',
      id: 'same',
      parent: null,
      at: 'a',
      text: 'mac',
    })
    const other = JSON.stringify({
      kind: 'say',
      role: 'user',
      id: 'same',
      parent: null,
      at: 'a',
      text: 'vps',
    })
    const merged = mergeConversations(
      TOY,
      { name: 'mac', lines: [one] },
      { name: 'vps', lines: [other] },
    )
    expect(merged.ok).toBe(false)
    if (!merged.ok) expect(merged.why).toContain('different entries under one id, same')
  })

  it('copies whole turns up to the budget, and counts the rest in the marker', () => {
    const base: Writer = { lines: [], leaf: null }
    turn(base, 'both', 0, 0, () => 0.9)
    const a: Writer = { ...base, lines: [...base.lines] }
    const b: Writer = { ...base, lines: [...base.lines] }
    turn(a, 'mac', 0, 5, () => 0.9)
    for (let n = 0; n < 6; n++) turn(b, 'vps', n, 10 + n, () => 0.9)
    const merged = mergeConversations(
      TOY,
      { name: 'mac', lines: a.lines },
      { name: 'vps', lines: b.lines },
      900,
    )
    if (!merged.ok || !merged.fork) throw new Error('expected a fork')
    expect(merged.fork.left).toBeGreaterThan(0)
    expect(merged.fork.copied + merged.fork.left).toBe(6)
    expect(merged.fork.said).toContain(
      `the last ${merged.fork.left} stay in this conversation's record`,
    )
    expect(merged.fork.said).toContain('What follows is what happened on vps (6 turns)')
    expect(merged.fork.said).toContain('10:05–10:15 UTC')
  })

  it('makes ids that step past every one either branch holds', () => {
    const tiny: ConversationFormat = {
      ...TOY,
      idFor: (seed) => (seed.includes('#') ? `x${seed.length}` : 'taken'),
    }
    const a = [
      JSON.stringify({ kind: 'say', role: 'user', id: 'taken', parent: null, at: '1', text: 'a' }),
    ]
    const b = [
      JSON.stringify({ kind: 'say', role: 'user', id: 'b1', parent: null, at: '2', text: 'b' }),
    ]
    const merged = mergeConversations(tiny, { name: 'mac', lines: a }, { name: 'vps', lines: b })
    if (!merged.ok || !merged.fork) throw new Error('expected a fork')
    expect(merged.fork.marker).not.toBe('taken')
    expect(new Set(ids(merged.lines)).size).toBe(ids(merged.lines).length)
  })

  it('is held over partitions that fork and ones that do not, not one kind alone', () => {
    const forks = SEEDS.filter((seed) => {
      const { a, b } = partition(seed)
      const merged = mergeConversations(TOY, a, b)
      return merged.ok && merged.fork !== null
    }).length
    expect(forks).toBeGreaterThan(SEEDS.length / 3)
    expect(forks).toBeLessThan(SEEDS.length)
  })

  it('sums a branch by its ids alone, whatever the order', () => {
    expect(conversationSummary(['b', 'a', 'a'])).toEqual(conversationSummary(['a', 'b']))
    expect(conversationSummary(['a']).entries).toBe(1)
  })
})
