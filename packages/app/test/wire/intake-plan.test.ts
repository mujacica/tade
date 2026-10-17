import { type Config, ConfigSchema, type PlanSource } from '@tade/core'
import { ExtensionHost } from '@tade/extensions-core'
import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import type { AppState } from '../../src/model.ts'
import { type Repo, SPAWNING_MS, until, windowUnderTest } from './harness.ts'

// Work from outside on a plan nobody can see yet: the box that runs with nobody
// there, restarted. Nothing reports a plan until an agent has run, and holding
// every request from outside until one did meant nothing ever started. So one
// is let through to make the plan known, and says that is why; any other waits
// for it, with nobody answering; and once the plan is known the ordinary rule
// decides. A harness that can be asked first is asked first. And the plan is
// the one of the sign-in the work would run as, never another one's.

/** Claude Code's own sign-in after a restart: on a plan, and nothing said yet. */
const silent = (): PlanSource => ({
  harness: 'claude-code',
  account: null,
  can: 'while-working',
  pays: 'plan',
  why: 'reports it as one of its agents replies, so there is nothing to show until one has',
  said: null,
})

/** The same sign-in once an agent has said how much of its session window is used. */
const seen = (used: number): PlanSource => ({
  ...silent(),
  said: { at: Date.now(), windows: [{ label: '5h', used, resetsAt: Date.now() + 3_600_000 }] },
})

/** Requests written at this machine, granted to start as the queue says rather than to be proposed. */
const configFor = (root: string): Config =>
  ConfigSchema.parse({
    projects: { app: { root } },
    surfaces: {
      intake: {
        enabled: true,
        sources: { cli: { accept: true, projects: ['app'], from: ['kim'], mode: 'queue' } },
      },
    },
  })

