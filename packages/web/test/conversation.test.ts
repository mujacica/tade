import { describe, expect, it } from 'vitest'
import { agentOf } from '../src/agent.ts'
import { briefOf, CALL, callOf, cleanSaid, inputText, TURNS, turnsOf } from '../src/conversation.ts'
import { AgentOutSchema, ChatRowSchema } from '../src/protocol.ts'
import { projector } from '../src/reading.ts'
import { snapshotOf } from '../src/snapshot.ts'
import {
  agentHeld,
  conversationHeld,
  EVERY,
  HELD_KEY,
  input,
  NOW,
  PRIVATE,
  reach,
  talk,
} from './fixtures.ts'

// A conversation's words as they leave the machine: the orchestrator's tool
// calls on the snapshot, and an agent's turns on its own answer.
//
// **Both are nobody's words and both ride on `lanes`**, the grant for an
// agent's own bytes. So what is held here is the two halves of that: without
// the grant, nothing of a call or a turn crosses under any name; with it, what
// crosses is cleaned — no machine path, no key Tade holds, nothing shaped like
// a credential — and the markup in it is still there as text, because the page
// is what keeps it from being markup (`markdown-client.test.ts`).

const TASK = 'sentry/away-projection'
const tasks = input().tasks
const SECRETS = [
  PRIVATE.home,
  PRIVATE.root,
  PRIVATE.worktree,
  PRIVATE.transcript,
  PRIVATE.credential,
  PRIVATE.opaque,
  HELD_KEY,
  'testperson',
]

describe('a call, cleaned', () => {
  it('says which call it was on a line, and everything it was handed a line per argument', () => {
    expect(briefOf({ command: 'git status', n: 2, deep: { a: 1 } })).toBe('"git status" · n 2')
    expect(inputText({ command: 'ls', content: 'a\nb', n: 2 })).toBe(
      'command: ls\ncontent:\na\nb\nn: 2',
    )
    expect(inputText(null)).toBe('')
    expect(inputText('as it was')).toBe('as it was')
  })

  it('takes out every path, key and credential before it is cut', () => {
    const made = callOf(
      { command: `cat ${PRIVATE.home}/config.yaml`, key: HELD_KEY },
      `token: ${PRIVATE.credential} from ${PRIVATE.worktree}`,
      [HELD_KEY],
    )
    const said = JSON.stringify(made.call)
    for (const one of SECRETS) expect(said, one).not.toContain(one)
    expect(made.taken).toBeGreaterThanOrEqual(4)
    expect(made.call.input?.words).toContain('cat …')
  })

  it('never lets half a key through at the cut', () => {
    const long = `${'x'.repeat(CALL.result - 5)} ${HELD_KEY}`
    // Cleaned first and cut after: the key is a `…`, never its first five characters.
    const made = cleanSaid(long, CALL.result, [HELD_KEY])
    expect(made.taken).toBe(1)
    expect(made.said?.words).not.toContain(HELD_KEY.slice(0, 5))
  })

  it("carries a successful call's answer whole, the line saying what its harness left out included", () => {
    // As a harness's history keeps one (`keptResult`, `RESULT_KEPT` in
    // `@tade/harnesses-core`: 1,800 characters and a line), which is under this
    // bound so the line saying how much was left out reaches the page.
    const kept = `${'z'.repeat(1_800)}\n… 8,200 more characters not kept`
    const { turns } = turnsOf(
      [
        {
          kind: 'tool',
          id: 't1',
          tool: 'Read',
          input: { path: 'a.ts' },
          ok: true,
          result: kept,
          at: 1,
        },
      ],
      [],
    )
    expect(turns[0]?.outcome).toBe('ok')
    expect(turns[0]?.call?.result).toEqual({ words: kept, more: false })
  })

  it('cuts a megabyte to the bound and says there was more', () => {
    const made = cleanSaid('y'.repeat(1_000_000), CALL.result, [])
    expect(made.said?.words.length).toBe(CALL.result)
    expect(made.said?.more).toBe(true)
  })
})

describe('the conversation with Tade, on the snapshot', () => {
  const tool = (granted: readonly (typeof EVERY)[number][]) =>
    snapshotOf(input({ reach: reach(granted), talk: talk() }), NOW).chat.find(
      (row) => row.kind === 'tool',
    )

  it('gives a tool line its call only where an agent’s bytes were granted', () => {
    expect(tool(EVERY.filter((one) => one !== 'lanes'))?.call).toBeNull()
    const row = tool(EVERY)
    expect(() => ChatRowSchema.parse(row)).not.toThrow()
    expect(row?.call?.brief).toContain('cat …')
    expect(row?.call?.result?.words).toContain('read …')
    for (const one of SECRETS) expect(JSON.stringify(row), one).not.toContain(one)
  })

  it('bounds a reply as a body, so a long one is not cut at a row’s line', () => {
    const words = 'w'.repeat(3_000)
    const lines = talk().lines.map((line) =>
      line.kind === 'reply' ? { ...line, text: words } : line,
    )
    const chat = snapshotOf(input({ reach: reach(EVERY), talk: talk({ lines }) }), NOW).chat
    expect(chat.find((row) => row.kind === 'reply')?.text).toEqual({ words, more: false })
  })
})

