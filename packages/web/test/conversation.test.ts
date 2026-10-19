import { describe, expect, it } from 'vitest'
import { agentOf } from '../src/agent.ts'
import { CALL_ID_BYTES, callAsked, callKey } from '../src/answered.ts'
import {
  briefOf,
  briefOut,
  callOf,
  cleanWhole,
  inputText,
  NOWHERE,
  TURNS,
  turnsOf,
} from '../src/conversation.ts'
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

  it('takes out every path, key and credential, and carries nothing of what it answered', () => {
    const made = callOf(
      { command: `cat ${PRIVATE.home}/config.yaml`, key: HELD_KEY, cwd: PRIVATE.worktree },
      `token: ${PRIVATE.credential} from ${PRIVATE.worktree}`,
      [HELD_KEY],
      undefined,
      'toolu_1',
    )
    const said = JSON.stringify(made.call)
    for (const one of SECRETS) expect(said, one).not.toContain(one)
    expect(made.taken).toBeGreaterThanOrEqual(2)
    expect(made.call.input?.words).toContain('cat …')
    // Whether it answered and what to ask for it by — never the answer itself.
    expect(made.call).toMatchObject({ answered: 'words', id: 'toolu_1' })
    expect(said).not.toContain('token:')
  })

  it('carries everything it was handed, however long, and never cuts a key in half', () => {
    const long = `${'x\n'.repeat(5_000)}${HELD_KEY}`
    const made = callOf({ content: long }, '', [HELD_KEY])
    // `content:` on a line of its own, then every line it was handed.
    expect(made.call.input?.words.split('\n')).toHaveLength(5_002)
    expect(made.call.input?.more).toBe(false)
    expect(made.call.input?.words).not.toContain(HELD_KEY.slice(0, 5))
    expect(cleanWhole('y'.repeat(1_000_000), []).said).toEqual({
      words: 'y'.repeat(1_000_000),
      more: false,
    })
  })

  it('asks for every id a harness recorded, spelling the ones not shaped like one', () => {
    // pi on OpenAI's Responses API, an ACP agent's own choice, and a path.
    for (const id of ['call_0Kx|fc_68f0a1b2c3d4e5f6', 'read file 3', '../../etc', 'ü/<b>']) {
      const key = callOf({}, 'a', [], undefined, id).call.id
      expect(key, id).toMatch(/^~[\w-]+$/)
      expect(callAsked(key ?? ''), id).toBe(id)
    }
    expect(callOf({}, 'a', [], undefined, 'toolu_1').call.id).toBe('toolu_1')
    expect(callAsked('toolu_1')).toBe('toolu_1')
    // Only what `callKey` makes is read as an id: no path, no other spelling.
    expect(callAsked('../../etc')).toBeNull()
    expect(callAsked('~')).toBeNull()
    expect(callAsked(`~${Buffer.from('toolu_1').toString('base64url')}`)).toBeNull()
    expect(callAsked('~_w')).toBeNull()
    expect(callKey('x'.repeat(CALL_ID_BYTES + 1))).toBeNull()
    const longest = callKey('|'.repeat(CALL_ID_BYTES)) ?? ''
    expect(callAsked(longest)).toBe('|'.repeat(CALL_ID_BYTES))
  })
})

describe('a call with nothing to ask its answer by', () => {
  const long = Array.from(
    { length: 5_000 },
    (_, n) => `line ${n + 1} read ${PRIVATE.worktree}/a.ts with ${HELD_KEY}`,
  ).join('\n')

  it('carries the whole of its answer, however long, cleaned the way one read by id is', () => {
    const made = callOf({ command: 'cat a.ts' }, long, [HELD_KEY])
    expect(made.call.id).toBeNull()
    const lines = made.call.answer?.words.split('\n') ?? []
    expect(lines).toHaveLength(5_000)
    expect(lines.at(-1)).toMatch(/^line 5000 read /)
    expect(made.call.answer?.more).toBe(false)
    const said = JSON.stringify(made.call)
    for (const one of SECRETS) expect(said, one).not.toContain(one)
    expect(made.taken).toBeGreaterThanOrEqual(10_000)
    expect(said).not.toMatch(/not on this page|more lines|more than/)
  })

  it('carries nothing where it has an id, and nothing where it answered no words', () => {
    expect(callOf({}, long, [], undefined, 'toolu_1').call.answer).toBeNull()
    expect(callOf({}, '', []).call).toMatchObject({ answered: 'nothing', answer: null })
    expect(callOf({}, null, []).call).toMatchObject({ answered: 'none', answer: null })
  })

  it('is an agent call with an empty id: what its page held, marked where that was only the start', () => {
    const turn = (result: string, cut?: true) =>
      turnsOf(
        [
          {
            kind: 'tool',
            id: '',
            tool: 'shell',
            input: {},
            ok: true,
            result,
            at: 1,
            ...(cut && { cut }),
          },
        ],
        [],
      ).turns[0]?.call
    expect(turn('a\nb')).toMatchObject({ id: null, answer: { words: 'a\nb' } })
    expect(turn('a\nb', true)?.answer?.words).toBe('a\nb\n…')
  })

  it('is a line of the conversation with Tade that has no id, its answer whole on the snapshot', () => {
    const lines = talk().lines.map((line) =>
      line.call === null ? line : { ...line, call: { input: line.call.input, result: long } },
    )
    const row = snapshotOf(
      input({ reach: reach(EVERY), talk: talk({ lines, known: [PRIVATE.opaque, HELD_KEY] }) }),
      NOW,
    ).chat.find((one) => one.kind === 'tool')
    expect(() => ChatRowSchema.parse(row)).not.toThrow()
    expect(row?.call?.id).toBeNull()
    expect(row?.call?.answer?.words.split('\n')).toHaveLength(5_000)
    for (const one of SECRETS) expect(JSON.stringify(row), one).not.toContain(one)
  })
})