describe('work from outside on a plan nobody can see yet', () => {
  let client: Workbench
  let repo: Repo
  const { start } = windowUnderTest((wired) => {
    client = wired.client
    repo = wired.repo
  })

  /** What the window is told about the plan, and how often it asked. */
  let plan: PlanSource[]
  let asked: number

  /** The source, which says every request still stands. */
  const host = () =>
    ExtensionHost.load({
      builtin: [
        {
          name: 'intake',
          title: 'Intake',
          description: 'Requests from outside.',
          watches: [
            {
              id: 'cli',
              title: 'requests written at this machine',
              means: 'takes in each request in the spool',
              every: '1d',
              intake: 'cli',
              check: async () => ({ found: [] }),
              agent: (finding) => ({ title: finding.title, prompt: 'A request came in.' }),
              recheck: async () => ({ still: true }),
            },
          ],
        },
      ],
      config: { extensions: {}, projects: { app: { root: repo.root } } },
      home: repo.home,
    })

  /** The workbench as the restarted box has it: its plan stood in for, its grant written. */
  function restarted(): void {
    client.config = configFor(repo.root)
    plan = [silent()]
    asked = 0
    client.planUsage = () => plan
    client.askPlans = async () => {
      asked += 1
      return plan
    }
    runsOn('claude-code')
  }

  /**
   * Has the hold read the work as running on `harness`'s own sign-in. The
   * agents a test starts are pi's, the one harness every machine running the
   * suite has, so the sign-in a start would spend is stood in for, as the plan
   * beside it is.
   */
  function runsOn(harness: string): void {
    const asked = Object.getPrototypeOf(client).agentHarness.bind(client)
    client.agentHarness = async (task) => ({ ...(await asked(task)), harness, account: null })
  }

  /** One request handed over through the door a watch uses, made into queued work. */
  async function delivered(id: string): Promise<string> {
    await client.setSchedule(
      {
        id: 'intake-cli',
        name: 'intake cli',
        project: 'app',
        said: '',
        when: { every: '1d' },
        does: { kind: 'watch', watch: 'intake.cli', input: {}, found: 'agent', most: 1 },
        missed: 'skip',
        by: 'you',
        created: '2026-10-17T02:00:00.000Z',
      },
      'you',
    )
    const made = await client.watchFound(
      'intake-cli',
      {
        key: `cli:${id}:1`,
        title: `cli ${id}`,
        intake: {
          source: 'cli',
          externalId: id,
          revision: '1',
          url: `https://example.invalid/${id}`,
          requester: { id: 'kim', label: 'Kim', bot: false },
          from: 'app',
          verbatim: 'the export button 500s when the selection is empty',
          material: { ref: `${id}.0001.json`, hash: 'sha256:aaa' },
          attachments: [],
          sourceAt: '2026-10-17T00:00:00.000Z',
          seenAt: '2026-10-17T00:01:00.000Z',
          correlation: `${id}-1`,
        },
      },
      { agent: { title: `cli ${id}`, prompt: `A request came in from cli (${id}).` } },
    )
    if (!made.task) throw new Error(`that delivery made nothing: ${made.outcome}`)
    return made.task
  }

  const running = (task: string) => client.runs().some((run) => run.task === task)
  /** Started by the queue, which writes why once its agent's lane is up. */
  const started = async (task: string) => (await startedWhy(task)) !== ''

  async function startedWhy(task: string): Promise<string> {
    const [line] = await client.events({ types: ['queue_started'], task })
    return String(line?.detail.why ?? '')
  }

  it('starts the one request there is, learns the plan, then holds the next by the rule', async () => {
    restarted()
    const first = await delivered('req-1')
    await start({ config: configFor(repo.root), extensions: await host() })
    await until('the one request started', () => started(first), SPAWNING_MS)
    // Said where its starting is said: why it went while nothing was known.
    expect(await startedWhy(first)).toContain('claude-code reports it as one of its agents replies')
    expect(await startedWhy(first)).toContain('let through as the one request from outside')

    // Its agent says how full the window is, and it is nearly gone.
    plan = [seen(95)]
    const next = await delivered('req-2')
    await until(
      'the next held on the window',
      async () =>
        String(
          (await client.events({ types: ['queue_held'], task: next }))[0]?.detail.because ?? '',
        ).includes('has used 95% of its 5h window'),
      SPAWNING_MS,
    )
    expect(running(next)).toBe(false)
    // Nothing that could be asked, so nothing was.
    expect(asked).toBe(0)
  })

  it('starts the one request there is, learns the plan, then runs the next by the rule', async () => {
    restarted()
    const first = await delivered('req-1')
    await start({ config: configFor(repo.root), extensions: await host() })
    await until('the one request started', () => started(first), SPAWNING_MS)

    // Known, with room: no longer one at a time, so it starts beside the first.
    plan = [seen(20)]
    const next = await delivered('req-2')
    await until('the next started beside it', () => started(next), SPAWNING_MS)
    expect(running(first)).toBe(true)
    expect(await startedWhy(next)).not.toContain('let through')
  })

  it('runs one of two requests while the plan is unknown, and the other waits for it unheld', async () => {
    restarted()
    const one = await delivered('req-1')
    const two = await delivered('req-2')
    const window = await start({ config: configFor(repo.root), extensions: await host() })
    await until(
      'one of them started',
      async () => (await started(one)) || (await started(two)),
      SPAWNING_MS,
    )
    const [ran, waited] = (await started(one)) ? [one, two] : [two, one]
    const said = () =>
      (window as unknown as { wire: { state: AppState } }).wire.state.transcript.entries.flatMap(
        (entry) =>
          entry.kind === 'tade' && entry.text.startsWith(`${waited} waits: `) ? [entry.text] : [],
      )
    await until('the other said to wait', () => said().length > 0, SPAWNING_MS)
    // Looked at again, and still waiting — said once, however many looks.
    const tools = window.queueTools()
    for (let look = 0; look < 3; look++) await tools.advance()
    expect(running(waited)).toBe(false)
    expect(said()).toHaveLength(1)
    expect(said()[0]).toContain(`this waits for ${ran}`)
    // A wait, not a hold: nobody is asked to answer it.
    expect(await client.events({ types: ['queue_held'], task: waited })).toEqual([])
    expect(await startedWhy(ran)).toContain('let through as the one request from outside')

    // The plan is known, with room, and the one waiting starts with nobody doing anything.
    plan = [seen(20)]
    await until('the other started by itself', () => started(waited), SPAWNING_MS)
  })

  it('runs work on Claude Code as ordinary on a box where Codex cannot say, and never asks Codex', async () => {
    restarted()
    // Claude Code's plan is known and has room. Codex's own sign-in is listed
    // on every machine and has never said anything, as on a box that never
    // runs Codex: read as the plan of every start, it ran these one at a time
    // for good.
    const neverRuns: PlanSource = { ...silent(), harness: 'codex', can: 'anytime', why: null }
    plan = [seen(20), neverRuns]
    const one = await delivered('req-1')
    const two = await delivered('req-2')
    await start({ config: configFor(repo.root), extensions: await host() })
    await until(
      'both started',
      async () => (await started(one)) && (await started(two)),
      SPAWNING_MS,
    )
    expect(await startedWhy(one)).not.toContain('let through')
    expect(await startedWhy(two)).not.toContain('let through')
    // Codex could be asked, and its answer would change nothing about these starts.
    expect(asked).toBe(0)
  })

  it('asks a harness that can be asked before letting anything through, and goes by its answer', async () => {
    restarted()
    // A sign-in that can be asked without running anything, and has not been.
    const askable: PlanSource = { ...silent(), harness: 'codex', can: 'anytime', why: null }
    plan = [askable]
    runsOn('codex')
    client.askPlans = async () => {
      asked += 1
      plan = [{ ...askable, said: seen(96).said }]
      return plan
    }
    const task = await delivered('req-1')
    await start({ config: configFor(repo.root), extensions: await host() })
    await until(
      'held on what it was told',
      async () =>
        String(
          (await client.events({ types: ['queue_held'], task }))[0]?.detail.because ?? '',
        ).includes('codex has used 96% of its 5h window'),
      SPAWNING_MS,
    )
    expect(asked).toBe(1)
    expect(running(task)).toBe(false)
  })
})
