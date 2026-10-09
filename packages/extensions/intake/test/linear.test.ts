import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  advanceCursor,
  ConfigSchema,
  INTAKE_NOT_SUPPORTED,
  INTAKE_SETUP,
  INTAKE_SOURCES,
  type IntakeCandidate,
  type IntakeGrantRead,
  intakeContext,
  intakeDecision,
  intakeHash,
  intakeMapped,
  intakePrompt,
  intakeSummary,
  intakeUnfinished,
  mustBeTold,
  watchesToOffer,
} from '@tade/core'
import { ExtensionHost, intakeProblem, Unreachable } from '@tade/extensions-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  atOf,
  LINEAR_TEAM,
  type LinearOptions,
  type LinearScript,
  linearScript,
} from '../../../../test/fixtures/linear/linear.ts'
import { intakeExtension } from '../src/extension.ts'
import { LINEAR_MOST_HISTORY, LINEAR_MOST_ISSUES, linearIssues } from '../src/linear.ts'
import { appliedBy, requesterOf } from '../src/linear-issue.ts'

// The Linear door, against a Linear that answers from a file.
//
// Nothing here reaches the network, and the global `fetch` is taken away for
// the whole file so that anything which tried would fail here rather than
// quietly succeed on a laptop and fail in CI. **No key is used and none
// exists**: the one the host is given is the string `lin_api_pretend`, and the
// fixture never looks at it.
//
// **Everything about who may ask is tested against `intakeDecision`** rather
// than against this watch, because the watch deliberately cannot see a grant:
// it hands over candidates and the owner's own rule decides. What is tested
// here is what it hands over, what it refuses to hand over, what it says it
// could not read, and the one thing it can be asked afterwards.

const globally = globalThis.fetch
beforeAll(() => {
  globalThis.fetch = (async (input: unknown) => {
    throw new Error(`the Linear intake tests reached the network: ${String(input)}`)
  }) as typeof fetch
})
afterAll(() => {
  globalThis.fetch = globally
})

/** The moment the watch was turned on. Every issue in the fixture is an offset from it. */
const BASE = Math.floor(Date.parse('2026-09-19T00:00:00.000Z') / 1000)
const TURNED_ON = new Date(BASE * 1000).toISOString()
const LABEL = 'tade'
const at = (seconds: number) => atOf(BASE, seconds)

async function host(script: LinearScript, over: { key?: string | undefined } = {}) {
  return ExtensionHost.load({
    builtin: [intakeExtension],
    config: {
      extensions: {},
      projects: { app: { root: mkdtempSync(join(tmpdir(), 'tade-linear-')) } },
    },
    home: mkdtempSync(join(tmpdir(), 'tade-linear-home-')),
    env: 'key' in over ? { LINEAR_API_KEY: over.key } : { LINEAR_API_KEY: 'lin_api_pretend' },
    fetch: script.fetch,
  })
}

const looking = (over: { since?: string | null; team?: string; label?: string } = {}) => ({
  project: 'app',
  input: { team: over.team ?? LINEAR_TEAM, label: over.label ?? LABEL },
  since: over.since ?? null,
  turnedOn: TURNED_ON,
})

const linear = (over: Partial<LinearOptions> = {}) => linearScript({ base: BASE, ...over })

const look = async (script: LinearScript, over: Parameters<typeof looking>[0] = {}) =>
  (await host(script)).look('intake.linear', looking(over))

const intakeOf = (finding: { intake?: IntakeCandidate }): IntakeCandidate =>
  finding.intake as IntakeCandidate

/** One issue, as Linear returns one, with whichever fields a test is about written over. */
const issue = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  identifier: 'ENG-500',
  title: 'the export button 500s',
  description: 'when nothing is selected',
  url: 'https://linear.app/acme/issue/ENG-500',
  updatedAt: at(300),
  trashed: null,
  state: { type: 'started' },
  team: { key: LINEAR_TEAM },
  labels: { nodes: [{ name: LABEL }] },
  creator: { id: 'u-sam', displayName: 'sam' },
  botActor: null,
  history: {
    nodes: [
      {
        createdAt: at(300),
        actor: { id: 'u-kim', displayName: 'kim' },
        botActor: null,
        addedLabels: [{ name: LABEL }],
      },
    ],
  },
  ...over,
})

