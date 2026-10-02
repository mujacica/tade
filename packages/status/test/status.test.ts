import { cpSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Config, ConfigSchema } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { collectStatus, type StatusOptions } from '../src/status.ts'

const NOW = Date.parse('2026-09-11T12:00:00Z')

function config(projects: Record<string, string>, adopt = true): Config {
  return ConfigSchema.parse({
    workspace: { adopt },
    projects: Object.fromEntries(Object.entries(projects).map(([k, root]) => [k, { root }])),
  })
}

function opts(over: Partial<StatusOptions> & { config: Config }): StatusOptions {
  return {
    now: NOW,
    home: tmp('tade-home-'),
    // A home with nothing in it: a test about a project with no tasks.
    tadeHome: tmp('tade-own-'),
    pr: false,
    processes: async () => ({ processes: [], servers: { looked: true, alive: 0 }, warnings: [] }),
    ...over,
  }
}

const task = (ws: Awaited<ReturnType<typeof collectStatus>>, id: string) =>
  ws.projects.flatMap((p) => p.tasks).find((t) => t.id === id)

describe('collectStatus', () => {
  it('discovers tasks and derives their states', async () => {
    const r = mkrepo()
    r.addTask('fresh', { project: 'app', intent: 'the refund flow double-charges, I think' })
    const done = r.addTask('done', { project: 'app' })
    r.commit('feat', undefined, done)
    const wip = r.addTask('wip', { project: 'app' })
    r.write({ 'x.ts': '1' }, wip)
    r.addTask('parked', { project: 'app', parked: true })
    // A tade/* branch with no task file is not a task.
    r.git('worktree', 'add', '-q', '-b', 'tade/stray', join(r.root, '..', 'stray'), 'main')

    const ws = await collectStatus(opts({ config: config({ app: r.root }), tadeHome: r.home }))
    expect(ws.warnings).toEqual([])
    expect(ws.projects[0]?.tasks.map((t) => [t.id, t.state])).toEqual([
      ['app/done', 'review'],
      ['app/fresh', 'queued'],
      ['app/parked', 'parked'],
      ['app/wip', 'working'],
    ])
    expect(task(ws, 'app/fresh')?.intent_spoken).toBe('the refund flow double-charges, I think')
  })

  it('attaches an adopted session to the task whose worktree it runs in', async () => {
    const r = mkrepo()
    const wt = r.addTask('adopted', { project: 'app' })
    const home = tmp('tade-home-')
    const dir = join(home, '.claude/projects/x')
    mkdirSync(dir, { recursive: true })
    const line = (o: object) => `${JSON.stringify(o)}\n`
    const file = join(dir, 's.jsonl')
    writeFileSync(
      file,
      line({
        type: 'assistant',
        isSidechain: false,
        sessionId: 'sess-1',
        cwd: join(wt, 'src'),
        timestamp: new Date(NOW - 60_000).toISOString(),
        message: { stop_reason: 'tool_use' },
      }),
    )
    utimesSync(file, NOW / 1000, NOW / 1000)
    // A second, live session in the repo root is untracked, not a task's.
    writeFileSync(
      join(dir, 't.jsonl'),
      line({
        type: 'user',
        sessionId: 'sess-2',
        cwd: r.root,
        timestamp: new Date(NOW - 30_000).toISOString(),
        message: {},
      }),
    )
    utimesSync(join(dir, 't.jsonl'), NOW / 1000, NOW / 1000)

    const ws = await collectStatus(
      opts({ config: config({ app: r.root }), home, tadeHome: r.home }),
    )
    const t = task(ws, 'app/adopted')
    expect(t?.state).toBe('working')
    expect(t?.agents.map((a) => a.sessionId)).toEqual(['sess-1'])
    expect(ws.projects[0]?.untracked.map((a) => a.sessionId)).toEqual(['sess-2'])
    expect(ws.elsewhere).toEqual([])
  })

  it('counts an agent Tade runs once, though its harness writes a transcript too', async () => {
    const r = mkrepo()
    const wt = r.addTask('both', { project: 'app' })
    const home = tmp('tade-home-')
    const dir = join(home, '.claude/projects/x')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'conv-1.jsonl')
    writeFileSync(
      file,
      `${JSON.stringify({
        type: 'user',
        sessionId: 'conv-1',
        cwd: wt,
        timestamp: new Date(NOW - 10_000).toISOString(),
        message: {},
      })}\n`,
    )
    utimesSync(file, NOW / 1000, NOW / 1000)
    const run = {
      source: 'run' as const,
      provider: 'claude-code',
      sessionId: 'app/both/agent',
      conversation: 'conv-1',
      alive: true,
      lastActivityAt: NOW,
      turn: 'running' as const,
      pendingPermissions: [],
      consecutiveFailures: 0,
      exitCode: null,
    }
    const ws = await collectStatus(
      opts({
        config: config({ app: r.root }),
        home,
        tadeHome: r.home,
        liveness: { lanes: async () => [run], records: async () => [] },
      }),
    )
    expect(task(ws, 'app/both')?.agents.map((a) => a.sessionId)).toEqual(['app/both/agent'])
    // Nor is it something working in the project that no task has.
    expect(ws.projects[0]?.untracked).toEqual([])
  })

  it('a running provider process proves liveness even when the transcript is quiet', async () => {
    const r = mkrepo()
    const wt = r.addTask('quiet', { project: 'app' })
    const home = tmp('tade-home-')
    const dir = join(home, '.codex/sessions/2026/09/11')
    mkdirSync(dir, { recursive: true })
    const fx = fileURLToPath(
      new URL(
        '../../../test/fixtures/transcripts/codex/0.104/rollout-2026-09-11T10-00-00-aaaaaaaa-0000-7000-8000-000000000002.jsonl',
        import.meta.url,
      ),
    )
    const file = join(dir, 'rollout-2026-09-11T10-00-00-aaaaaaaa-0000-7000-8000-000000000002.jsonl')
    cpSync(fx, file)
    // Rewrite the cwd to this worktree; the approval request is 2 hours old.
    const { readFileSync } = await import('node:fs')
    writeFileSync(file, readFileSync(file, 'utf8').replaceAll('/work/search', wt))
    utimesSync(file, NOW / 1000, NOW / 1000)

    const without = await collectStatus(
      opts({ config: config({ app: r.root }), home, tadeHome: r.home }),
    )
    expect(task(without, 'app/quiet')?.state).not.toBe('blocked')

    const withProc = await collectStatus(
      opts({
        config: config({ app: r.root }),
        home,
        tadeHome: r.home,
        processes: async () => ({
          processes: [{ pid: 1, provider: 'codex', cwd: wt }],
          servers: { looked: true, alive: 0 },
          warnings: [],
        }),
      }),
    )
    expect(task(withProc, 'app/quiet')).toMatchObject({
      state: 'blocked',
      reason: 'wants approval: bash: rm -r test/old',
    })
  })

  it('finds an agent that has no branch yet, and keeps its id once it has one', async () => {
    const r = mkrepo()
    const wt = join(r.root, '..', 'agent-1')
    r.git('worktree', 'add', '-q', '--detach', wt, 'main')
    mkdirSync(join(r.home, 'projects', 'app', 'tasks', 'agent-1'), { recursive: true })
    writeFileSync(
      join(r.home, 'projects', 'app', 'tasks', 'agent-1', 'task.yaml'),
      'id: app/agent-1\nproject: app\nintent_spoken: ""\ncreated: 2026-09-11T11:00:00Z\ntitle: refund retries\nlinks:\n  - title: SHOP-1A\n    url: https://acme.sentry.io/issues/4411/\n',
    )
    // A detached worktree Tade did not make is nobody's task.
    r.git('worktree', 'add', '-q', '--detach', join(r.root, '..', 'somebody'), 'main')

    let ws = await collectStatus(opts({ config: config({ app: r.root }), tadeHome: r.home }))
    expect(ws.projects[0]?.tasks.map((t) => [t.id, t.branch, t.title])).toEqual([
      ['app/agent-1', '', 'refund retries'],
    ])
    // Where the work came from is read back with it.
    expect(task(ws, 'app/agent-1')?.links).toEqual([
      { title: 'SHOP-1A', url: 'https://acme.sentry.io/issues/4411/' },
    ])

    r.git('-C', wt, 'switch', '-q', '-c', 'tade/refund-retries')
    ws = await collectStatus(opts({ config: config({ app: r.root }), tadeHome: r.home }))
    expect(task(ws, 'app/agent-1')?.branch).toBe('tade/refund-retries')
  })

  it('finds agents working side by side in the checkout, each by its own folder', async () => {
    const r = mkrepo()
    for (const [slug, title] of [
      ['refunds', 'refund retries'],
      ['search', 'faster search'],
    ] as const) {
      mkdirSync(join(r.home, 'projects', 'app', 'tasks', slug), { recursive: true })
      writeFileSync(
        join(r.home, 'projects', 'app', 'tasks', slug, 'task.yaml'),
        `id: app/${slug}\nproject: app\nintent_spoken: "${title}"\ncreated: 2026-09-11T11:00:00Z\nworkspace: checkout\n`,
      )
    }
    // Files changed in the checkout are everyone's: they do not make a task "working".
    writeFileSync(join(r.root, 'shared.ts'), 'export {}\n')
    const ws = await collectStatus(opts({ config: config({ app: r.root }), tadeHome: r.home }))
    expect(
      ws.projects[0]?.tasks.map((t) => [t.id, t.workspace, t.worktree, t.branch, t.state]),
    ).toEqual([
      ['app/refunds', 'checkout', r.root, 'main', 'queued'],
      ['app/search', 'checkout', r.root, 'main', 'queued'],
    ])
  })

  describe('never throws', () => {
    it('corrupt .git', async () => {
      const r = mkrepo()
      r.addTask('a', { project: 'app' })
      rmSync(join(r.root, '.git', 'HEAD'))
      const ws = await collectStatus(opts({ config: config({ app: r.root }), tadeHome: r.home }))
      expect(ws.projects[0]?.tasks).toEqual([])
      expect(ws.warnings.join('\n')).toMatch(/^app: /m)
    })

    it('project root that does not exist', async () => {
      const ws = await collectStatus(opts({ config: config({ ghost: '/nonexistent/tade' }) }))
      expect(ws.projects[0]?.name).toBe('ghost')
      expect(ws.warnings).toHaveLength(1)
    })

    it('worktree pointing at a deleted directory → failed', async () => {
      const r = mkrepo()
      const wt = r.addTask('deleted', { project: 'app' })
      rmSync(wt, { recursive: true, force: true })
      const ws = await collectStatus(opts({ config: config({ app: r.root }), tadeHome: r.home }))
      expect(task(ws, 'app/deleted')).toMatchObject({ state: 'failed', reason: 'worktree missing' })
      expect(ws.warnings.some((w) => w.includes('worktree directory is missing'))).toBe(true)
    })

    it('task.yaml with the wrong shape', async () => {
      const r = mkrepo()
      r.addTask('bad', { project: 'app', rawTaskYaml: 'project: [1, 2]\ncreated: never\n' })
      r.addTask('worse', { project: 'app', rawTaskYaml: 'intent_spoken: "unterminated\n' })
      const ws = await collectStatus(opts({ config: config({ app: r.root }), tadeHome: r.home }))
      expect(task(ws, 'app/bad')?.state).toBe('queued')
      expect(task(ws, 'app/worse')?.state).toBe('queued')
      expect(ws.warnings.filter((w) => w.includes('task.yaml'))).toHaveLength(2)
    })

    it('unreadable transcripts directory', async () => {
      const home = tmp('tade-home-')
      writeFileSync(join(home, '.claude'), 'not a directory')
      const ws = await collectStatus(opts({ config: config({}), home }))
      expect(ws.projects).toEqual([])
    })
  })

  it('uses the enclosing repo as the project when none are configured', async () => {
    const r = mkrepo()
    const wt = r.addTask('implicit', { project: 'repo' })
    const ws = await collectStatus(opts({ config: config({}), cwd: wt, tadeHome: r.home }))
    expect(ws.projects.map((p) => [p.name, p.root])).toEqual([['repo', r.root]])
    expect(ws.projects[0]?.tasks[0]?.id).toBe('repo/implicit')
  })

  // Ten of these, and each one shells out to git several times over a real
  // repository — about three seconds with the machine to itself. The default
  // budget is ten, which sounds generous and is not: the suite runs its files
  // side by side, so this one is asking for git while two hundred others are
  // asking for git, and the answer arrives when it arrives. Timing out then
  // reads as a hang in `collectStatus` and is nothing of the sort, which is
  // what this test did. The number is for the machine, not for the work, so it
  // is loose on purpose — what this test is about is the answer, not the clock.
  it('is idempotent: repeated runs produce identical output', async () => {
    const r = mkrepo()
    r.addTask('a', { project: 'app' })
    const b = r.addTask('b', { project: 'app' })
    r.commit('x', undefined, b)
    const o = opts({ config: config({ app: r.root }), tadeHome: r.home })
    const first = JSON.stringify(await collectStatus(o))
    for (let i = 0; i < 9; i++) expect(JSON.stringify(await collectStatus(o))).toBe(first)
  }, 60_000)
})
