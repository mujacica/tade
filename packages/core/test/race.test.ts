import { describe, expect, it } from 'vitest'
import type { TadeEvent } from '../src/events.ts'
import { type Persona, parsePersona } from '../src/personas.ts'
import { checkPlan } from '../src/plan.ts'
import {
  pickNamedBy,
  RACE_MOST,
  type RaceFinding,
  type RacerFacts,
  raceOrder,
  racePlan,
  racerSays,
  raceSpentSays,
  raceStandingSays,
  racesIn,
  strayedIn,
  wonFrom,
} from '../src/race.ts'
import { fillTemplate, templateProblems } from '../src/templates.ts'
import { BUILT_IN_PERSONAS, BUILT_IN_TEMPLATES } from '../src/templates-builtin.ts'
import { parseTemplate } from '../src/templates-store.ts'

// A race is a plan of entrants told the same words, the fold of the task files
// that name it, an order the facts put them in — and nothing here picks.

const request = (over: Partial<Parameters<typeof racePlan>[0]> = {}) => ({
  project: 'shop',
  name: 'dark',
  said: 'add a dark mode',
  prompt: 'Add a dark mode. Run the checks and commit.',
  entrants: [{ harness: 'claude-code', model: 'sonnet' }, { harness: 'codex' }],
  ...over,
})

const racer = (task: string, over: Partial<RacerFacts> = {}): RacerFacts => ({
  task: `shop/${task}`,
  race: 'dark',
  project: 'shop',
  said: 'add a dark mode',
  harness: 'pi',
  model: null,
  created: '2026-10-16T10:00:00.000Z',
  state: 'review',
  finished: true,
  checks: 'pass',
  failed: [],
  findings: { open: 0, answered: 0, confirmed: 0, dismissed: 0 },
  strayed: false,
  size: { commits: 1, added: 10, removed: 2 },
  usd: 0.5,
  ...over,
})

const event = (type: string, detail: Record<string, unknown>, over: Partial<TadeEvent> = {}) =>
  ({
    seq: 1,
    ts: '2026-10-16T11:00:00.000Z',
    type,
    task: null,
    lane: null,
    urgency: 'notable',
    detail,
    ...over,
  }) as TadeEvent

describe('starting a race', () => {
  it('is a plan of entrants told the same words, each on the entrant at its place', () => {
    const made = racePlan(request({ n: 3 }))
    expect(made.ok).toBe(true)
    if (!made.ok) return
    expect(made.plan.race).toBe('dark')
    expect(made.plan.agents.map((one) => one.name)).toEqual(['dark-1', 'dark-2', 'dark-3'])
    // Fewer entrants than places go round again.
    expect(made.plan.agents.map((one) => one.harness)).toEqual([
      'claude-code',
      'codex',
      'claude-code',
    ])
    expect(made.plan.agents[0]?.model).toBe('sonnet')
    expect(made.plan.agents[1]?.model).toBeUndefined()
    expect(new Set(made.plan.agents.map((one) => one.prompt)).size).toBe(1)
    expect(made.plan.agents.every((one) => one.after.length === 0)).toBe(true)
    // And the engine keeps it — in a project whose agents share one checkout too,
    // because every entrant gets a worktree of its own.
    expect(checkPlan(made.plan, { workspace: () => 'checkout', tasks: new Set() }).ok).toBe(true)
  })

  it('is as many entrants as were named, or two, when nobody says how many', () => {
    const two = racePlan(request({ entrants: [] }))
    expect(two.ok && two.plan.agents.length).toBe(2)
    expect(two.ok && two.plan.agents.every((one) => one.harness === undefined)).toBe(true)
  })

  it('refuses a race of one, one past the most, and more entrants than places', () => {
    const one = racePlan(request({ n: 1 }))
    expect(one.ok ? '' : one.problems.join()).toMatch(/2 to 4 entrants, and 1 was asked for/)
    const many = racePlan(request({ n: RACE_MOST + 1 }))
    expect(many.ok).toBe(false)
    const crowded = racePlan(request({ n: 2, entrants: [{}, {}, {}] }))
    expect(crowded.ok ? '' : crowded.problems.join()).toMatch(
      /3 entrants were named for a race of 2/,
    )
    const silent = racePlan(request({ prompt: ' ' }))
    expect(silent.ok ? '' : silent.problems.join()).toMatch(/what every entrant is told/)
  })

  it('is refused by the plan engine where the entrants are not asked the same thing', () => {
    const made = racePlan(request())
    if (!made.ok) throw new Error('made')
    const [first, second] = made.plan.agents
    if (!first || !second) throw new Error('two')
    const mixed = {
      ...made.plan,
      agents: [first, { ...second, prompt: 'Something else.', after: [{ agent: 'x', why: 'y' }] }],
    }
    const checked = checkPlan(mixed, { workspace: () => 'worktree', tasks: new Set(['shop/x']) })
    expect(checked.ok).toBe(false)
    if (checked.ok) return
    expect(checked.problems.join('\n')).toMatch(/the same thing in the same words/)
    expect(checked.problems.join('\n')).toMatch(/run side by side, and dark-2 would wait/)
  })
})