describe('where the next look starts', () => {
  const marks = [at(100), at(200), at(300)]

  it('does not move at all when the sweep did not reach the bottom of its window', () => {
    expect(advanceCursor('linear', marks, [], TURNED_ON, false)).toBe(TURNED_ON)
  })

  it('moves to the newest it dealt with when it drained', () => {
    expect(advanceCursor('linear', marks, [], TURNED_ON, true)).toBe(at(300))
  })

  it('stops below the oldest it deferred, so nothing vanishes with nothing written down', () => {
    expect(advanceCursor('linear', marks, [at(200)], TURNED_ON, true)).toBe(at(100))
  })

  it('skips a mark this source cannot compare with itself', () => {
    expect(advanceCursor('linear', [...marks, 'whenever'], [], TURNED_ON, true)).toBe(at(300))
  })
})

describe('who the Linear door says asked', () => {
  it('is whoever applied the label, and never whoever filed the issue', async () => {
    const found = await look(linear(), {})
    const one = intakeOf(found.found[0] as { intake?: IntakeCandidate })
    expect(one.externalId).toBe('ENG-412')
    // sam filed it; kim labelled it. Reading the creator as the requester is
    // the one mistake here that would authorise the wrong person.
    expect(one.requester.id).toBe('u-kim')
    expect(one.requester.label).toContain('sam')
    expect(one.requester.label).toContain('labelled it')
  })

  it('takes the newest application, so a relabelling is the act that asked', async () => {
    const script = linear()
    const found = await (await host(script)).look('intake.linear', looking({ since: at(550) }))
    const one = intakeOf(found.found[0] as { intake?: IntakeCandidate })
    // kim applied it, it came off, rob applied it again. rob asked.
    expect(one.externalId).toBe('ENG-418')
    expect(one.requester.id).toBe('u-rob')
  })

  it('sorts history itself rather than trusting the order Linear sent', () => {
    // The fixture writes history neither oldest nor newest first, because
    // Linear documents no direction for either `orderBy`.
    const whole = issue({
      history: {
        nodes: [
          { createdAt: at(200), actor: { id: 'u-a' }, addedLabels: [{ name: LABEL }] },
          { createdAt: at(400), actor: { id: 'u-c' }, addedLabels: [{ name: LABEL }] },
          { createdAt: at(300), actor: { id: 'u-b' }, addedLabels: [{ name: LABEL }] },
        ],
      },
    })
    expect(requesterOf(appliedBy(whole, LABEL))?.id).toBe('u-c')
  })

  it('names an integration rather than passing it over, and says it is one', async () => {
    const script = linear()
    const found = await (await host(script)).look('intake.linear', looking({ since: at(650) }))
    const one = intakeOf(found.found[0] as { intake?: IntakeCandidate })
    expect(one.externalId).toBe('ENG-420')
    // Linear leaves `actor` empty for an integration and names a `botActor`.
    // Named and refused as a bot — written down — rather than unnamed, which
    // would write nothing and make somebody automating onto this machine
    // invisible.
    expect(one.requester).toMatchObject({ id: 'b-sync', bot: true })
    expect(intakeDecision(one, grant({ from: ['b-sync'] }), { project: 'app' })).toMatchObject({
      outcome: 'refused',
      why: 'is_bot',
    })
  })

  it('reads Linear’s own word that a user is an app, never the text', async () => {
    const script = linear()
    const found = await (await host(script)).look('intake.linear', looking({ since: at(710) }))
    const one = intakeOf(found.found[0] as { intake?: IntakeCandidate })
    expect(one.externalId).toBe('ENG-421')
    expect(one.requester).toMatchObject({ id: 'u-robot', bot: true })
  })

  it('names nobody where Linear named nobody, which selects nothing', () => {
    expect(requesterOf({ actor: null, botActor: null })).toBeNull()
    expect(requesterOf({ actor: { displayName: 'kim' } })).toBeNull()
    expect(requesterOf(null)).toBeNull()
  })

  it('says so, rather than finding nothing, when a label cannot be attributed', async () => {
    const found = await look(linear({ issues: [issue({ history: { nodes: [] } })] }))
    expect(found.found).toHaveLength(0)
    expect(found.said).toContain('ENG-500')
    expect(found.said).toContain('cannot name who applied it')
    expect(found.said).toContain(String(LINEAR_MOST_HISTORY))
  })
})

