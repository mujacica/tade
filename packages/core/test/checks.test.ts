import { describe, expect, it } from 'vitest'
import {
  ConfigSchema,
  checksFor,
  checksTold,
  OVERRIDE_LIMIT_MS,
  overrideFor,
  overrideProblem,
  overridesFrom,
  runsBefore,
  type TadeEvent,
} from '../src/index.ts'

const NOW = Date.parse('2026-09-19T09:00:00Z')

const event = (over: Partial<TadeEvent> & { ts: string }): TadeEvent => ({
  seq: 0,
  type: 'tool_call',
  urgency: 'routine',
  task: null,
  lane: null,
  run: null,
  detail: {},
  ...over,
})

describe('when a project\u2019s checks run', () => {
  it('is the global rule, with the project\u2019s own answer over it', () => {
    const config = ConfigSchema.parse({
      checks: { before: 'push', on_red: 'hold' },
      projects: {
        shop: { root: '/src/shop', checks: { before: 'off' } },
        api: { root: '/src/api' },
      },
    })
    expect(checksFor(config, 'shop').before).toBe('off')
    expect(checksFor(config, 'shop').on_red).toBe('hold')
    expect(checksFor(config, 'api').before).toBe('push')
    expect(checksFor(config, null).before).toBe('push')
  })

  it('runs before a push unless told otherwise', () => {
    const config = ConfigSchema.parse({})
    expect(runsBefore(checksFor(config, null), 'push')).toBe(true)
    expect(runsBefore(checksFor(config, null), 'commit')).toBe(false)
    expect(runsBefore({ ...checksFor(config, null), before: 'commit and push' }, 'commit')).toBe(
      true,
    )
    expect(runsBefore({ ...checksFor(config, null), before: 'off' }, 'push')).toBe(false)
  })
})

describe('overruling the rule', () => {
  const base = {
    by: 'agent' as const,
    askedFor: 'shop/refunds',
    scope: 'this task',
    task: 'shop/refunds',
    reason: 'the flaky PTY one',
  }

  it('needs a reason', () => {
    expect(overrideProblem({ ...base, reason: '  ' })).toMatch(/say why/)
    expect(overrideProblem(base)).toBeNull()
  })

  it('lets an agent overrule only its own work', () => {
    expect(overrideProblem({ ...base, scope: 'this project' })).toMatch(/its own task/)
    expect(overrideProblem({ ...base, askedFor: 'shop/other' })).toMatch(/shop\/other/)
    expect(overrideProblem({ ...base, by: 'orchestrator', scope: 'this project' })).toBeNull()
  })

  it('never lasts longer than four hours', () => {
    expect(overrideProblem({ ...base, forMs: OVERRIDE_LIMIT_MS + 1 })).toMatch(/four hours/)
    expect(overrideProblem({ ...base, forMs: OVERRIDE_LIMIT_MS })).toBeNull()
  })

  it('is read back out of the journal, not remembered', () => {
    const events = [
      event({
        ts: '2026-09-19T08:00:00Z',
        task: 'shop/refunds',
        detail: {
          tool: 'checks_override',
          caller: 'agent',
          input: { scope: 'this task', reason: 'flaky PTY timeout', hours: 1 },
        },
      }),
    ]
    const [override] = overridesFrom(events)
    expect(override).toMatchObject({
      task: 'shop/refunds',
      scope: 'this task',
      reason: 'flaky PTY timeout',
    })
    expect(overrideFor(events, { task: 'shop/refunds', project: 'shop', now: NOW })).not.toBeNull()
    // It ran out an hour ago.
    expect(
      overrideFor(events, { task: 'shop/refunds', project: 'shop', now: NOW + 3_600_000 }),
    ).toBeNull()
    // And it was never anybody else's.
    expect(overrideFor(events, { task: 'shop/other', project: 'shop', now: NOW })).toBeNull()
  })

  it('spends a "next push" on the first push after it', () => {
    const written = event({
      ts: '2026-09-19T08:00:00Z',
      task: 'shop/refunds',
      detail: { tool: 'checks_override', scope: 'next push', reason: 'CI is down', by: 'you' },
    })
    const at = { task: 'shop/refunds', project: 'shop', now: NOW }
    expect(overrideFor([written], at)).not.toBeNull()
    const pushed = event({
      ts: '2026-09-19T08:30:00Z',
      task: 'shop/refunds',
      detail: { tool: 'bash', command: 'git push origin HEAD' },
    })
    expect(overrideFor([written, pushed], at)).toBeNull()
  })

  it('takes the last one written, whatever came before it', () => {
    const first = event({
      ts: '2026-09-19T07:00:00Z',
      detail: {
        tool: 'checks_override',
        scope: 'this project',
        project: 'shop',
        reason: 'a',
        by: 'you',
      },
    })
    const second = event({
      ts: '2026-09-19T08:00:00Z',
      detail: {
        tool: 'checks_override',
        scope: 'this project',
        project: 'shop',
        reason: 'b',
        by: 'you',
      },
    })
    expect(overrideFor([first, second], { task: null, project: 'shop', now: NOW })?.reason).toBe(
      'b',
    )
  })
})

describe('what an agent is told about them', () => {
  const rule = ConfigSchema.parse({}).checks

  it('says the rule, the one command, and what a red check means', () => {
    const told = checksTold(rule, ['format', 'types', 'tests'], true)
    expect(told).toContain('`format`, `types`, `tests`')
    expect(told).toContain('checks_run before you push')
    expect(told).toContain('something to fix')
    expect(told).toContain('checks_override')
  })

  it('says nothing at all when a project has no checks', () => {
    expect(checksTold(rule, [], true)).toBeNull()
    expect(checksTold(null, ['tests'], true)).toBeNull()
  })
})