describe('the order the facts put a race in', () => {
  it('reads checks, then straying, then findings, then finished, then size — and nothing else', () => {
    const order = raceOrder([
      racer('small-red', { checks: 'fail', size: { commits: 1, added: 1, removed: 0 } }),
      racer('strayed', { strayed: true }),
      racer('big', { size: { commits: 3, added: 400, removed: 20 } }),
      racer('open', { findings: { open: 2, answered: 0, confirmed: 0, dismissed: 0 } }),
      racer('working', { finished: false, state: 'working' }),
      racer('small'),
    ])
    expect(order.map((one) => one.task)).toEqual([
      'shop/small',
      'shop/big',
      'shop/working',
      'shop/open',
      'shop/strayed',
      'shop/small-red',
    ])
  })

  it('puts what nobody could say after what somebody could, never as nought', () => {
    const order = raceOrder([
      racer('unread', { findings: null, strayed: null }),
      racer('read'),
      racer('unlooked', { checks: null }),
    ])
    expect(order.map((one) => one.task)).toEqual(['shop/read', 'shop/unread', 'shop/unlooked'])
  })
})

describe('a race, folded', () => {
  it('groups entrants by project and name, places them, and adds up what they cost', () => {
    const races = racesIn([
      racer('dark-1', { usd: 1.25, checks: 'fail' }),
      racer('dark-2', { usd: null }),
      racer('blue-1', { race: 'blue', usd: null, created: '2026-10-16T12:30:00.000Z' }),
      racer('blue-2', { race: 'blue', usd: null, created: '2026-10-16T12:00:00.000Z' }),
    ])
    expect(races.map((one) => one.name)).toEqual(['blue', 'dark'])
    const dark = races.find((one) => one.name === 'dark')
    expect(dark?.racers.map((one) => [one.facts.task, one.place])).toEqual([
      ['shop/dark-2', 1],
      ['shop/dark-1', 2],
    ])
    // One entrant recorded no money: the sum is a floor, said as one.
    expect(dark?.usd).toEqual({ sum: 1.25, atLeast: true })
    expect(raceSpentSays(dark ?? { usd: { sum: null, atLeast: false } })).toBe('≥ $1.25 so far')
    const blue = races.find((one) => one.name === 'blue')
    expect(blue?.usd.sum).toBeNull()
    expect(raceSpentSays(blue ?? { usd: { sum: 0, atLeast: false } })).toBe('no money recorded')
    // It began with its first entrant, and the newest race comes first.
    expect(blue?.began).toBe('2026-10-16T12:00:00.000Z')
  })

  it('marks what was picked, and the rest closed with their branches kept, decided races last', () => {
    const won = wonFrom([
      event(
        'race_won',
        { race: 'dark', project: 'shop', by: 'you', why: 'smaller', closed: ['shop/dark-1'] },
        { task: 'shop/dark-2' },
      ),
      // A second decision is not one: a race is decided once.
      event('race_won', { race: 'dark', project: 'shop', task: 'shop/dark-1', why: 'no' }),
    ])
    expect(won.get('shop/dark')?.task).toBe('shop/dark-2')
    const races = racesIn(
      [racer('dark-1'), racer('dark-2'), racer('blue-1', { race: 'blue' })],
      won,
    )
    expect(races.map((one) => one.name)).toEqual(['blue', 'dark'])
    const dark = races[1]
    expect(dark?.racers.map((one) => [one.facts.task, one.won, one.closed])).toEqual([
      ['shop/dark-1', false, true],
      ['shop/dark-2', true, false],
    ])
    const said = raceStandingSays(dark ?? races[0]!).join('\n')
    expect(said).toMatch(/Picked shop\/dark-2 \(by them\): smaller/)
    expect(said).toMatch(/shop\/dark-1 .* — closed, branch kept/)
  })

  it('says nobody has picked, and what the order is made of, until somebody has', () => {
    const [race] = racesIn([
      racer('dark-1', { harness: 'claude-code', model: 'sonnet' }),
      racer('dark-2'),
    ])
    const said = raceStandingSays(race!).join('\n')
    expect(said).toMatch(/Race dark in shop: 2 entrants, 2 finished, \$1\.00 so far\./)
    expect(said).toMatch(/Asked: add a dark mode/)
    expect(said).toMatch(
      /1\. shop\/dark-1 \(claude-code · sonnet, \$0\.50\): finished · checks green/,
    )
    expect(said).toMatch(/Nobody has picked\. The order is the facts’, not a pick/)
  })
})