describe('what the Linear door selects', () => {
  it('asks Linear for one team, one label, what is not over, and what moved', async () => {
    const script = linear()
    await look(script)
    const filter = script.calls[0]?.variables.filter as Record<string, unknown>
    expect(filter).toMatchObject({
      team: { key: { eq: LINEAR_TEAM } },
      labels: { name: { eq: LABEL } },
      state: { type: { nin: ['completed', 'canceled', 'duplicate'] } },
      updatedAt: { gte: TURNED_ON },
    })
  })

  it('puts an explicit page size on every connection, which is what the budget is', async () => {
    const script = linear()
    await look(script)
    const call = script.calls[0]
    expect(call?.variables.first).toBe(25)
    expect(call?.variables.history).toBe(LINEAR_MOST_HISTORY)
    // Linear counts a connection with no `first` as 50 and multiplies, so a
    // nested one left to default costs fifty times what it needed to.
    expect(call?.query).toContain('labels(first: 1')
    expect(call?.query).toContain('history(first: $history)')
    expect(call?.query).not.toMatch(/history\(\s*\)/)
  })

  it('sends one constant document and every value as a variable', async () => {
    const script = linear()
    await look(script, { label: 'a label with a } in it' })
    const plain = linear()
    await look(plain)
    // The document does not change with what it selects on, which is the whole
    // of the injection answer: a label is a string Linear compares.
    expect(script.calls[0]?.query).toBe(plain.calls[0]?.query)
    expect(script.calls[0]?.query).not.toContain('} in it')
    expect(script.calls[0]?.variables.label).toBe('a label with a } in it')
  })

  it('cannot be turned on without a team and a label, which is the whole of the opt-in', async () => {
    const offered = (await host(linear())).watches().find((one) => one.id === 'intake.linear')
    expect([...(offered?.needs ?? [])].sort()).toEqual(['label', 'team'])
    // A watch that has to be told something is a watch nothing turns on by
    // itself — not by the first minute, not by a wizard, not by somebody
    // pressing enter. That is what "no live connector activation" is as a
    // shape rather than as a promise.
    const choice = watchesToOffer([offered as never])[0]
    expect(choice?.state).toBe('cannot')
    expect(choice?.costs).toBe(mustBeTold(offered?.needs ?? []))
    expect(choice?.costs).toContain('has to be told')
    expect((await host(linear())).watchProblem('intake.linear', {})).toMatch(/is needed/)
  })

  it('takes a team and a label and nothing else — no assignee, and no path of any kind', () => {
    // Assignment is not a selector: assigning says who should do it, not who
    // asked, and assigning Tade in Linear *is* the realtime path this slice
    // defers. Supporting it would be the half-built version of that gesture.
    const input = linearIssues.input as { properties?: Record<string, unknown> }
    expect(Object.keys(input.properties ?? {}).sort()).toEqual(['label', 'team'])
    // And the rule every intake route is held to: nothing anywhere takes a
    // path, so there is nothing to contain.
    for (const key of Object.keys(input.properties ?? {})) {
      expect(['path', 'file', 'dir', 'root', 'command', 'prompt']).not.toContain(key)
    }
  })

  it('assumes nothing about the account the key belongs to', async () => {
    const script = linear()
    await look(script)
    // No `viewer`: there is no mention to look for and no reply path, so
    // knowing who the key is would buy a nicer error and cost a request a
    // look — and reading the key's own workspace, team or user would be the
    // hard-coded account assumption this must not have. One request, and the
    // only things in it are what somebody typed.
    expect(script.calls).toHaveLength(1)
    expect(JSON.stringify(script.calls[0]?.query)).not.toContain('viewer')
    expect(Object.keys(script.calls[0]?.variables ?? {}).sort()).toEqual([
      'after',
      'filter',
      'first',
      'history',
      'label',
    ])
  })

  it('refuses a team name where a team key was wanted', async () => {
    await expect(look(linear(), { team: 'Engineering Team' })).rejects.toThrow(/team key/)
    await expect(look(linear(), { team: '' })).rejects.toThrow(/every team/)
    await expect(look(linear(), { label: '' })).rejects.toThrow(/any issue/)
  })
})

