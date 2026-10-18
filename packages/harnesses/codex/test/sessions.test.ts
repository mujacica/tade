import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RESULT_KEPT } from '@tade/harnesses-core'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import {
  contextIn,
  conversationKey,
  historyLine,
  historyOn,
  limitsIn,
  rememberThread,
  rolloutFor,
  spentIn,
  spentOn,
  threadOf,
  turnIn,
  whoIn,
} from '../src/sessions.ts'

// Codex's own records, read as Codex writes them — against a real rollout of
// the shape a real one has, never a kinder one.

const THREAD = '01a0c2ef-021a-7c61-9d70-c2025f5a59ec'
const ROLLOUT = `rollout-2026-09-21T09-47-18-${THREAD}.jsonl`

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../../../test/fixtures/transcripts/codex/${name}`, import.meta.url))

/** A Codex home with one thread in it, filed the way Codex files one. */
function homeWith(file: string): string {
  const home = tmp('tade-codex-records-')
  const dir = join(home, 'sessions', '2026', '09', '21')
  mkdirSync(dir, { recursive: true })
  cpSync(file, join(dir, ROLLOUT))
  return home
}

describe('the thread a task talks in', () => {
  it('names a task the same way every time, and two tasks differently', () => {
    expect(conversationKey('app/refunds')).toBe(conversationKey('app/refunds'))
    expect(conversationKey('app/refunds')).not.toBe(conversationKey('app/refund'))
  })

  it('is nothing until Codex has said one, and is read back after', async () => {
    const state = tmp('tade-codex-state-')
    expect(await threadOf('app/refunds', state)).toBeNull()
    await rememberThread('app/refunds', state, THREAD)
    expect(await threadOf('app/refunds', state)).toBe(THREAD)
    // Another task's note is its own.
    expect(await threadOf('app/logout', state)).toBeNull()
  })

  it('finds the file Codex filed a thread in, by date, and says so when there is none', async () => {
    const home = homeWith(fixture(`0.154/${ROLLOUT}`))
    expect(await rolloutFor(THREAD, home)).toBe(join(home, 'sessions/2026/09/21', ROLLOUT))
    expect(await rolloutFor('nobody-at-all', home)).toBeNull()
    expect(await rolloutFor(THREAD, tmp('tade-codex-empty-'))).toBeNull()
  })
})

describe('what a rollout says', () => {
  const text = () => readFileSync(fixture(`0.154/${ROLLOUT}`), 'utf8')

  it('counts the thread’s tokens, with what was read from the cache kept apart', () => {
    const spent = spentIn(text())
    // Codex counts cached reads inside its input tokens; Tade does not.
    expect(spent).toMatchObject({
      input: 27871 - 23040,
      cacheRead: 23040,
      cacheWrite: 0,
      output: 71,
      tokens: 27942,
      messages: 2,
      model: 'gpt-5.6-terra',
    })
  })

  it('never prices a turn, because Codex writes no price down', () => {
    expect(spentIn(text()).usd).toBe(0)
  })

  it('says how full the context is, against the window its model has', () => {
    const full = contextIn(text())
    expect(full?.tokens).toBe(27942)
    expect(full?.percent).toBeCloseTo((27942 / 258400) * 100, 5)
  })

  it('reads each window by how long it is, the shorter first', () => {
    const limits = limitsIn(text(), 1_000)
    expect(limits).toEqual({
      at: 1_000,
      windows: [
        { minutes: 300, used: 13, resetsAt: 1792568749000 },
        { minutes: 10_080, used: 3.5, resetsAt: 1792999999000 },
      ],
    })
  })

  it('adds up what it can from a release that wrote no running total', () => {
    const older = readFileSync(
      fixture('0.104/rollout-2026-09-11T10-00-00-aaaaaaaa-0000-7000-8000-000000000002.jsonl'),
      'utf8',
    )
    // Nothing to count, and nothing invented: it says so rather than guessing.
    expect(spentIn(older)).toMatchObject({ tokens: 0, messages: 0, usd: 0 })
  })

  it('skips a line it cannot read rather than throwing over it', () => {
    const half = `${text().split('\n').slice(0, 8).join('\n')}\n{"type":"event_msg","payl`
    expect(spentIn(half).tokens).toBe(13645)
    expect(() => spentIn('not json at all\n\n{}\n[]\n')).not.toThrow()
    expect(spentIn('not json at all').tokens).toBe(0)
    expect(contextIn('{"type":"nonsense"}')).toBeNull()
    expect(limitsIn('{}', 1)).toBeNull()
  })
})

describe('a turn under way', () => {
  it('is read from where Codex wrote a turn starting and ending, since it started', () => {
    expect(turnIn(readFileSync(fixture(`0.154/${ROLLOUT}`), 'utf8'))).toBeNull()
    const asking = readFileSync(
      fixture('0.104/rollout-2026-09-11T10-00-00-aaaaaaaa-0000-7000-8000-000000000002.jsonl'),
      'utf8',
    )
    expect(turnIn(asking)).toEqual({ since: Date.parse('2026-09-11T10:00:01.000Z') })
    const cut =
      '{"timestamp":"2026-09-11T10:00:09.000Z","type":"event_msg","payload":{"type":"turn_aborted"}}'
    expect(turnIn(`${asking}${cut}\n`)).toBeNull()
    expect(turnIn('')).toBeNull()
  })
})

