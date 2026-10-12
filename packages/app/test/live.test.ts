import { renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema, type Task, type Workspace } from '@tade/core'
import { git, gitLoad, makeCollector, type StatusAnswer, type StatusCollector } from '@tade/status'
import { Workbench } from '@tade/workbench'
import type { LaneRecord } from '@tade/workbench/registry'
import type { PendingApproval } from '@tade/workbench/workers'
import { afterEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { Live } from '../src/live.ts'
import {
  CHANGED_FORMAT,
  changedFrom,
  changesFrom,
  commitsFrom,
  knownTasks,
  snapshotsFrom,
} from '../src/reality.ts'

// What the window shows is a fold of three sources that each know part of the
// truth: status knows the states, the registry knows the screens, the approval
// queue knows what is waiting.

const task = (id: string, state: Task['state']): Task => ({
  id,
  project: id.split('/')[0] ?? id,
  intent_spoken: 'something',
  branch: `tade/${id.split('/').at(-1)}`,
  worktree: `/wt/${id.split('/').at(-1)}`,
  created: '2026-09-11T09:00:00.000Z',
  state,
  reason: 'because',
  stalled: false,
  git: null,
  agents: [],
  lanes: [],
})

const workspace = (tasks: Task[]): Workspace => ({
  generatedAt: '2026-09-11T14:00:00.000Z',
  projects: [{ name: 'checkout', root: '/src/checkout', brief: null, tasks, untracked: [] }],
  elsewhere: [],
  toolServers: { looked: true, alive: 0 },
  warnings: [],
})

const lane = (over: Partial<LaneRecord>): LaneRecord =>
  ({
    id: 'checkout/refunds/agent',
    task: 'checkout/refunds',
    kind: 'agent',
    spec: { id: 'checkout/refunds/agent', cwd: '/wt/refunds', command: 'pi', args: [] },
    pid: 1,
    startedAt: 1,
    title: 'agent',
    alive: true,
    exitCode: null,
    lastOutputAt: null,
    ...over,
  }) as LaneRecord

const approval = (task: string): PendingApproval => ({
  run: 'r1',
  task,
  requestId: 'q1',
  tool: 'bash',
  summary: 'bash: npm test',
  tier: 'soft',
  rule: 'shell',
  reason: 'runs a command',
  at: 1,
})

describe('snapshotsFrom', () => {
  it('carries each task and its state', () => {
    const snapshots = snapshotsFrom(
      workspace([task('checkout/refunds', 'working'), task('checkout/stripe-v15', 'blocked')]),
      [],
      [],
    )
    expect(snapshots).toEqual([
      {
        task: 'checkout/refunds',
        state: 'working',
        // Why, as status says it: what tells an idle agent from one waiting on a decision.
        reason: 'because',
        title: null,
        // What was asked for, verbatim: what search matches a sentence against.
        intent: 'something',
        branch: expect.any(String),
        lane: null,
        waiting: false,
        approval: null,
        lanes: [],
      },
      {
        task: 'checkout/stripe-v15',
        state: 'blocked',
        reason: 'because',
        title: null,
        intent: 'something',
        branch: expect.any(String),
        lane: null,
        waiting: false,
        approval: null,
        lanes: [],
      },
    ])
  })

  it('attaches the lane whose screen the pane should draw', () => {
    const [snapshot] = snapshotsFrom(
      workspace([task('checkout/refunds', 'working')]),
      [],
      [lane({})],
    )
    expect(snapshot?.lane).toBe('checkout/refunds/agent')
  })

  it('prefers the agent lane over the others', () => {
    const [snapshot] = snapshotsFrom(
      workspace([task('checkout/refunds', 'working')]),
      [],
      [
        lane({ id: 'checkout/refunds/tests', kind: 'tests' }),
        lane({ id: 'checkout/refunds/agent', kind: 'agent' }),
      ],
    )
    expect(snapshot?.lane).toBe('checkout/refunds/agent')
  })

  it('ignores a lane that has exited', () => {
    const [snapshot] = snapshotsFrom(
      workspace([task('checkout/refunds', 'working')]),
      [],
      [lane({ alive: false })],
    )
    expect(snapshot?.lane).toBeNull()
  })

  it('marks the task an approval is waiting on', () => {
    const snapshots = snapshotsFrom(
      workspace([task('checkout/refunds', 'working'), task('checkout/stripe-v15', 'working')]),
      [approval('checkout/stripe-v15')],
      [],
    )
    expect(snapshots.find((s) => s.task === 'checkout/stripe-v15')?.waiting).toBe(true)
    expect(snapshots.find((s) => s.task === 'checkout/refunds')?.waiting).toBe(false)
  })

  it('keeps a stable order, so the sidebar does not jump around', () => {
    const tasks = [task('checkout/zebra', 'working'), task('checkout/alpha', 'working')]
    expect(snapshotsFrom(workspace(tasks), [], []).map((s) => s.task)).toEqual([
      'checkout/alpha',
      'checkout/zebra',
    ])
  })

  it('has nothing to show when there is nothing', () => {
    expect(snapshotsFrom(workspace([]), [], [])).toEqual([])
  })
})

describe('knownTasks', () => {
  it('hands the resolver what it needs to work out which one you meant', () => {
    expect(
      knownTasks([{ task: 'checkout/refunds', state: 'blocked', lane: null, waiting: true }]),
    ).toEqual([{ id: 'checkout/refunds', project: 'checkout', state: 'blocked' }])
  })
})

describe('changesFrom', () => {
  it('reads everything a task changed since it branched, committed or not', async () => {
    const repo = mkrepo()
    repo.commit('first', { 'keep.ts': 'a\nb\nc\n', 'gone.ts': 'x\n', 'old name.ts': 'same\n' })
    const base = repo.head()

    // Committed on the task's branch: plain `git status` would show none of this.
    repo.commit('agent work', { 'committed.ts': 'one\ntwo\n' })
    repo.write({
      'keep.ts': 'a\nB\nc\nd\n',
      'new file.ts': 'hello\n',
      '.tade/task.yaml': 'id: x\n',
    })
    rmSync(join(repo.root, 'gone.ts'))
    renameSync(join(repo.root, 'old name.ts'), join(repo.root, 'new name.ts'))
    repo.git('add', '-A', 'new name.ts', 'old name.ts')

    const run = async (args: string[]) => (await git(repo.root, args)).stdout
    const changes = changesFrom(
      await run(['diff', '--name-status', '-z', base]),
      await run(['diff', '--numstat', '-z', base]),
      await run(['status', '--porcelain=v2', '-z', '--untracked-files=all']),
    )
    const at = (path: string) => changes.find((change) => change.path === path)

    expect(at('committed.ts')).toEqual({ path: 'committed.ts', mark: 'A', added: 2, removed: 0 })
    expect(at('keep.ts')).toEqual({ path: 'keep.ts', mark: 'M', added: 2, removed: 1 })
    expect(at('gone.ts')?.mark).toBe('D')
    // Paths with spaces survive, because the output is NUL-separated.
    expect(at('new file.ts')?.mark).toBe('?')
    expect(at('new name.ts')?.mark).toBe('R')
  })
})

describe('changedFrom', () => {
  it('reads what each agent at work has committed, out of real git', async () => {
    const repo = mkrepo()
    repo.commit('first', { 'charge.ts': 'a\n', 'mail.ts': 'a\n' })
    repo.write({ 'charge.ts': 'b\n' })
    repo.git('add', '-A')
    repo.git('commit', '-q', '-m', 'charge once\n\nTade-Task: shop/fix-charge')
    repo.write({ 'a file with spaces.ts': 'new\n' })
    repo.git('add', '-A')
    repo.git('commit', '-q', '-m', 'nobody signed this one')

    const log = await git(repo.root, ['log', `--format=${CHANGED_FORMAT}`, '--name-only'])
    const out = changedFrom(log.stdout)
    // A commit with no trailer belongs to nobody, and is left out rather
    // than guessed at.
    expect(out).toEqual([
      { commit: expect.any(String), task: 'shop/fix-charge', paths: ['charge.ts'] },
    ])
    expect(changedFrom('')).toEqual([])
  })
})

describe('commitsFrom', () => {
  // As `git log --format=%x01… --shortstat` writes it: a record mark, the
  // fields, then what the commit touched.
  const entry = (sha: string, at: number, subject: string, trailers = '', stat = '') =>
    `\u0001${sha}\u0000${at}\u0000${subject}\u0000${trailers}\u0000\n${stat ? `\n ${stat}\n` : ''}`

  it('reads each commit, the task its trailer names, and what it touched', () => {
    const out = commitsFrom(
      [
        entry(
          'a1b2c3d',
          1_789_000_000,
          'move to stripe v15',
          'checkout/stripe-v15',
          '6 files changed, 148 insertions(+), 62 deletions(-)',
        ),
        entry(
          '9f0e1d2',
          1_788_000_000,
          'a commit nobody signed',
          '',
          '1 file changed, 3 insertions(+)',
        ),
      ].join(''),
    )
    expect(out).toEqual([
      {
        sha: 'a1b2c3d',
        at: 1_789_000_000_000,
        subject: 'move to stripe v15',
        task: 'checkout/stripe-v15',
        files: 6,
        added: 148,
        removed: 62,
      },
      // Unattributed is an answer, not a guess: nothing says whose this is.
      // A commit that deleted nothing says nothing about deletions.
      {
        sha: '9f0e1d2',
        at: 1_788_000_000_000,
        subject: 'a commit nobody signed',
        task: null,
        files: 1,
        added: 3,
        removed: null,
      },
    ])
  })

  it('keeps a subject with anything in it, and survives an empty log', () => {
    const out = commitsFrom(entry('a1b2c3d', 1, 'fix: a "quoted", 3 files changed | subject'))
    expect(out[0]?.subject).toBe('fix: a "quoted", 3 files changed | subject')
    // A merge has no stat line, and what it touched is unknown rather than nothing.
    expect(out[0]?.files).toBeNull()
    expect(commitsFrom('')).toEqual([])
  })

  it('takes the first trailer when a message carries two', () => {
    const out = commitsFrom(entry('a1b2c3d', 1, 'copied message', 'shop/one,shop/two'))
    expect(out[0]?.task).toBe('shop/one')
  })
})

describe('the last look at a task, read without starting one', () => {
  const opened: { live: Live; client: Workbench }[] = []

  afterEach(async () => {
    for (const one of opened.splice(0)) {
      await one.live.stop().catch(() => {})
      await one.client.close().catch(() => {})
    }
  })

  it('answers what the last look said, and never goes looking itself', async () => {
    // Search composes what is happening for every task on every keystroke, so
    // the checks have to be readable without a look — a look is git, and one
    // per task per letter is the window shelling out while somebody types.
    const repo = mkrepo()
    repo.addTask('refunds', { project: 'app', intent: 'refunds double-charge' })
    const home = tmp('tade-live-')
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    const client = await Workbench.open({ home })
    let changed = 0
    const live = await Live.start({
      client,
      config: ConfigSchema.parse({ projects: { app: { root: repo.root } } }),
      home,
      tadeHome: repo.home,
      // Far longer than this test: the beat's own looks are not what is measured.
      pollMs: 600_000,
      onChange: () => {
        changed++
      },
    })
    opened.push({ live, client })

    // Nothing has looked, so there is nothing to say — and asking again and
    // again says nothing and starts nothing, which is the whole point of it.
    const settled = changed
    for (let i = 0; i < 50; i++) expect(live.seenActions('app/refunds')).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    // Still nothing: a look that had run would have filled this and said so.
    // Both halves, because the cache is the fact and the callback is the clue.
    expect(live.seenActions('app/refunds')).toBeNull()
    expect(changed).toBe(settled)

    // `actions` is the one that finds a look due, the window's next look
    // starts it, and what it finds is what this reads.
    live.actions('app/refunds')
    live.lookAgain()
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    expect(live.seenActions('app/refunds')).toEqual(live.actions('app/refunds'))
    expect(live.seenActions('app/refunds')?.task).toBe('app/refunds')
  }, 30_000)

  it('starts no git while it answers, and starts what it found due on the next look', async () => {
    // The readers are read inside a frame — the FILES tree, its marks, the
    // branch, CHANGES, the ACTIONS tab — and a fork is synchronous on the
    // thread that draws. They used to start their own looks, so every couple
    // of seconds one frame paid for three or four `git`s on its way to the
    // screen. Now a read only says a look is due, and the window's next look
    // starts it.
    const repo = mkrepo()
    repo.addTask('refunds', { project: 'app', intent: 'refunds double-charge' })
    const home = tmp('tade-live-due-')
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    const client = await Workbench.open({ home })
    let due = 0
    const live = await Live.start({
      client,
      config: ConfigSchema.parse({ projects: { app: { root: repo.root } } }),
      home,
      tadeHome: repo.home,
      pollMs: 600_000,
      onDue: () => {
        due++
      },
    })
    opened.push({ live, client })
    await live.refresh()

    // Thirty frames' worth of reading, and nothing started.
    const before = gitLoad().started
    const read = () => {
      live.files(repo.root, [])
      live.marksAt(repo.root)
      live.changesAt(repo.root, null)
      live.branchAt(repo.root)
      live.actions('app/refunds')
    }
    for (let frame = 0; frame < 30; frame++) read()
    expect(gitLoad().started - before, 'a read started git').toBe(0)
    expect(live.files(repo.root, []), 'a read went to the disk').toEqual([])
    // Asked for once, however often it was read: one look soon, not thirty.
    expect(due).toBe(1)

    // The look starts all of it, and the listing is there at once.
    const revision = live.revision
    const looking = live.lookAgain()
    expect(live.files(repo.root, []).length).toBeGreaterThan(0)
    await looking
    expect(gitLoad().started - before).toBeGreaterThan(0)
    expect(live.revision, 'what changed was not counted').toBeGreaterThan(revision)
    // And nothing more is due until something goes stale: reading again
    // straight after a look starts nothing on the look after it.
    const looked = gitLoad().started
    read()
    await live.lookAgain()
    expect(gitLoad().started).toBe(looked)
  }, 30_000)

  it('keeps the whole of the last look, and says unknown before there has been one', async () => {
    // The away view needs the shapes themselves — every project, every task,
    // every warning, and an approval's id, which the drawing drops — and it
    // may not go and ask: `collectStatus` again per page refresh would double
    // the `git` and `ps` work the beat already did and give two answers to one
    // question. Null before the first look is `unknown`, and is **not** an
    // empty workspace, which everything above would read as "nothing is
    // running".
    const repo = mkrepo()
    repo.addTask('refunds', { project: 'app', intent: 'refunds double-charge' })
    const home = tmp('tade-live-world-')
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    const client = await Workbench.open({ home })
    const live = await Live.start({
      client,
      config: ConfigSchema.parse({ projects: { app: { root: repo.root } } }),
      home,
      tadeHome: repo.home,
      pollMs: 600_000,
    })
    opened.push({ live, client })
    await live.refresh()
    const world = live.world
    expect(world).not.toBeNull()
    expect(world?.projects.map((one) => one.name)).toEqual(['app'])
    expect(world?.projects[0]?.tasks.map((one) => one.id)).toEqual(['app/refunds'])
    // Nothing is waiting on anybody, which is a list and not a null: `pending`
    // is what the supervisor found, and finding none is an answer.
    expect(live.pending).toEqual([])
  }, 30_000)

  it('keeps the last look that could when status cannot look, and says why', async () => {
    // A child that died, or a machine too busy to answer in time, is
    // `unknown`: the window says so and goes on drawing the last world it
    // saw — never an empty one, which reads as every agent having gone.
    const repo = mkrepo()
    const home = tmp('tade-live-unknown-')
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    const client = await Workbench.open({ home })
    const seen = workspace([task('checkout/refunds', 'working')])
    const answers: StatusAnswer[] = [
      { known: true, workspace: seen, spent: { spawns: 0, rss: 0, pid: 0 } },
      { known: false, why: "status's process exited 1" },
    ]
    const asked: string[] = []
    const status: StatusCollector = {
      id: 'scripted',
      collect: async (ask) => {
        asked.push(Object.keys(ask.lanes).join(','))
        return answers.shift() ?? { known: false, why: 'nothing left' }
      },
      close: async () => {},
    }
    const warnings: string[] = []
    const live = await Live.start({
      client,
      config: ConfigSchema.parse({ projects: { app: { root: repo.root } } }),
      home,
      tadeHome: repo.home,
      pollMs: 600_000,
      status,
      onWarning: (warning) => warnings.push(warning),
    })
    opened.push({ live, client })
    await live.looked
    expect(live.world).toBe(seen)
    await live.refresh()
    expect(warnings).toContain("status's process exited 1")
    expect(live.world).toBe(seen)
    expect(live.tasks.map((one) => one.task)).toEqual(['checkout/refunds'])
    // The lanes went with each ask, read by the window; there are none here.
    expect(asked).toEqual(['', ''])
  }, 30_000)

  it('stays unknown, not empty, when status has never been able to look', async () => {
    const repo = mkrepo()
    const home = tmp('tade-live-never-')
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    const client = await Workbench.open({ home })
    const warnings: string[] = []
    const live = await Live.start({
      client,
      config: ConfigSchema.parse({ projects: { app: { root: repo.root } } }),
      home,
      tadeHome: repo.home,
      pollMs: 600_000,
      status: {
        id: 'scripted',
        collect: async () => ({ known: false, why: 'busy' }),
        close: async () => {},
      },
      onWarning: (warning) => warnings.push(warning),
    })
    opened.push({ live, client })
    // The first look, which `start` does not wait for: the window draws first.
    await live.refresh()
    expect(live.hasLooked).toBe(false)
    expect(live.world).toBeNull()
    expect(live.tasks).toEqual([])
    expect(warnings).toEqual(['busy'])
  }, 30_000)

  it('looks in a child it was given, which starts every git of the look and leaves the window none', async () => {
    const repo = mkrepo()
    repo.addTask('refunds', { project: 'app', intent: 'refunds double-charge' })
    const home = tmp('tade-live-child-')
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    const client = await Workbench.open({ home })
    const status = makeCollector('child')
    const before = gitLoad().started
    const live = await Live.start({
      client,
      config: ConfigSchema.parse({ projects: { app: { root: repo.root } } }),
      home,
      tadeHome: repo.home,
      pollMs: 600_000,
      status,
    })
    opened.push({ live, client })
    try {
      await live.looked
      expect(live.world?.projects[0]?.tasks.map((one) => one.id)).toEqual(['app/refunds'])
      expect(gitLoad().started - before).toBe(0)
      // Stopping the window's look is not closing a child it was handed:
      // that is whoever made it's, on the way out.
      await live.stop()
      const after = await status.collect({
        config: ConfigSchema.parse({ workspace: { adopt: false } }),
        now: Date.now(),
        home,
        tadeHome: repo.home,
        pr: false,
        lanes: {},
      })
      expect(after.known).toBe(true)
    } finally {
      await status.close()
    }
  }, 30_000)
})

describe('opening before looking', () => {
  const opened: { live: Live; client: Workbench }[] = []
  afterEach(async () => {
    for (const one of opened.splice(0)) {
      await one.live.stop().catch(() => {})
      await one.client.close().catch(() => {})
    }
  })

  /** A turn of the event loop, which is what the journal's lists are read a query at a time on. */
  const aTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

  it('starts before its first look and before the journal is read, and says neither is known', async () => {
    const repo = mkrepo()
    const home = tmp('tade-live-first-')
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    const client = await Workbench.open({ home })
    await client.log.append({
      type: 'usage',
      task: 'checkout/refunds',
      detail: { input: 10, output: 0, tokens: 10, usd: 1, priced: 'exact' },
    })
    let answer: (answer: StatusAnswer) => void = () => {}
    const seen = workspace([task('checkout/refunds', 'working')])
    const live = await Live.start({
      client,
      config: ConfigSchema.parse({ projects: { app: { root: repo.root } } }),
      home,
      tadeHome: repo.home,
      pollMs: 600_000,
      status: {
        id: 'scripted',
        collect: () => new Promise((resolve) => (answer = resolve)),
        close: async () => {},
      },
    })
    opened.push({ live, client })
    // What the first frame is drawn from: nothing looked at, nothing read.
    expect(live.hasLooked).toBe(false)
    expect(live.tasks).toEqual([])
    expect(live.spendToday()).toBeNull()
    expect(live.runtimeToday()).toBeNull()
    // The journal is read a query a turn, whether or not status has answered.
    for (let turn = 0; turn < 50 && live.spendToday() === null; turn++) await aTurn()
    expect(live.spendToday()?.total.usd).toBe(1)
    expect(live.hasLooked).toBe(false)
    answer({ known: true, workspace: seen, spent: { spawns: 0, rss: 0, pid: 0 } })
    await live.looked
    expect(live.hasLooked).toBe(true)
    expect(live.tasks.map((one) => one.task)).toEqual(['checkout/refunds'])
  }, 30_000)

  it('counts an event appended while the journal is being read exactly once', async () => {
    const repo = mkrepo()
    const home = tmp('tade-live-once-')
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    const client = await Workbench.open({ home })
    const live = await Live.start({
      client,
      config: ConfigSchema.parse({ projects: { app: { root: repo.root } } }),
      home,
      tadeHome: repo.home,
      pollMs: 600_000,
    })
    opened.push({ live, client })
    // One before each query and a few after the last, so whichever side of the
    // tail's moment each lands on, it is the lists or the subscription that
    // counts it, and never both.
    const appended: number[] = []
    for (let turn = 0; turn < 10; turn++) {
      const event = await client.log.append({
        type: 'usage',
        task: 'app/refunds',
        detail: { input: 1, output: 0, tokens: 1, usd: 0, priced: 'exact' },
      })
      appended.push(event.seq)
      await aTurn()
    }
    await live.refresh()
    for (const seq of appended) {
      expect(live.spending.filter((event) => event.seq === seq)).toHaveLength(1)
      expect(live.events.filter((event) => event.seq === seq)).toHaveLength(1)
    }
    expect(live.spendToday()?.total.tokens).toBe(appended.length)
  }, 30_000)
})