describe('what one look costs, and what it leaves behind', () => {
  const many = (count: number) =>
    Array.from({ length: count }, (_, n) =>
      issue({
        identifier: `ENG-${600 + n}`,
        updatedAt: at(100 + n * 10),
        url: `https://linear.app/acme/issue/ENG-${600 + n}`,
        history: {
          nodes: [
            { createdAt: at(100 + n * 10), actor: { id: 'u-kim' }, addedLabels: [{ name: LABEL }] },
          ],
        },
      }),
    )

  it('hands over the oldest first, because this source carries a time cursor', async () => {
    const found = await look(linear({ issues: many(3) }))
    // The fixture answers newest first, the way Linear's own advice for polling
    // would have it. A bounded look that took them in that order would leave
    // the older ones behind with the cursor already past them.
    expect(found.found.map((one) => intakeOf(one).externalId)).toEqual([
      'ENG-600',
      'ENG-601',
      'ENG-602',
    ])
  })

  it('hands over no more than one look’s worth, and says how many are waiting', async () => {
    const found = await look(linear({ issues: many(LINEAR_MOST_ISSUES + 2) }))
    expect(found.found).toHaveLength(LINEAR_MOST_ISSUES)
  })

  it('leaves the cursor below the oldest it deferred', async () => {
    const found = await look(linear({ issues: many(LINEAR_MOST_ISSUES + 2) }))
    // Three were handed over and two were not. The cursor must stop below the
    // oldest of the two, which is the fourth — so it is the third's own mark.
    expect(found.since).toBe(at(100 + (LINEAR_MOST_ISSUES - 1) * 10))
  })

  it('does not move the cursor at all when the sweep did not drain', async () => {
    const script = linear({ issues: many(100), pageSize: 2 })
    const found = await look(script)
    expect(found.since).toBe(TURNED_ON)
    // Three pages, and then it stops: a look has a ceiling on what it spends.
    expect(script.calls).toHaveLength(3)
    expect(found.found).toHaveLength(LINEAR_MOST_ISSUES)
  })

  it('walks pages by Linear’s own cursor', async () => {
    const script = linear({ issues: many(5), pageSize: 2 })
    await look(script)
    expect(script.calls.map((one) => one.variables.after)).toEqual([null, 'at:2', 'at:4'])
  })

  it('carries its own cursor back as the filter, inclusively', async () => {
    const script = linear()
    await look(script, { since: at(600) })
    const filter = script.calls[0]?.variables.filter as { updatedAt?: { gte?: string } }
    // `gte` and not `gt`: the issue a look ended on is read again rather than
    // skipped, which costs nothing because Tade knows which keys it has seen,
    // and is the only way two that moved in the same millisecond are both read.
    expect(filter.updatedAt?.gte).toBe(at(600))
  })

  it('refuses a cursor that is not an instant and starts from when it was turned on', async () => {
    const script = linear()
    await look(script, { since: '-P2W1D' })
    const filter = script.calls[0]?.variables.filter as { updatedAt?: { gte?: string } }
    // Linear would read `-P2W1D` as "a fortnight ago", silently.
    expect(filter.updatedAt?.gte).toBe(TURNED_ON)
  })
})

