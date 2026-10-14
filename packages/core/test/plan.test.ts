import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkPlan, type Plan, type PlannedAgent, wholePackage } from '../src/plan.ts'

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

  it("refuses a document outside the task's documents folder, whole rather than half made", () => {
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
    expect(check.problems[0]).toContain("climbs out of the task's documents folder")
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
      // A folder said whole is said once, as a folder, and as whose.
      'bump-mailer and refund-emails can run at the same time and both change src/mail/ (bump-mailer said it touches all of it), in one checkout',
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

  it('follows the waits of work already there, so a chain of queued work is never a collision', () => {
    // Running now, then two queued after it: the planned agent waits on the
    // last, so it can never be running at the same time as any of the three.
    const busy = [
      { task: 'shop/first', said: 'working', touches: ['src/charge.ts'] },
      { task: 'shop/second', said: 'queued', touches: ['src/charge.ts'], after: ['shop/first'] },
      // Touches nothing, and is still the link the chain goes through.
      { task: 'shop/link', said: 'queued', touches: [], after: ['shop/second'] },
    ]
    const tasks = new Set(busy.map((one) => one.task))
    const plan = (after: string[]) => ({
      project: 'shop',
      said: '',
      agents: [
        agent('after-all', {
          touches: ['src/charge.ts'],
          after: after.map((one) => ({ agent: one, why: '' })),
        }),
      ],
    })
    const chained = checkPlan(plan(['shop/link']), { ...context, tasks, busy })
    expect(chained.ok && chained.warnings).toEqual([])
    // Waiting only on the middle one still leaves nothing to run beside.
    const middle = checkPlan(plan(['shop/second']), { ...context, tasks, busy })
    expect(middle.ok && middle.warnings).toEqual([])
    const none = checkPlan(plan([]), { ...context, tasks, busy })
    expect(none.ok && none.warnings).toEqual([
      'after-all and shop/first, which is working, both change src/charge.ts, in one checkout',
      'after-all and shop/second, which is queued, both change src/charge.ts, in one checkout',
    ])
  })

  it('says one line for each task run into, then how many more agents run into it and which', () => {
    const busy = [{ task: 'shop/fix-charge', said: 'working', touches: ['src/charge.ts'] }]
    const check = checkPlan(
      {
        project: 'shop',
        said: '',
        agents: [
          agent('one', { touches: ['src/charge.ts'] }),
          agent('two', { touches: ['src/charge.ts'], after: [{ agent: 'one', why: '' }] }),
          agent('three', { touches: ['src/charge.ts'], after: [{ agent: 'two', why: '' }] }),
          agent('four', { touches: ['src/charge.ts'], after: [{ agent: 'three', why: '' }] }),
          agent('apart', { touches: ['src/refund.ts'] }),
          agent('beside', { touches: ['src/refund.ts'] }),
        ],
      },
      { ...context, tasks: new Set(['shop/fix-charge']), busy },
    )
    expect(check.ok && check.warnings).toEqual([
      "one and shop/fix-charge, which is working, both change src/charge.ts, in one checkout; 3 more of this plan's agents run into shop/fix-charge too: two, three and four",
      'apart and beside can run at the same time and both change src/refund.ts, in one checkout',
    ])
  })

  it('says a folder is a folder once, rather than every file of the other agent it swallows', () => {
    const busy = [{ task: 'shop/redo-ui', said: 'waiting on you', touches: ['packages/app'] }]
    const check = checkPlan(
      {
        project: 'shop',
        said: '',
        agents: [
          agent('buttons', {
            touches: ['packages/app/src/button.ts', 'packages/app/src/view/menu.ts', 'README.md'],
          }),
        ],
      },
      { ...context, tasks: new Set(['shop/redo-ui']), busy },
    )
    expect(check.ok && check.warnings).toEqual([
      'buttons and shop/redo-ui, which is waiting on you, both change packages/app (shop/redo-ui said it touches all of it), in one checkout',
    ])
  })

  it('warns about an agent that says it touches a whole package', () => {
    const packages = ['', 'packages/app', 'packages/drivers/pty']
    for (const path of [
      '.',
      './',
      'src',
      'packages/app',
      'packages/app/',
      'packages/app/src',
      'packages/drivers/pty/lib',
      // Not a package: every package there is, which is worse.
      'packages',
      'packages/drivers',
    ]) {
      expect([path, wholePackage(path, packages)]).toEqual([path, true])
    }
    // A folder inside a package, a package's file, and a folder that only
    // looks like one: `src/mail` is the mail code in a repository of one package.
    for (const path of ['packages/app/src/view', 'packages/app/package.json', 'src/mail']) {
      expect([path, wholePackage(path, packages)]).toEqual([path, false])
    }
    // With nothing found but the repository, only the repository is whole.
    expect(wholePackage('packages/app', [])).toBe(false)
    expect(wholePackage('.', [])).toBe(true)

    const plan = {
      project: 'shop',
      said: '',
      agents: [
        agent('everything', { touches: ['packages/app/src', 'packages/drivers/pty'] }),
        agent('precise', {
          touches: ['packages/app/src/view/menu.ts'],
          after: [{ agent: 'everything', why: '' }],
        }),
      ],
    }
    const shared = checkPlan(plan, { ...context, packages: () => packages })
    expect(shared.ok && shared.warnings).toEqual([
      'everything says it touches all of packages/app/src and packages/drivers/pty, whole packages: anything uncommitted in them holds its start, and every agent in them collides with it. Name the files it will change instead',
    ])
    const apart = checkPlan(plan, {
      ...context,
      workspace: () => 'worktree',
      packages: () => packages,
    })
    expect(apart.ok && apart.warnings).toEqual([
      'everything says it touches all of packages/app/src and packages/drivers/pty, whole packages: every agent in them collides with it. Name the files it will change instead',
    ])
  })
})

