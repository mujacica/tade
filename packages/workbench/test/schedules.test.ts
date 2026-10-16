import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Schedule, startFrom, taskDir, watchedFrom } from '@tade/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { foldSchedules, readEverMade, readSchedules } from '../src/schedules.ts'
import { beginFrom, readTaskFile } from '../src/tasks.ts'
import { Workbench } from '../src/workbench.ts'

const deps = (over: Partial<Schedule> = {}): Schedule => ({
  id: 'deps-weekly',
  name: 'deps weekly',
  project: 'app',
  said: 'every monday morning update our dependencies',
  when: { every: 'week', on: ['mon'], times: ['09:00'] },
  does: { kind: 'agent', prompt: 'Update dependencies within their major versions.' },
  missed: 'once',
  by: 'orchestrator',
  created: '2026-09-15T08:00:00.000Z',
  ...over,
})

describe('schedules', () => {
  let repo: ReturnType<typeof mkrepo>
  let home: string
  let client: Workbench

  beforeEach(async () => {
    repo = mkrepo()
    home = tmp('tade-schedules-')
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    client = await Workbench.open({ home, version: '9.9.9' })
  })

  afterEach(async () => {
    await client.close().catch(() => {})
  })

  it('remembers every id it has ever held, so a removal outlives the schedule', async () => {
    expect(readEverMade(home).has('deps-weekly')).toBe(false)
    await client.setSchedule(deps(), 'orchestrator')
    expect(readEverMade(home).has('deps-weekly')).toBe(true)
    await client.changeSchedule({ id: 'deps-weekly', change: 'remove', by: 'you' })
    expect(client.schedules()).toEqual([])
    // Gone, and still decided about: this is what stops a watch that is on by
    // default being written again over somebody taking it away.
    expect(readEverMade(home).has('deps-weekly')).toBe(true)
    expect(readEverMade(home).has('never-made')).toBe(false)
    expect(readEverMade(tmp('tade-nothing-')).size).toBe(0)
  })

  it('keeps every change as a line of its own, with who made it', async () => {
    await client.setSchedule(deps(), 'orchestrator')
    await client.changeSchedule({ id: 'deps-weekly', change: 'rename', name: 'Mondays', by: 'you' })
    await client.changeSchedule({ id: 'deps-weekly', change: 'pause', by: 'you' })
    expect(client.schedules()).toMatchObject([{ id: 'deps-weekly', name: 'Mondays', paused: true }])

    // A change to what it does keeps it paused and keeps its new name: both were somebody's choice.
    await client.setSchedule(deps({ does: { kind: 'ask', prompt: 'Anything to update?' } }), 'you')
    expect(client.schedules()[0]).toMatchObject({
      name: 'Mondays',
      paused: true,
      does: { kind: 'ask' },
    })

    const lines = readFileSync(join(home, 'schedules.jsonl'), 'utf8').trim().split('\n')
    expect(lines.map((line) => JSON.parse(line).op)).toEqual(['set', 'rename', 'pause', 'set'])
    expect(lines.map((line) => JSON.parse(line).by)).toEqual(['orchestrator', 'you', 'you', 'you'])
    expect(statSync(join(home, 'schedules.jsonl')).mode & 0o777).toBe(0o600)
    // Read without the window, for anything that only asks.
    expect(readSchedules(home).map((one) => one.name)).toEqual(['Mondays'])

    await client.changeSchedule({ id: 'deps-weekly', change: 'remove', by: 'you' })
    expect(client.schedules()).toEqual([])
    const changes = await client.events({ types: ['schedule_changed'] })
    expect(changes.map((event) => event.detail.change)).toEqual([
      'set',
      'rename',
      'pause',
      'set',
      'remove',
    ])
  })

  it('skips a line it cannot read rather than losing the rest', () => {
    const good = JSON.stringify({
      op: 'set',
      schedule: deps(),
      by: 'you',
      at: '2026-09-15T08:00:00Z',
    })
    expect(foldSchedules(`${good}\n{"op":"set","schedule":{}\nnot json\n`)).toHaveLength(1)
  })

  it('refuses a rule it could not keep, and a project it does not know', async () => {
    await expect(client.setSchedule(deps({ when: { every: 'fortnight' } }), 'you')).rejects.toThrow(
      /is neither a length/,
    )
    await expect(client.setSchedule(deps({ project: 'nope' }), 'you')).rejects.toThrow(
      /unknown project/,
    )
    await expect(
      client.changeSchedule({ id: 'ghost', change: 'pause', by: 'you' }),
    ).rejects.toThrow(/no schedule called ghost/)
  })

  it('makes queued work each time it runs, named for it and the day, never the same name twice', async () => {
    await client.setSchedule(deps(), 'orchestrator')
    const now = Date.parse('2026-09-21T09:00:30Z')
    const first = await client.fireSchedule(
      'deps-weekly',
      { run: true, due: now - 30_000, missed: 0 },
      now,
    )
    const second = await client.fireSchedule('deps-weekly', { run: true, due: now, missed: 0 }, now)
    expect([first.task, second.task]).toEqual(['app/deps-weekly-0921', 'app/deps-weekly-0921-2'])
    const file = readFileSync(join(taskDir(home, 'app/deps-weekly-0921'), 'task.yaml'), 'utf8')
    expect(file).toContain('by: schedule:deps-weekly')
    expect(file).toContain('prompt: Update dependencies within their major versions.')
    const fired = await client.events({ types: ['schedule_fired'] })
    expect(fired[0]).toMatchObject({
      task: 'app/deps-weekly-0921',
      detail: { schedule: 'deps-weekly', ran: true, missed: 0 },
    })

    // Missed while closed and told to skip: written down, and nothing made.
    const skipped = await client.fireSchedule(
      'deps-weekly',
      { run: false, due: now, missed: 3 },
      now,
    )
    expect(skipped.task).toBeNull()
    expect((await client.events({ types: ['schedule_fired'] })).at(-1)?.detail).toMatchObject({
      ran: false,
      missed: 3,
    })
  })

  it('writes down what a watch finds, once each, and makes queued work named for what it is about', async () => {
    await client.setSchedule(
      deps({
        id: 'new-errors',
        name: 'New Sentry errors',
        when: { every: '1h' },
        does: { kind: 'watch', watch: 'sentry.new-errors', input: {}, found: 'agent', most: 2 },
      }),
      'you',
    )
    await client.watchChecked('new-errors', {
      found: 3,
      fresh: ['4411', '4412', '4413'],
      left: 1,
      since: null,
    })
    const brief = {
      title: 'fix SHOP-1A',
      prompt: 'Fix Sentry issue SHOP-1A.',
      context: '## Stack trace\n\nsrc/refunds.ts:42',
      links: [{ title: 'SHOP-1A', url: 'https://acme.sentry.io/issues/4411/' }],
    }
    const made = await client.watchFound(
      'new-errors',
      { key: '4411', title: 'SHOP-1A: TypeError' },
      { agent: brief },
    )
    expect(made.task).toBe('app/fix-shop-1a')
    // The same title again is a second name, never the first one's conversation.
    const again = await client.watchFound(
      'new-errors',
      { key: '4412', title: 'SHOP-1A again' },
      { agent: brief },
    )
    expect(again.task).toBe('app/fix-shop-1a-2')
    const folder = taskDir(home, 'app/fix-shop-1a')
    const file = readFileSync(join(folder, 'task.yaml'), 'utf8')
    expect(file).toContain('by: schedule:new-errors')
    expect(file).toContain('prompt: Fix Sentry issue SHOP-1A.')
    expect(file).toContain('https://acme.sentry.io/issues/4411/')
    expect(readFileSync(join(folder, 'context.md'), 'utf8')).toContain('src/refunds.ts:42')

    await client.watchFound(
      'new-errors',
      { key: '4413', title: 'SHOP-1C' },
      { told: 'orchestrator' },
    )
    await client.watchFound(
      'new-errors',
      { key: '4414', title: 'SHOP-1D' },
      { problem: 'rate limited' },
    )
    await client.watchChecked('new-errors', {
      problem: 'Sentry is down',
      trouble: 'unreachable',
    })

    const watched = watchedFrom(
      await client.events({ types: ['watch_checked', 'watch_found'] }),
      'new-errors',
    )
    expect([...watched.seen]).toEqual(['4411', '4412', '4413', '4414'])
    expect(watched.findings.map((one) => [one.key, one.task, one.told, one.problem])).toEqual([
      ['4414', null, null, 'rate limited'],
      ['4413', null, 'orchestrator', null],
      ['4412', 'app/fix-shop-1a-2', null, null],
      ['4411', 'app/fix-shop-1a', null, null],
    ])
    expect(watched.looks.map((one) => [one.found, one.fresh, one.left, one.problem])).toEqual([
      [0, 0, 0, 'Sentry is down'],
      [3, 3, 1, null],
    ])
    // A look that could not look leaves where the next one starts alone.
    expect(watched.since).toBeNull()

    // Work that cannot be made is written down with why, so the next look does not try again.
    renameSync(join(repo.root, '.git'), join(repo.root, '.git-away'))
    try {
      await expect(
        client.watchFound(
          'new-errors',
          { key: '4415', title: 'SHOP-1E' },
          { agent: { ...brief, title: 'fix SHOP-1E' } },
        ),
      ).rejects.toThrow(/no commit to work from/)
    } finally {
      renameSync(join(repo.root, '.git-away'), join(repo.root, '.git'))
    }
    const last = watchedFrom(await client.events({ types: ['watch_found'] }), 'new-errors')
    expect(last.findings[0]).toMatchObject({
      key: '4415',
      task: null,
      problem: expect.stringContaining('no commit to work from'),
    })
  })

  it('gives work that cannot share a tree one of its own, in a project whose agents share theirs', async () => {
    await client.setSchedule(
      deps({
        id: 'dependency-updates',
        name: 'Dependency updates',
        when: { every: '1d' },
        does: { kind: 'watch', watch: 'deps.updates', input: {}, found: 'agent', most: 2 },
      }),
      'you',
    )
    const bump = { title: 'bump 3 patch releases', prompt: 'Bump them.' }
    // This home says nothing about where agents work, so they share the
    // project's own checkout — the machine's own default.
    const beside = await client.watchFound(
      'dependency-updates',
      { key: 'a', title: 'a' },
      {
        agent: bump,
      },
    )
    expect(beside.task).toBe('app/bump-3-patch-releases')
    const fileOf = (task: string) => readFileSync(join(taskDir(home, task), 'task.yaml'), 'utf8')
    expect(fileOf(beside.task ?? '')).toContain('workspace: checkout')

    // The same work, saying it cannot share one: a worktree and a branch of
    // its own, in the same project, without anybody changing a setting.
    const apart = await client.watchFound(
      'dependency-updates',
      { key: 'b', title: 'b' },
      {
        agent: { ...bump, title: 'bump vitest', alone: true },
      },
    )
    // Nothing says `checkout` on it, which is how a worktree task's file reads.
    expect(fileOf(apart.task ?? '')).not.toContain('workspace:')
    expect(repo.git('branch', '--list', 'tade/bump-vitest')).toContain('tade/bump-vitest')
  })

  it('begins work on the ref the finding named, in a tree of its own', async () => {
    // A review that conflicts is merged into from its own head, so the work says
    // where its tree begins: kept in its task file, and read when it starts.
    await client.setSchedule(
      deps({
        id: 'conflicts-app',
        name: 'review.conflicts',
        when: { every: '10m' },
        does: { kind: 'watch', watch: 'review.conflicts', input: {}, found: 'agent', most: 2 },
      }),
      'you',
    )
    repo.git('checkout', '-q', '-b', 'shop/refunds-retry')
    const head = repo.commit('retry refunds once')
    repo.git('checkout', '-q', 'main')
    repo.commit('main moves on')
    const made = await client.watchFound(
      'conflicts-app',
      { key: 'c', title: 'c' },
      {
        agent: {
          title: 'review 412 conflicts with main',
          prompt: 'Merge main in.',
          alone: true,
          from: 'shop/refunds-retry',
        },
      },
    )
    const task = made.task ?? ''
    const file = await readTaskFile(home, task)
    expect(file?.start?.from).toBe('shop/refunds-retry')
    // What the queue hands the start, and what that start does with it: the
    // tree begins on the review's head, not on the base it was made from.
    const worktree = join(home, 'worktrees', task.replace('/', '-'))
    const from = startFrom(file?.start?.after ?? [], new Map(), 'main', 'app', file?.start?.from)
    await beginFrom(home, worktree, task, from)
    expect(repo.git('-C', worktree, 'rev-parse', 'HEAD').trim()).toBe(head)
    expect((await readTaskFile(home, task))?.base).toBe(head)
  })

  it('makes a proposal parked, so nothing starts it until a person picks it up', async () => {
    await client.setSchedule(
      deps({
        id: 'mistakes-app',
        name: 'Mistakes made twice',
        when: { every: '1h' },
        does: { kind: 'watch', watch: 'jev.mistakes', input: {}, found: 'agent', most: 2 },
      }),
      'you',
    )
    const made = await client.watchFound(
      'mistakes-app',
      { key: 'test_missing', title: 'test_missing was confirmed real twice' },
      {
        agent: {
          title: 'check for test_missing',
          prompt: 'Add a check that fails on a change with no test.',
          context: '# Made twice in app: test_missing\n',
          parked: true,
        },
      },
    )
    const task = made.task ?? ''
    expect(task).toBe('app/check-for-test-missing')
    const file = await readTaskFile(home, task)
    expect(file?.parked).toBe(true)
    expect(file?.start?.prompt).toBe('Add a check that fails on a change with no test.')
    // Parked by the schedule rather than by you, and found once with its task.
    const parked = await client.events({ types: ['state_change'] })
    expect(parked.map((event) => [event.task, event.detail])).toEqual([
      [task, { state: 'parked', by: 'schedule:mistakes-app' }],
    ])
    const found = watchedFrom(await client.events({ types: ['watch_found'] }), 'mistakes-app')
    expect(found.findings.map((one) => [one.key, one.task])).toEqual([['test_missing', task]])
    // However the queue came to try it, starting reads the file and refuses.
    await expect(client.startQueued({ task, worktree: repo.root, why: 'ready' })).rejects.toThrow(
      /parked/,
    )
    // Approving it is picking it up: one act, and the same one as any park.
    await client.parkTask(task, false)
    expect((await readTaskFile(home, task))?.parked).toBe(false)
  })
})