describe('what the Linear door does when Linear will not answer', () => {
  it('names the host, and only when nothing came back at all', async () => {
    await expect(look(linear({ offline: true }))).rejects.toBeInstanceOf(Unreachable)
    await expect(look(linear({ offline: true }))).rejects.toThrow(/api\.linear\.app/)
  })

  it('reads a rate limit out of a 400, which is not the 429 anybody would watch for', async () => {
    const resetsAt = Date.parse('2026-09-19T09:00:00.000Z')
    await expect(look(linear({ limitFrom: 1, resetsAt }))).rejects.toThrow(/2,500 requests/)
    await expect(look(linear({ limitFrom: 1, resetsAt }))).rejects.toThrow(
      /2026-09-19T09:00:00\.000Z/,
    )
  })

  it('ends a sweep a rate limit interrupted rather than sleeping through it', async () => {
    const found = await look(
      linear({ issues: Array.from({ length: 10 }, () => issue()), pageSize: 1, limitFrom: 2 }),
    )
    // The first page was read, so this is a look that read some of the team
    // rather than a look that could not look: the sweep ends, nothing sleeps,
    // and the next look carries on from the same place.
    expect(found.found.length).toBeGreaterThan(0)
    expect(found.since).toBe(TURNED_ON)
  })

  it('says a rate limit ended a sweep, even when Linear sent no reset header', async () => {
    const resetsAt = Date.parse('2026-09-19T09:00:00.000Z')
    const many = Array.from({ length: 10 }, (_, n) =>
      issue({ identifier: `ENG-${700 + n}`, history: { nodes: [] } }),
    )
    const said = (await look(linear({ issues: many, pageSize: 1, limitFrom: 2, resetsAt }))).said
    expect(said).toContain('rate limited')
    expect(said).toContain('2026-09-19T09:00:00.000Z')
    // And with no header at all it still says it was rate limited rather than
    // "there is more in the team than one look reads", which is a different
    // problem with a different thing to do about it.
    const quiet = (await look(linear({ issues: many, pageSize: 1, limitFrom: 2 }))).said
    expect(quiet).toContain('rate limited')
    expect(quiet).not.toContain('clear again')
    expect(quiet).not.toContain('more in the team')
  })

  it('says a key sent the wrong way is a key sent the wrong way', async () => {
    await expect(look(linear({ errorType: 'authentication error' }))).rejects.toThrow(/no "Bearer"/)
  })

  it('reads both spellings of a code, because Linear’s own material uses both', async () => {
    // `extensions.code: RATELIMITED` is the rate-limiting page's; the lowercase
    // `extensions.type` is what Linear's own SDK matches on.
    await expect(look(linear({ error: 'RATELIMITED' }))).rejects.toThrow(/2,500 requests/)
    await expect(look(linear({ errorType: 'ratelimited' }))).rejects.toThrow(/2,500 requests/)
    await expect(look(linear({ errorType: 'forbidden' }))).rejects.toThrow(/may not read ENG/)
  })

  it('carries Linear’s own words for anything it has not documented', async () => {
    await expect(look(linear({ errorType: 'lock timeout' }))).rejects.toThrow(/Linear said no/)
  })

  it('throws rather than reading an unparseable answer as an empty team', async () => {
    // Which is the failure that matters: an empty page reads everywhere above
    // as "no issue carries this label".
    await expect(look(linear({ nonsense: 'text' }))).rejects.toThrow(/not JSON/)
    await expect(look(linear({ nonsense: 'array' }))).rejects.toThrow(/not an object/)
    await expect(look(linear({ nonsense: 'empty' }))).rejects.toThrow(/neither data nor errors/)
    await expect(look(linear({ status: 502 }))).rejects.toThrow(/502/)
  })

  it('says what it needs when there is no key, and takes nothing else down with it', async () => {
    const empty = await host(linear(), { key: undefined })
    await expect(empty.look('intake.linear', looking())).rejects.toThrow(/LINEAR_API_KEY/)
    // The local door never needed one and keeps working, which is why
    // readiness is the extension's and not a credential check: one missing
    // credential never takes the others down with it.
    expect(empty.list().find((one) => one.name === 'intake')?.problem).toBeNull()
    const spooled = await empty.look('intake.cli', {
      project: 'app',
      input: {},
      since: null,
      turnedOn: TURNED_ON,
    })
    expect(spooled.found).toEqual([])
  })
})