describe('an agent’s conversation, on its own answer', () => {
  it('is withheld from a device not granted its screen, and says that is why', () => {
    const answer = agentOf(reach(EVERY.filter((one) => one !== 'lanes')), tasks, TASK, agentHeld())
    expect(answer.conversation).toBeNull()
    expect(answer.unread).toBe('not granted')
    expect(JSON.stringify(answer)).not.toContain('The work')
  })

  it('is cleaned for a device granted it, markup kept as text', () => {
    const answer = agentOf(reach(['lanes']), tasks, TASK, agentHeld())
    expect(() => AgentOutSchema.parse(answer)).not.toThrow()
    expect(answer.unread).toBeNull()
    const turns = answer.conversation?.turns ?? []
    expect(turns.map((one) => one.kind)).toEqual(['sent', 'tool', 'tool', 'reply'])
    expect(turns.map((one) => one.outcome)).toEqual([null, 'ok', 'failed', null])
    expect(turns[2]?.call?.result?.words).toContain('<script>alert(1)</script>')
    expect(turns[3]?.text?.words).toContain('| `snapshot.ts` | 120 |')
    expect(answer.conversation?.earlier).toBe(true)
    expect(answer.conversation?.taken).toBeGreaterThan(0)
    const said = JSON.stringify(answer)
    for (const one of SECRETS) expect(said, one).not.toContain(one)
  })

  it('is sent with no turns to a page that already holds that revision', () => {
    const answer = agentOf(reach(['lanes']), tasks, TASK, agentHeld(), undefined, '7')
    expect(answer.conversation).toEqual({ rev: '7', turns: null, earlier: true, taken: 0 })
    const moved = agentOf(reach(['lanes']), tasks, TASK, agentHeld(), undefined, '6')
    expect(moved.conversation?.turns?.length).toBe(4)
  })

  it('is threaded through a device’s reading with the revision it holds', () => {
    const held = projector(input({ reach: reach(['lanes']) }), NOW, { agent: () => agentHeld() })
    expect(held.agent(TASK).conversation?.turns?.length).toBe(4)
    expect(held.agent(TASK, '7').conversation?.turns).toBeNull()
  })

  it('tells not read yet and could not read apart from nothing said', () => {
    const none = agentOf(reach(['lanes']), tasks, TASK, agentHeld({ conversation: undefined }))
    expect(none).toMatchObject({ conversation: null, unread: 'not read yet' })
    const broken = agentOf(
      reach(['lanes']),
      tasks,
      TASK,
      agentHeld({ conversation: { kind: 'none', why: 'could not read' } }),
    )
    expect(broken).toMatchObject({ conversation: null, unread: 'could not read' })
    const quiet = agentOf(
      reach(['lanes']),
      tasks,
      TASK,
      agentHeld({ conversation: { kind: 'read', turns: [], earlier: false, rev: '1' } }),
    )
    expect(quiet.conversation?.turns).toEqual([])
    expect(quiet.unread).toBeNull()
  })

  it('keys each turn by something that does not move as the conversation grows', () => {
    const held = conversationHeld()
    const first = turnsOf(held.turns, []).turns.map((one) => one.id)
    const grown = turnsOf(
      [
        ...held.turns,
        { kind: 'reply', text: 'and one more', at: Date.parse('2026-10-08T14:25:00Z') },
      ],
      [],
    ).turns.map((one) => one.id)
    expect(grown.slice(0, first.length)).toEqual(first)
    expect(new Set(grown).size).toBe(grown.length)
    // A call's id from the record goes into a key only where it looks like one.
    const odd = turnsOf(
      [{ kind: 'tool', id: '"><script>', tool: 'x', input: {}, ok: true, result: '', at: 1 }],
      [],
    ).turns[0]
    expect(odd?.id).toBe('tool:1#0')
  })

  it('carries the newest turns and no more', () => {
    const many = Array.from({ length: TURNS.turns + 10 }, (_, n) => ({
      kind: 'reply' as const,
      text: `turn ${n}`,
      at: n + 1,
    }))
    const kept = turnsOf(many, []).turns
    expect(kept.length).toBe(TURNS.turns)
    expect(kept.at(-1)?.text?.words).toBe(`turn ${TURNS.turns + 9}`)
  })
})