describe('what a task has spent', () => {
  it('is nothing for a task with no thread, and its thread’s total once it has one', async () => {
    const home = homeWith(fixture(`0.154/${ROLLOUT}`))
    const state = tmp('tade-codex-state-')
    expect(await spentOn('app/refunds', state, home)).toMatchObject({ tokens: 0, messages: 0 })
    await rememberThread('app/refunds', state, THREAD)
    expect(await spentOn('app/refunds', state, home)).toMatchObject({ tokens: 27942 })
    // A note pointing at a thread this home has never heard of is not spend.
    await rememberThread('app/logout', state, 'a-thread-nobody-kept')
    expect(await spentOn('app/logout', state, home)).toMatchObject({ tokens: 0 })
  })
})

describe('who a Codex home is signed in as', () => {
  it('reads the claims of the sign-in it keeps, and nothing else', async () => {
    const home = tmp('tade-codex-auth-')
    const claims = {
      email: 'someone@example.com',
      'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' },
    }
    const jwt = `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ tokens: { id_token: jwt } }))
    expect(await whoIn(home)).toEqual({ who: 'someone@example.com', plan: 'plus' })
  })

  it('says nobody rather than throwing, for a home with nothing to read', async () => {
    expect(await whoIn(tmp('tade-codex-none-'))).toEqual({ who: null, plan: null })
    const broken = tmp('tade-codex-broken-')
    writeFileSync(join(broken, 'auth.json'), '{ not json')
    expect(await whoIn(broken)).toEqual({ who: null, plan: null })
    const shapeless = tmp('tade-codex-shapeless-')
    writeFileSync(join(shapeless, 'auth.json'), '{"tokens":{"id_token":"not-a-jwt"}}')
    expect(await whoIn(shapeless)).toEqual({ who: null, plan: null })
  })
})

describe('a conversation read back', () => {
  it('is what was sent, the tools it ran and what it said, out of the rollout of its thread', async () => {
    const state = tmp('tade-codex-state-')
    const home = homeWith(fixture(`0.154/${ROLLOUT}`))
    expect(await historyOn('app/search', state, home, { limit: 20 })).toEqual({
      items: [],
      earlier: null,
    })
    await rememberThread('app/search', state, THREAD)
    const page = await historyOn('app/search', state, home, { limit: 20 })
    expect(page.earlier).toBeNull()
    expect(page.items).toEqual([
      {
        kind: 'sent',
        text: 'delete the old pagination tests',
        images: [],
        at: Date.parse('2026-09-21T09:47:20.500Z'),
      },
      {
        kind: 'tool',
        id: 'c1',
        tool: 'shell',
        input: { input: 'rm -r test/old' },
        ok: true,
        result: '',
        at: Date.parse('2026-09-21T09:47:21.100Z'),
      },
      { kind: 'reply', text: 'Removed them.', at: Date.parse('2026-09-21T09:47:22.200Z') },
    ])
  })

  it("reads an older release's function calls, and says the same reply once", () => {
    const text = readFileSync(
      fixture('0.104/rollout-2026-09-11T09-00-00-aaaaaaaa-0000-7000-8000-000000000001.jsonl'),
      'utf8',
    )
    const items = text
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => historyLine(line)?.items ?? [])
    expect(items.map((item) => item.kind)).toEqual(['sent', 'tool', 'reply'])
    expect(items[1]).toMatchObject({ tool: 'shell', input: { command: ['rg', 'paginate'] } })
    expect(historyLine('{"type":"turn_context","payload":{}}')).toBeNull()
    expect(historyLine('not json')).toBeNull()
  })
})

describe("a tool call's answer read back", () => {
  it('is what it answered, in each shape a rollout writes it, cut at the bound', () => {
    const answer = (output: unknown) =>
      historyLine(
        JSON.stringify({
          timestamp: '2026-10-18T10:00:00.000Z',
          type: 'response_item',
          payload: { type: 'function_call_output', call_id: 'c1', output },
        }),
      )?.results
    expect(answer('Exit code: 0\nOutput:\nMakefile\n')).toEqual([
      { id: 'c1', ok: true, result: 'Exit code: 0\nOutput:\nMakefile' },
    ])
    expect(answer(JSON.stringify({ output: 'Makefile', metadata: { exit_code: 0 } }))).toEqual([
      { id: 'c1', ok: true, result: 'Makefile' },
    ])
    expect(answer([{ type: 'input_text', text: 'seen' }, { type: 'input_image' }])).toEqual([
      { id: 'c1', ok: true, result: 'seen' },
    ])
    const [kept] = answer('a\n'.repeat(100)) ?? []
    expect(kept?.result.split('\n').slice(0, -1)).toEqual(Array(RESULT_KEPT.lines).fill('a'))
    expect(kept?.result.split('\n').at(-1)).toBe('… 76 more lines (152 characters) not kept')
  })
})