describe('an answer of nothing and an answer nobody kept', () => {
  it('cross as two different facts', () => {
    expect(callOf({ command: 'rm -r old' }, '', []).call.answered).toBe('nothing')
    expect(callOf({ command: 'rm -r old' }, null, []).call.answered).toBe('none')
  })

  it('tell a call that answered where its record does not say how it went from one nothing answered', () => {
    const turn = (ok: boolean | null, result: string | null) =>
      turnsOf([{ kind: 'tool', id: 'c1', tool: 'shell', input: {}, ok, result, at: 1 }], [])
        .turns[0]
    expect(turn(null, '')).toMatchObject({ outcome: 'unknown', call: { answered: 'nothing' } })
    expect(turn(null, null)).toMatchObject({ outcome: 'none', call: { answered: 'none' } })
    expect(turn(false, 'Exit code: 1')).toMatchObject({
      outcome: 'failed',
      call: { answered: 'words', id: 'c1' },
    })
    expect(turn(true, '')).toMatchObject({ outcome: 'ok', call: { answered: 'nothing' } })
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
    expect(row?.call).toMatchObject({ answered: 'words', id: 'call_status' })
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
    expect(turns[2]?.call).toMatchObject({ answered: 'words' })
    expect(turns[3]?.text?.words).toContain('| `snapshot.ts` | 120 |')
    expect(answer.conversation?.before).toBe('2048')
    expect(answer.conversation?.taken).toBeGreaterThan(0)
    const said = JSON.stringify(answer)
    for (const one of SECRETS) expect(said, one).not.toContain(one)
  })

  it('is sent with no turns to a page that already holds that revision', () => {
    const answer = agentOf(reach(['lanes']), tasks, TASK, agentHeld(), undefined, '7')
    expect(answer.conversation).toEqual({ rev: '7', turns: null, before: '2048', taken: 0 })
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
      agentHeld({ conversation: { kind: 'read', turns: [], before: null, rev: '1' } }),
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

  it('carries every turn of a page of its record, none cut', () => {
    const many = Array.from({ length: TURNS.turns + 10 }, (_, n) => ({
      kind: 'reply' as const,
      text: `turn ${n}`,
      at: n + 1,
    }))
    const kept = turnsOf(many, []).turns
    expect(kept.length).toBe(TURNS.turns + 10)
    expect(kept[0]?.text?.words).toBe('turn 0')
    expect(kept.at(-1)?.text?.words).toBe(`turn ${TURNS.turns + 9}`)
  })
})

describe('the line that names a call', () => {
  const places = { work: null, tade: '/home/ann/.tade', home: '/home/ann' }

  it('says which file, with the home as `~` and every name of a long path kept', () => {
    expect(
      briefOut(
        { file_path: '/home/ann/.tade/projects/tade/tasks/one/attachments/NAMES.md' },
        places,
        [],
      ),
    ).toBe('~/.tade/projects/tade/tasks/one/attachments/NAMES.md')
    expect(briefOut({ file_path: '/home/ann/code/a.ts', limit: 20 }, places, [])).toBe(
      '~/code/a.ts · limit 20',
    )
    // A path outside the places the window knows is its last name, as an approval's is.
    expect(briefOut({ file_path: '/srv/private/keys.txt' }, places, [])).toBe('…/keys.txt')
    expect(briefOut({ file_path: '/home/ann/a.ts' }, NOWHERE, [])).toBe('…/a.ts')
  })

  it('takes a key out of a command, and names the call as the window does', () => {
    const brief = briefOut(
      {
        command: 'curl -H "Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz" x',
        description: 'Ask',
      },
      places,
      [],
    )
    expect(brief).not.toContain('sk-ant-api03')
    expect(brief.startsWith('"curl')).toBe(true)
    expect(briefOut({ project: 'tade', name: 'away-chat' }, places, [])).toBe('tade · away-chat')
    expect(callOf({ file_path: '/home/ann/a.ts' }, 'x', [], places).call.brief).toBe('~/a.ts')
  })

  it('goes out whole however long, a multi-line command on one line and nothing cut or marked', () => {
    const lines = Array.from({ length: 120 }, (_, n) => `echo "step ${n} of the long one"`)
    const command = lines.join('\n')
    expect(command.length).toBeGreaterThan(2_000)
    const made = callOf({ command, description: 'x'.repeat(300) }, null, [], places).call
    const flat = lines.join(' ')
    expect(made.brief).toBe(`"${flat}" · ${'x'.repeat(300)}`)
    expect(made.brief?.length).toBeGreaterThan(2_000)
    expect(made.brief).not.toContain('…')
    // Every word it was handed is still there to open onto, as it was written.
    expect(made.input?.words).toBe(`command:\n${command}\ndescription: ${'x'.repeat(300)}`)
    // And it is what the protocol carries: no schema cuts it either.
    const row = ChatRowSchema.parse({
      id: '2026-10-19T09:00:00.000Z#0',
      at: '2026-10-19T09:00:00.000Z',
      kind: 'tool',
      from: null,
      text: null,
      tool: 'Bash',
      outcome: 'ok',
      call: made,
      streaming: false,
      ask: null,
    })
    expect(row.call?.brief).toBe(made.brief)
  })
})
