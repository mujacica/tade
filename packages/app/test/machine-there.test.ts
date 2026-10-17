import { isText } from '@tade/core'
import { type Held, heldFor } from '@tade/remotes-core'
import type { MachineAnswer, Snapshot } from '@tade/web'
import { describe, expect, it } from 'vitest'
import { aboutOf, detailIn, machineThere } from '../src/machine-there.ts'

// Everything else another machine says about itself and its work, folded for
// the window (`machine-there.ts`): its findings, requests, doors, plans,
// warnings, check runs and documents out of its projection, and what it said
// it is. Read for its shape, moved into this machine's clock, and — the one
// promise held whatever it sends — nothing it wrote reaches this machine's
// terminal as anything but text.

const NOW = Date.UTC(2026, 9, 17, 12, 0)
/** That machine's clock is a minute behind this one's. */
const SKEW = 60_000
const THERE = (ms: number) => new Date(NOW - SKEW - ms).toISOString()

const ESCAPES = '\x1b]0;pwned\x07\x1b[2J\u009b6n‮'

function projection(): Snapshot {
  return {
    v: 1,
    fresh: { at: THERE(0), warnings: [`git said no ${ESCAPES}`, 7] },
    pages: { findings: { total: 5, omitted: 3 } },
    projects: [
      {
        name: 'tade',
        open: true,
        checks: [
          {
            task: null,
            checks: [
              {
                check: 'tests',
                required: true,
                runs: [
                  { at: THERE(120_000), state: 'pass', ms: 1 },
                  { at: THERE(60_000), state: 'fail', ms: 1 },
                ],
                by: 'tade/fix',
                streak: { state: 'fail', since: THERE(60_000), runs: 1, atLeast: false },
              },
              { check: `format${ESCAPES}`, required: false, runs: [], by: null, streak: null },
            ],
          },
        ],
      },
      { name: 'closed', open: false, checks: [{ task: null, checks: [{ check: 'x', runs: [] }] }] },
    ],
    tasks: [
      { id: 'tade/plan', project: 'tade', produces: { name: 'PLAN.md', written: true } },
      { id: 'tade/other', project: 'tade', produces: null },
    ],
    findings: [
      {
        key: 'k1',
        question: 'missing_test',
        project: 'tade',
        tasks: ['tade/fix'],
        at: THERE(0),
        probability: 0.82,
        file: `src/a.ts${ESCAPES}`,
        stillThere: true,
        accounted: true,
        account: {
          did: 'not real',
          said: { words: `a fixture ${ESCAPES}`, more: false },
          at: THERE(0),
        },
        verdict: { was: 'confirmed', at: THERE(0) },
      },
      { key: '', probability: 0.5 },
      { key: 'k2', probability: 'high' },
    ],
    intake: [
      {
        item: 'github:1',
        source: 'github',
        project: 'tade',
        state: 'proposed',
        because: 'waiting for you to approve it',
        title: { words: `Fix it ${ESCAPES}`, more: true },
        who: { words: 'octocat', more: false },
        at: THERE(0),
        tasks: ['tade/one'],
      },
      { item: 'github:2', state: 'teleported' },
    ],
    sources: [
      {
        source: 'github',
        state: 'rate-limited',
        because: 'GitHub said wait',
        lookedAt: THERE(0),
        found: 4,
        fresh: 1,
      },
    ],
    plans: [
      {
        id: 'claude-code/me',
        harness: 'claude-code',
        account: { words: 'me@example.com', more: false },
        pays: 'plan',
        windows: [
          { label: '5h', used: 42, resetsAt: THERE(-3_600_000) },
          { label: 'week', used: 'lots', resetsAt: null },
        ],
        at: THERE(0),
        cannotTell: null,
      },
    ],
  } as unknown as Snapshot
}

const ANSWER: MachineAnswer = {
  at: THERE(0),
  version: `0.2.3${ESCAPES}`,
  newer: null,
  public: { name: 'tade.example.com', up: true, health: [{ said: `late ${ESCAPES}`, loud: true }] },
  problems: [{ from: 'journal', at: THERE(0), said: `a warning ${ESCAPES}` }],
  schedules: [
    {
      id: 'w',
      name: 'New errors',
      project: 'tade',
      kind: 'watch',
      when: 'every hour',
      paused: false,
      next: THERE(-60_000),
      watch: {
        id: 'sentry.new-errors',
        looks: [{ at: THERE(0), found: 1, fresh: 1, left: 0, problem: null, said: null, on: null }],
        found: [{ at: THERE(0), key: 'TADE-1', title: `Boom ${ESCAPES}`, task: null }],
      },
    },
  ],
  documents: [
    {
      task: 'tade/plan',
      project: 'tade',
      name: 'PLAN.md',
      state: 'written',
      at: THERE(0),
      bytes: 9,
      triaged: false,
    },
  ],
}