describe('a placeholder left in the prompts', () => {
  // The plan the orchestrator sent at 06:53 PDT on 2026-10-13, as it sent it
  // but for a home directory written as ~. Thirteen of its prompts end in
  // `PAGE_BRIEF`, a brief it meant to paste once and never did, and it was
  // made: eighteen tasks, then seventeen removals six seconds later.
  const sent = JSON.parse(
    readFileSync(join(import.meta.dirname, '../../../test/fixtures/plans/page-brief.json'), 'utf8'),
  ) as Omit<Plan, 'agents'> & { agents: Partial<PlannedAgent>[] }
  const pageBrief: Plan = {
    ...sent,
    // What `tade_plan` leaves out, the window reads as none.
    agents: sent.agents.map((one) => ({ after: [], touches: [], ...one }) as PlannedAgent),
  }
  const context = {
    workspace: () => 'checkout' as const,
    tasks: new Set(['tade-web/site-terminal-ground']),
  }
  const pages = [
    'away-page-overview',
    'away-page-project',
    'away-page-agent',
    'away-page-inbox',
    'away-page-runs',
    'away-page-workflows',
    'away-page-findings',
    'away-page-reviews',
    'away-page-checks',
    'away-page-spend',
    'away-page-notes',
    'away-page-devices',
    'away-page-settings',
  ]

  it('refuses the plan of 2026-10-13, naming the token and all thirteen agents', () => {
    const check = checkPlan(pageBrief, context)
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.problems).toEqual([
      `PAGE_BRIEF is in the prompts of ${pages.slice(0, -1).join(', ')} and away-page-settings and nowhere in what was said, so it stands for text that was never written in: say that text once, in the plan's context, which every agent is given, or in each prompt (a name from the code goes in backticks)`,
    ])
  })

  it('makes it once the brief is said once, in the plan’s context', () => {
    const brief = 'Every page: its own files only, the design doc first, the browser harness green.'
    const without = {
      ...pageBrief,
      context: brief,
      agents: pageBrief.agents.map((one) => ({
        ...one,
        prompt: one.prompt.replace(' PAGE_BRIEF', ''),
      })),
    }
    expect(checkPlan(without, context).ok).toBe(true)
    // A name the context spells out is not a blank: each agent has the text.
    expect(checkPlan({ ...pageBrief, context: `PAGE_BRIEF: ${brief}` }, context).ok).toBe(true)
  })

  /** What two agents both told `prompt` are refused over, with `over` on the plan. */
  const refused = (prompt: string, over: Partial<Plan> = {}): string[] => {
    const told = (name: string): PlannedAgent => ({
      name,
      said: name,
      prompt,
      after: [],
      touches: [],
    })
    const check = checkPlan(
      { project: 'shop', said: '', agents: [told('one'), told('two')], ...over },
      { workspace: () => 'worktree', tasks: new Set() },
    )
    return check.ok ? [] : check.problems.map((problem) => problem.split(' is in ')[0] ?? '')
  }

  it('knows a placeholder by its shape', () => {
    for (const [prompt, token] of [
      ['Then SHARED_BRIEF', 'SHARED_BRIEF'],
      ['Then {{brief}}', '{{brief}}'],
      ['Then <Brief>', '<Brief>'],
      ['Then <Insert the brief here>.', '<Insert the brief here>'],
      ['TODO: say what', 'TODO'],
      ['Done when TBD.', 'TBD'],
      ['FIXME', 'FIXME'],
      ['Ship it by XXX', 'XXX'],
    ]) {
      expect([prompt, refused(prompt as string)]).toEqual([prompt, [token]])
    }
    // Every token is said once, in a plan that left several.
    expect(refused('Do TODO, then PAGE_BRIEF and PAGE_BRIEF again')).toEqual(['TODO', 'PAGE_BRIEF'])
  })

  it('leaves alone what is not one: a word, a type, a name in backticks', () => {
    for (const prompt of [
      'Make the page BRIEF and the PAGE clear',
      'It returns Promise<Plan> and Array<String>',
      'Fill in the <brief> and the {single} braces',
      'Raise `LOOK_SOON_MS` and keep `PAGE_BRIEF` as it is named',
      'Change ```\nconst TODO_LIST = []\n``` and nothing else',
      'there is nothing todo or tbd here',
    ]) {
      expect([prompt, refused(prompt)]).toEqual([prompt, []])
    }
  })

  it('leaves alone a token only one prompt has, or that somebody said', () => {
    const check = checkPlan(
      {
        project: 'shop',
        said: '',
        agents: [
          { name: 'one', said: '', prompt: 'Lower LOOK_SOON_MS', after: [], touches: [] },
          { name: 'two', said: '', prompt: 'Leave it', after: [], touches: [] },
        ],
      },
      { workspace: () => 'worktree', tasks: new Set() },
    )
    expect(check.ok).toBe(true)
    expect(refused('Rename PAGE_BRIEF', { said: 'rename PAGE_BRIEF in both' })).toEqual([])
  })
})