describe('whether a Linear request still stands', () => {
  const stands = async (script: LinearScript, over: Parameters<typeof looking>[0] = {}) =>
    (await host(script)).recheck('intake.linear', {
      ...looking(over),
      key: `linear:ENG-500:${at(300)}`,
    })

  it('stands while the issue is the issue the work was made for', async () => {
    expect(await stands(linear({ issues: [issue()] }))).toEqual({ still: true })
  })

  it('asks Linear for that one issue, by the team and number its identifier is made of', async () => {
    const script = linear({ issues: [issue()] })
    await stands(script)
    const filter = script.calls[0]?.variables.filter as Record<string, unknown>
    expect(filter).toMatchObject({ team: { key: { eq: 'ENG' } }, number: { eq: 500 } })
    // No `updatedAt` clause: the re-check is about one issue and must not fail
    // to find it because it has not moved.
    expect(filter.updatedAt).toBeUndefined()
  })

  it('holds when it was edited, and when it reports a revision earlier than the one taken', async () => {
    const later = linear({ issues: [issue()] })
    later.touch('ENG-500', 900)
    expect(await stands(later)).toMatchObject({ still: false })
    expect(((await stands(later)) as { because: string }).because).toContain('has moved')

    const earlier = linear({ issues: [issue()] })
    earlier.touch('ENG-500', 100)
    expect(((await stands(earlier)) as { because: string }).because).toContain('earlier')
  })

  it('holds when the label came off, when it was closed, and when it is gone', async () => {
    const off = linear({ issues: [issue()] })
    off.unlabel('ENG-500', LABEL)
    expect(((await stands(off)) as { because: string }).because).toContain(
      'no longer an open issue',
    )

    const closed = linear({ issues: [issue()] })
    closed.close('ENG-500')
    expect(((await stands(closed)) as { because: string }).because).toContain('no longer an open')

    const gone = linear({ issues: [issue()] })
    gone.remove('ENG-500')
    expect(((await stands(gone)) as { because: string }).because).toContain('can no longer see it')
  })

  it('holds when nobody can be named for the label any more', async () => {
    const script = linear({ issues: [issue({ history: { nodes: [] } })] })
    expect(((await stands(script)) as { because: string }).because).toContain('nobody can be named')
  })

  it('holds when it was not told what to check, which is the plainest case there is', async () => {
    const script = linear({ issues: [issue()] })
    const host_ = await host(script)
    const noTeam = await host_.recheck('intake.linear', {
      project: 'app',
      input: { label: LABEL },
      key: `linear:ENG-500:${at(300)}`,
    })
    expect(noTeam).toMatchObject({ still: false })
    expect((noTeam as { because: string }).because).toContain('team the watch reads')
    const noLabel = await host_.recheck('intake.linear', {
      project: 'app',
      input: { team: LINEAR_TEAM },
      key: `linear:ENG-500:${at(300)}`,
    })
    expect((noLabel as { because: string }).because).toContain('label the watch selects on')
    // Nothing was asked of Linear in either case: it cannot verify what it was
    // not told, so it holds rather than checking the rest and answering yes.
    expect(script.calls).toHaveLength(0)
  })

  it('holds for a key naming another team rather than going and looking', async () => {
    const script = linear({ issues: [issue()] })
    const answer = await (await host(script)).recheck('intake.linear', {
      ...looking(),
      key: `linear:OPS-7:${at(850)}`,
    })
    expect((answer as { because: string }).because).toContain('is not in ENG')
    expect(script.calls).toHaveLength(0)
  })

  it('holds for a key this watch did not write', async () => {
    const answer = await stands(linear({ issues: [issue()] }))
    expect(answer).toEqual({ still: true })
    const other = await (await host(linear())).recheck('intake.linear', {
      ...looking(),
      key: 'github:acme/api#1:2026-01-01T00:00:00Z',
    })
    expect(other).toMatchObject({ still: false })
  })

  it('throws rather than answering, when the source cannot be asked at all', async () => {
    // A rate limit, a 500 and an outage are not "no longer stands": the start
    // door turns a throw into a hold that says the source could not be asked,
    // and `still: true` is the one answer an unreachable source may never give.
    await expect(stands(linear({ offline: true }))).rejects.toBeInstanceOf(Unreachable)
    await expect(stands(linear({ limitFrom: 1 }))).rejects.toThrow(/2,500 requests/)
  })
})