/** Every code point in anything, however deep, that is not text. */
function notText(value: unknown): number[] {
  const out: number[] = []
  const walk = (one: unknown): void => {
    if (typeof one === 'string') {
      for (const char of one) {
        const point = char.codePointAt(0) ?? 0
        if (!isText(point) && point !== 0x0a) out.push(point)
      }
    } else if (Array.isArray(one)) one.forEach(walk)
    else if (typeof one === 'object' && one !== null) Object.values(one).forEach(walk)
  }
  walk(value)
  return out
}

describe('everything else another machine says', () => {
  const detail = detailIn(projection(), SKEW, {
    answer: ANSWER,
    at: NOW,
    roundTrip: 41,
    said: null,
  })

  it('reads its findings with what its agents said and what somebody decided, and counts what it held back', () => {
    expect(detail.findings).toHaveLength(1)
    expect(detail.findings[0]).toMatchObject({
      key: 'k1',
      question: 'missing_test',
      probability: 0.82,
      at: NOW,
      account: { did: 'not real' },
      verdict: 'confirmed',
    })
    expect(detail.findingsMore).toBe(3)
  })

  it('reads its requests and doors by the states this Tade knows, and nothing it does not', () => {
    expect(detail.requests.map((one) => [one.item, one.state])).toEqual([['github:1', 'proposed']])
    expect(detail.requests[0]?.who).toBe('octocat')
    expect(detail.requests[0]?.title?.endsWith('…')).toBe(true)
    expect(detail.doors).toEqual([
      {
        source: 'github',
        state: 'rate-limited',
        because: 'GitHub said wait',
        lookedAt: NOW,
        found: 4,
        fresh: 1,
      },
    ])
  })

  it('reads its plan windows in this machine’s clock, and leaves out a window it cannot read', () => {
    expect(detail.plans).toEqual([
      {
        id: 'claude-code/me',
        harness: 'claude-code',
        account: 'me@example.com',
        pays: 'plan',
        windows: [{ label: '5h', used: 42, resetsAt: NOW + 3_600_000 }],
        at: NOW,
        cannotTell: null,
      },
    ])
  })

  it('reads every check’s newest answer and streak in each open project there, and what each task produces', () => {
    expect(detail.checks.map((one) => [one.project, one.task, one.check.slice(0, 6)])).toEqual([
      ['tade', null, 'tests'],
      ['tade', null, 'format'],
    ])
    expect(detail.checks[0]).toMatchObject({
      required: true,
      streak: { state: 'fail', since: NOW - 60_000, runs: 1 },
      last: { state: 'fail', at: NOW - 60_000 },
      by: 'tade/fix',
    })
    expect(detail.checks[1]?.last).toBeNull()
    expect(detail.produced).toEqual([
      { task: 'tade/plan', project: 'tade', name: 'PLAN.md', written: true },
    ])
    expect(detail.warnings).toHaveLength(1)
  })

  it('reads what it said it is in this machine’s clock, with the round trip', () => {
    expect(detail.about).toMatchObject({ at: NOW, roundTrip: 41 })
    expect(detail.about?.schedules[0]?.next).toBe(NOW + 60_000)
    expect(detail.about?.documents[0]?.name).toBe('PLAN.md')
    expect(aboutOf(ANSWER, NOW, null, SKEW).problems[0]?.at).toBe(NOW)
  })

  it('reaches this terminal as text, every string of it', () => {
    expect(notText(detail)).toEqual([])
  })

  it('keeps what it last said while its link is down, and says why it has not said what it is', () => {
    const held: Held = {
      ...heldFor('vps'),
      link: { kind: 'down', since: NOW, tries: 2, problem: 'timed out', said: 'nothing answered' },
      projection: projection(),
      heardAt: NOW - 600_000,
    }
    const machine = machineThere(held, SKEW, {
      answer: null,
      at: null,
      roundTrip: null,
      said: `vps runs a Tade that does not say what it is yet ${ESCAPES}`,
    })
    expect(machine.link).toBe('down')
    expect(machine.asOf).toBe(NOW - 600_000)
    expect(machine.detail.findings).toHaveLength(1)
    expect(machine.detail.about).toBeNull()
    expect(machine.detail.aboutSaid?.startsWith('vps runs a Tade')).toBe(true)
    expect(notText(machine.detail)).toEqual([])
  })
})
