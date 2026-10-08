import { describe, expect, it } from 'vitest'
import { checkPlan, type PlannedAgent } from '../src/plan.ts'

// Whether the shape of a plan holds together before any of it is made: cycles
// named rather than deadlocked, a plan that spans repositories made to say
// which agent works where, a done rule a shared checkout cannot keep refused,
// and work it would land on top of warned about rather than refused — because
// what an agent will touch is a reading of the code, and whoever planned it
// may know better.

describe('a plan', () => {
  const agent = (name: string, over: Partial<PlannedAgent> = {}): PlannedAgent => ({
    name,
    said: name,
    prompt: name,
    after: [],
    touches: [],
    ...over,
  })
  const context = { workspace: () => 'checkout' as const, tasks: new Set(['shop/existing']) }

  it('spans repositories: one agent per repo, each waiting on the last by its whole id', () => {
    const check = checkPlan(
      {
        project: 'api',
        said: 'widen the scopes everywhere',
        effort: 'oauth-scopes',
        agents: [
          agent('oauth-scopes', {
            project: 'cli',
            after: [{ agent: 'api/oauth-scopes', why: 'the scopes land first' }],
            touches: ['src/auth.ts'],
          }),
          agent('oauth-scopes', { project: 'api', touches: ['src/auth.ts'] }),
        ],
      },
      context,
    )
    if (!check.ok) throw new Error(check.problems.join('; '))
    // The one in the plan's own project first, because the other waits on it.
    expect(check.order.map((one) => `${one.project}/${one.name}`)).toEqual([
      'api/oauth-scopes',
      'cli/oauth-scopes',
    ])
    expect(check.waitsOn.get('cli/oauth-scopes')).toEqual([
      { task: 'api/oauth-scopes', why: 'the scopes land first' },
    ])
    // Both change `src/auth.ts`, in two different repositories, which is two
    // files. Warning that they collide would be a lie the widening invented.
    expect(check.warnings).toEqual([])
  })

  it('refuses a plan that spans repositories with an agent that says none, naming it', () => {
    // The bug this is here for: two connected halves, one in each repository,
    // written as a plan-level project and a project on one of the two agents.
    // The other half inherits, which is silently the wrong repository — and a
    // task in the wrong project looks exactly like one somebody meant.
    const check = checkPlan(
      {
        project: 'api',
        said: 'move the endpoint and change the page that calls it',
        agents: [
          agent('call-the-new-endpoint', { project: 'web' }),
          agent('move-the-endpoint', {
            after: [{ agent: 'web/call-the-new-endpoint', why: 'the page goes first' }],
          }),
        ],
      },
      context,
    )
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.problems).toEqual([
      'this plan spans api and web, so every agent has to say which project it works in: move-the-endpoint does not, and would be put in api',
    ])
  })

  it('asks which one a bare name means when it could mean two repositories', () => {
    const check = checkPlan(
      {
        project: 'api',
        said: '',
        agents: [
          agent('bump', { project: 'cli' }),
          agent('bump', { project: 'docs' }),
          agent('after', { project: 'api', after: [{ agent: 'bump', why: 'needs it' }] }),
        ],
      },
      context,
    )
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.problems).toEqual([
      'after waits on bump, which is in cli and docs: say which as cli/bump',
    ])
  })

  it('asks each project how its agents work, not the machine', () => {
    const check = checkPlan(
      {
        project: 'api',
        said: '',
        agents: [
          agent('shared', { project: 'api', done: 'merged' }),
          agent('apart', { project: 'cli', done: 'merged' }),
        ],
      },
      // api shares its checkout; cli gives each agent a worktree. One plan,
      // two answers — which is the whole of why this is asked per project.
      { ...context, workspace: (project: string) => (project === 'cli' ? 'worktree' : 'checkout') },
    )
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.problems).toEqual([
      'shared cannot finish when merged: agents in api share one checkout. Use said, idle or manual',
    ])
  })

  it("refuses a document outside the task's own folder, whole rather than half made", () => {
    const check = checkPlan(
      {
        project: 'shop',
        said: 'look at the refund flow and then fix it',
        agents: [agent('audit', { produces: '../audit.md' }), agent('fix')],
      },
      context,
    )
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.problems[0]).toContain('audit cannot produce that:')
    expect(check.problems[0]).toContain("climbs out of the task's folder")
  })

  it('carries what each agent produces through to the tasks it makes', () => {
    const check = checkPlan(
      {
        project: 'shop',
        said: 'look at the refund flow',
        agents: [agent('audit', { produces: 'notes/refund-audit.md' })],
      },
      context,
    )
    if (!check.ok) throw new Error(check.problems.join('; '))
    expect(check.order[0]?.produces).toBe('notes/refund-audit.md')
  })

  it('is made in an order where every agent comes after what it waits on', () => {
    const check = checkPlan(
      {
        project: 'shop',
        said: 'all of it',
        agents: [
          agent('refund-emails', {
            after: [
              { agent: 'add-refunds', why: 'emails what refund() returns' },
              { agent: 'existing', why: 'already under way' },
            ],
          }),
          agent('add-refunds', { after: [{ agent: 'fix-charge', why: 'same file' }] }),
          agent('fix-charge'),
        ],
      },
      context,
    )
    if (!check.ok) throw new Error(check.problems.join('; '))
    expect(check.order.map((one) => one.name)).toEqual([
      'fix-charge',
      'add-refunds',
      'refund-emails',
    ])
    expect(check.waitsOn.get('shop/refund-emails')).toEqual([
      { task: 'shop/add-refunds', why: 'emails what refund() returns' },
      { task: 'shop/existing', why: 'already under way' },
    ])
  })

  it('is refused whole for a wait on nothing, a cycle, or a rule the checkout cannot keep', () => {
    const check = checkPlan(
      {
        project: 'shop',
        said: '',
        agents: [
          agent('a', { after: [{ agent: 'ghost', why: '' }] }),
          agent('b', { done: 'merged' }),
          agent('b'),
        ],
      },
      context,
    )
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.problems).toEqual([
      'b cannot finish when merged: agents in shop share one checkout. Use said, idle or manual',
      'shop/b is in the plan twice',
      'a waits on ghost, which is neither in the plan nor a task Tade has',
    ])
    const cycle = checkPlan(
      {
        project: 'shop',
        said: '',
        agents: [
          agent('x', { after: [{ agent: 'y', why: '' }] }),
          agent('y', { after: [{ agent: 'x', why: '' }] }),
        ],
      },
      context,
    )
    expect(cycle).toEqual({
      ok: false,
      problems: ['shop/x and shop/y wait on each other, so none could start'],
    })
  })

  it('warns about two agents that run at once and change the same things', () => {
    const check = checkPlan(
      {
        project: 'shop',
        said: '',
        agents: [
          agent('fix-charge', { touches: ['src/charge.ts'] }),
          agent('bump-mailer', { touches: ['src/mail/', 'package.json'] }),
          agent('refund-emails', { touches: ['src/mail/refund.ts'] }),
          // Waits on fix-charge, so never at the same time: no warning.
          agent('add-refunds', {
            touches: ['src/charge.ts'],
            after: [{ agent: 'fix-charge', why: '' }],
          }),
        ],
      },
      context,
    )
    expect(check.ok && check.warnings).toEqual([
      'bump-mailer and refund-emails can run at the same time and both change src/mail/, in one checkout',
    ])
  })

  it('warns about work the project already has on the same things, which no plan can see', () => {
    const busy = [{ task: 'shop/fix-charge', said: 'working', touches: ['src/charge.ts'] }]
    const check = checkPlan(
      {
        project: 'shop',
        said: '',
        agents: [
          agent('add-refunds', { touches: ['src/charge.ts', 'src/refunds.ts'] }),
          // Told to wait for both of them, so it is never at the same time as either.
          agent('later', {
            touches: ['src/charge.ts'],
            after: [
              { agent: 'shop/fix-charge', why: 'it changes charge first' },
              { agent: 'add-refunds', why: 'so does it' },
            ],
          }),
          agent('elsewhere', { touches: ['docs/'] }),
        ],
      },
      { ...context, tasks: new Set(['shop/fix-charge']), busy },
    )
    expect(check.ok && check.warnings).toEqual([
      'add-refunds and shop/fix-charge, which is working, both change src/charge.ts, in one checkout',
    ])
    const worktrees = checkPlan(
      { project: 'shop', said: '', agents: [agent('add-refunds', { touches: ['src/charge.ts'] })] },
      { workspace: () => 'worktree', tasks: new Set(['shop/fix-charge']), busy },
    )
    expect(worktrees.ok && worktrees.warnings).toEqual([
      'add-refunds and shop/fix-charge, which is working, both change src/charge.ts: merging both may conflict',
    ])
  })
})