describe('what the Linear door hands over', () => {
  it('carries the issue verbatim, hashed the way every other source hashes', async () => {
    const found = await look(linear({ issues: [issue()] }))
    const one = intakeOf(found.found[0] as { intake?: IntakeCandidate })
    expect(one.verbatim).toBe('the export button 500s\n\nwhen nothing is selected')
    // The same function every source uses, because `intakeAgain` compares a
    // hash this computed against one another look recorded.
    expect(one.material.hash).toBe(intakeHash(one.verbatim))
    expect(one.url).toBe('https://linear.app/acme/issue/ENG-500')
    expect(one.sourceAt).toBe(at(300))
    expect(one.correlation).toBe(`ENG-500@${at(300)}`)
  })

  it('lists no attachments, ever', async () => {
    const found = await look(linear({ issues: [issue()] }))
    expect(intakeOf(found.found[0] as { intake?: IntakeCandidate }).attachments).toEqual([])
  })

  it('says Tade’s own words and never the issue’s, in the title and the prompt', async () => {
    const found = await look(linear({ issues: [issue()] }))
    const one = found.found[0] as { key: string; title: string; intake?: IntakeCandidate }
    const agent = await linearIssues.agent?.(one, {} as never)
    expect(one.title).toBe('linear ENG-500')
    expect(agent?.title).toBe('linear ENG-500')
    expect(agent?.prompt).toBe(intakePrompt(intakeOf(one)))
    // The body is not in the type either of them takes, which is the guarantee.
    expect(agent?.prompt).not.toContain('export button')
  })

  it('puts the body in the context file, under the one wording of what material means', async () => {
    const found = await look(linear({ issues: [issue()] }))
    const one = intakeOf(found.found[0] as { intake?: IntakeCandidate })
    const context = intakeContext({
      ...one,
      project: 'app',
      mapping: { from: 'app', by: 'surfaces.intake.sources.linear.projects' },
      grant: 'surfaces.intake.sources.linear',
    })
    expect(context).toContain('export button 500s')
    expect(context).toContain('material')
    // And the summary — which is what `intent_spoken` gets — cannot reach it.
    expect(
      intakeSummary({
        source: 'linear',
        externalId: 'ENG-500',
        requester: one.requester,
        project: 'app',
        mapping: { from: 'app', by: 'x' },
      }),
    ).not.toContain('export button')
  })

  it('carries no grant and no template, because a caller-chosen one is no grant', async () => {
    const found = await look(linear({ issues: [issue()] }))
    const one = intakeOf(found.found[0] as { intake?: IntakeCandidate }) as Record<string, unknown>
    expect(one.grant).toBeUndefined()
    expect(one.template).toBeUndefined()
    expect(one.project).toBeUndefined()
  })
})

describe('what the owner’s grant decides about a Linear request', () => {
  it('refuses a requester nobody listed, and allows one who is', async () => {
    const found = await look(linear({ issues: [issue()] }))
    const one = intakeOf(found.found[0] as { intake?: IntakeCandidate })
    const mapped = { project: 'app' }
    expect(intakeDecision(one, grant({ from: [] }), mapped)).toMatchObject({
      outcome: 'refused',
      why: 'not_allowed',
    })
    expect(intakeDecision(one, grant({ from: ['u-kim'] }), mapped)).toMatchObject({
      outcome: 'accepted',
    })
    // By id and never by the display name beside it, which in Linear is unique
    // in a workspace and therefore something somebody else can take over.
    expect(intakeDecision(one, grant({ from: ['kim'] }), mapped)).toMatchObject({
      outcome: 'refused',
      why: 'not_allowed',
    })
  })

  it('maps nowhere until the owner names the project', async () => {
    const found = await look(linear({ issues: [issue()] }))
    const one = intakeOf(found.found[0] as { intake?: IntakeCandidate })
    expect(intakeMapped(one.from, grant({ projects: [] })).project).toBeNull()
    expect(intakeMapped(one.from, grant({ projects: ['app'] })).project).toBe('app')
  })

  it('is off, for nobody, nowhere and proposed, until a person writes the grant', () => {
    // Read off the config schema rather than off a test's own builder: every
    // default here is the decision, and `from: []` meaning nobody is the one
    // whose other reading — anybody — is a hole that reads as a promise.
    const written = ConfigSchema.parse({}).surfaces.intake
    expect(written.enabled).toBe(false)
    expect(written.sources.linear).toMatchObject({
      accept: false,
      reply: false,
      names: false,
      projects: [],
      from: [],
      mode: 'propose',
      template: '',
    })
  })
})