describe('what the judge adds', () => {
  const finding = (over: Partial<RaceFinding> = {}): RaceFinding => ({
    question: 'did_what_was_asked',
    tasks: ['shop/dark-1'],
    stillThere: true,
    account: null,
    verdict: null,
    ...over,
  })

  it('says a change strayed only where that question still stands, and null where nobody reads', () => {
    expect(strayedIn(null, 'shop/dark-1')).toBeNull()
    expect(strayedIn([], 'shop/dark-1')).toBe(false)
    expect(strayedIn([finding()], 'shop/dark-1')).toBe(true)
    expect(strayedIn([finding()], 'shop/dark-2')).toBe(false)
    expect(strayedIn([finding({ question: 'test_missing' })], 'shop/dark-1')).toBe(false)
    expect(strayedIn([finding({ stillThere: false })], 'shop/dark-1')).toBe(false)
    expect(strayedIn([finding({ verdict: { was: 'false positive' } })], 'shop/dark-1')).toBe(false)
  })

  it('is said as what it is: raised, not raised, or nobody reading', () => {
    expect(racerSays(racer('a', { strayed: null, findings: null }))).toEqual([
      'finished',
      'checks green',
      'no judge reads it',
      'findings not read',
      '+10 −2',
    ])
    expect(
      racerSays(
        racer('b', {
          finished: false,
          state: 'working',
          checks: 'fail',
          failed: ['tests'],
          strayed: true,
          size: null,
        }),
      ),
    ).toEqual([
      'working',
      'checks red (tests)',
      'the judge says it did something other than what was asked',
      'no findings open',
      'nothing looked at its commits yet',
    ])
  })
})

describe('who may pick', () => {
  it('is a line of theirs asking for a pick, and nothing else', () => {
    expect(pickNamedBy(['pick the best one for me'])).toBe('pick the best one for me')
    expect(pickNamedBy(['you choose'])).toBe('you choose')
    expect(pickNamedBy(['go with the codex one'])).toBe('go with the codex one')
    expect(pickNamedBy(['apply the winner'])).toBe('apply the winner')
    expect(pickNamedBy(['how is the race going?', 'show me the picker'])).toBeNull()
  })
})

describe('the race template Tade ships', () => {
  const personas = (): Map<string, Persona> => {
    const out = new Map<string, Persona>()
    for (const [name, text] of Object.entries(BUILT_IN_PERSONAS)) {
      const read = parsePersona(name, text)
      if (read.ok) out.set(name, read.persona)
    }
    return out
  }

  it('makes a race the engine keeps, in worktrees even where the project shares a checkout', () => {
    const read = parseTemplate('race', BUILT_IN_TEMPLATES.race ?? '')
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.template.race).toBe(true)
    const fill = fillTemplate(read.template, {
      inputs: { project: 'shop', subject: 'dark', request: 'add a dark mode' },
      projects: ['shop'],
      workspace: () => 'checkout',
      home: '/home/tade',
      provenance: { template: 'race', version: 1, hash: null, builtIn: true },
      personas: personas(),
    })
    expect(fill.ok).toBe(true)
    if (!fill.ok) return
    expect(fill.plan.race).toBe('race-dark')
    expect(fill.plan.agents.map((one) => one.name)).toEqual(['one-dark', 'two-dark', 'three-dark'])
    // The implementer's worktree answer, because that is where an entrant works.
    expect(fill.plan.agents.every((one) => one.done === 'committed')).toBe(true)
    expect(checkPlan(fill.plan, { workspace: () => 'checkout', tasks: new Set() }).ok).toBe(true)
  })

  it('refuses a race template with no suffix, a wait, or entrants told different things', () => {
    const read = parseTemplate('race', BUILT_IN_TEMPLATES.race ?? '')
    if (!read.ok) throw new Error('race')
    const [one, two, three] = read.template.agents
    if (!one || !two || !three) throw new Error('three')
    const { name_suffix: _gone, ...unsuffixed } = read.template
    const problems = templateProblems(
      {
        ...unsuffixed,
        agents: [
          one,
          { ...two, after: [{ agent: 'one', why: 'after' }] },
          { ...three, prompt: 'x' },
        ],
      },
      { personas: personas() },
    ).problems.join('\n')
    expect(problems).toMatch(/needs a name_suffix/)
    expect(problems).toMatch(/run side by side, and two would wait on or read another/)
    expect(problems).toMatch(/give every step the same prompt/)
  })
})