describe('what somebody is told about turning it on, and about what is not there', () => {
  it('has setup steps of its own, and says the key goes nowhere near a write', () => {
    const steps = INTAKE_SETUP.linear.join(' ')
    expect(steps).toContain('LINEAR_API_KEY')
    expect(steps).toContain('USER IDS')
    expect(steps).toContain('team key')
    expect(steps).toContain('no reply at all')
    // What `tade intake status` prints the steps for: a grant nobody has
    // finished writing. Each clause in the order somebody meets it.
    expect(intakeUnfinished(grant({ on: false }))).toContain('surfaces.intake.enabled is off')
    expect(intakeUnfinished(grant({ accept: false }))).toBe('accept is off')
    expect(intakeUnfinished(grant({ projects: [] }))).toContain('project')
    expect(intakeUnfinished(grant({}))).toContain('nobody is on its list')
    expect(intakeUnfinished(grant({ from: ['u-kim'] }))).toBeNull()
  })

  it('says what is not a source, in words, where somebody is deciding', () => {
    const said = INTAKE_NOT_SUPPORTED.join(' ')
    // Not a disabled switch and not a roadmap: a sentence saying what each
    // would need and that nothing here is half-built towards it.
    expect(said).toContain('Jira is not supported')
    expect(said).toContain('publicly accessible HTTPS')
    expect(said).toContain('5 seconds')
    expect(said).toContain('30 days')
    expect(INTAKE_SOURCES).not.toContain('jira')
  })

  it('declares itself an intake source, and the host agrees without calling anything', async () => {
    expect(intakeProblem(linearIssues)).toBeNull()
    expect(linearIssues.intake).toBe('linear')
    expect(linearIssues.network).toBe(true)
    // A capability honoured by absence: no reply method at all is a stronger
    // guarantee than one that is turned off, and the host says so.
    expect(linearIssues.reply).toBeUndefined()
    const offered = (await host(linear())).watches().find((one) => one.id === 'intake.linear')
    expect(offered).toMatchObject({ intake: 'linear', rechecks: true, replies: false })
  })

  it('refuses to say anything back, whatever the grant says', async () => {
    await expect(
      (await host(linear())).reply('intake.linear', {
        ...looking(),
        key: `linear:ENG-500:${at(300)}`,
        say: 'Picked up.',
        mark: 'tade:linear:ENG-500:noticed',
      }),
    ).rejects.toThrow(/no way of saying anything back/)
  })
})

/**
 * One grant, as the rule reads it, with whichever keys a test is about written
 * over.
 *
 * `accept` is **on** here, which is the opposite of the real default, because
 * every test using this is about a clause *after* that one and a grant that
 * was off would refuse each of them as `no_grant` and pass for the wrong
 * reason. What the real defaults are is asserted against the config schema
 * itself, which is the only thing that can say.
 */
function grant(over: Partial<IntakeGrantRead>): IntakeGrantRead {
  return {
    path: 'surfaces.intake.sources.linear',
    on: true,
    accept: true,
    reply: false,
    names: false,
    projects: ['app'],
    from: [],
    mode: 'propose',
    template: '',
    document: '',
    ...over,
  }
}

/** The envelope-building half, exercised directly where a look cannot reach the case. */
