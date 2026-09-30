import { fileURLToPath } from 'node:url'
import type { TadeEvent } from '@tade/core'
import { afterEach, describe, expect, it } from 'vitest'
import { reporterConformance } from '../src/conformance.ts'
import { noReporter } from '../src/none.ts'
import { openReporter, saw, watchProcess } from '../src/open.ts'
import type { Reporter, Trouble } from '../src/port.ts'
import { sentryReporter } from '../src/sentry.ts'
import { about, fromEvent, readDsn, scrub, shapeOf } from '../src/shape.ts'

// What Tade sends about itself. Nothing reaches a network: the SDK is given
// somewhere else to put its envelopes, and what would have gone on the wire is
// read back here.
//
// One at a time: the SDK has one client per process, so a reporter is closed
// before the next is opened.

const DSN = 'https://abc123@o1.ingest.sentry.io/4507'
const HOME = '/Users/someone'
const ROOT = fileURLToPath(new URL('..', import.meta.url))

reporterConformance('sentry', sentryReporter, { dsn: DSN })
reporterConformance('none', async () => noReporter(), { dsn: DSN })

const event = (over: Partial<TadeEvent> = {}): TadeEvent => ({
  seq: 1,
  ts: '2026-09-16T09:00:00.000Z',
  type: 'task_created',
  urgency: 'notable',
  task: 'app/refunds',
  lane: null,
  run: null,
  detail: {},
  ...over,
})

describe('where it is sent', () => {
  it('reads a DSN, and refuses what is not one', () => {
    expect(readDsn(DSN)).toEqual({
      url: 'https://o1.ingest.sentry.io/api/4507/envelope/',
      key: 'abc123',
      project: '4507',
    })
    expect(readDsn('https://k@sentry.acme.internal/inner/42')?.url).toBe(
      'https://sentry.acme.internal/inner/api/42/envelope/',
    )
    expect(readDsn('https://sentry.io/4507')).toBeNull()
    expect(readDsn('not a url')).toBeNull()
    expect(readDsn('')).toBeNull()
  })
})

describe('what is never sent', () => {
  it('takes the machine’s own paths and anything credential-shaped out', () => {
    expect(scrub(`${HOME}/src/shop/charge.ts failed`, HOME)).toBe('~/src/shop/charge.ts failed')
    expect(scrub('token=sntrys_abcdefghijklmnop rejected', HOME)).toBe('… rejected')
    expect(scrub('used ghp_0123456789abcdefghij', HOME)).toBe('used …')
  })

  it('takes out a key somebody pasted into Tade, whoever issued it', () => {
    // Tade now holds keys for anything that asks for one — a judge, a forge,
    // Sentry — so the last net under the allow-list has to catch a shape it
    // was never told about, not a list of the issuers we knew on the day.
    const keys = [
      'tsk_9f8e7d6c5b4a3210fedcba98',
      'sk-proj-0123456789abcdefghijklmn',
      'sntryu_0123456789abcdefghij',
      'ghp_0123456789abcdefghijklmnopqrstuv',
    ]
    for (const key of keys) {
      expect(scrub(`the judge refused ${key} at 401`, HOME)).not.toContain(key)
      expect(about({ message: `the judge refused ${key} at 401` }, HOME).message).not.toContain(key)
      const sent = fromEvent(
        event({ type: 'warning', detail: { message: `could not ask the judge: ${key} expired` } }),
        HOME,
      )
      expect(JSON.stringify(sent)).not.toContain(key)
    }
    // And a key under a detail nobody allow-listed is not sent at all, whole
    // or scrubbed: `key` is not in KEPT, so it never reaches the net above.
    expect(about({ key: 'tsk_9f8e7d6c5b4a3210fedcba98', code: 401 }, HOME)).toEqual({ code: 401 })
  })

  it('sends only the few details that are Tade’s own words, never anybody’s text', () => {
    expect(
      about(
        {
          intent_spoken: 'stop double charging people on retries',
          title: 'fix the double charge',
          summary: 'it was the retry',
          prompt: 'do the thing',
          reason: 'tests failed twice',
          code: 1,
          stopped: true,
          message: `could not read ${HOME}/.tade/config.yaml`,
        },
        HOME,
      ),
    ).toEqual({
      reason: 'tests failed twice',
      code: 1,
      stopped: true,
      message: 'could not read ~/.tade/config.yaml',
    })
  })

  it('says nothing at all about what you said, or about lane output', () => {
    expect(fromEvent(event({ type: 'said', detail: { text: 'fix the charge' } }), HOME)).toEqual({})
    expect(
      fromEvent(event({ type: 'output', urgency: 'trace', detail: { bytes: 90 } }), HOME),
    ).toEqual({})
  })

  it('keeps names, which is what makes an issue worth reading', () => {
    const { note } = fromEvent(
      event({ type: 'task_created', detail: { intent_spoken: 'the words', by: 'orchestrator' } }),
      HOME,
    )
    expect(note?.said).toBe('task_created app/refunds')
    expect(note?.about).toEqual({
      type: 'task_created',
      task: 'app/refunds',
      project: 'app',
      by: 'orchestrator',
    })
  })
})

describe('what a journal event is worth', () => {
  it('makes Tade’s own warnings issues, grouped by what they say rather than what they name', () => {
    const { trouble } = fromEvent(
      event({
        type: 'warning',
        task: null,
        detail: {
          message: 'workspace.driver is tmux, and tmux is not installed. Using pty instead.',
        },
      }),
      HOME,
    )
    expect(trouble).toMatchObject({
      where: 'tade',
      level: 'warning',
      fingerprint: [
        'tade',
        'warning',
        'workspace.driver is tmux, and tmux is not installed. using pty instead.',
      ],
    })
    // Two of the same, said about different things, are one issue.
    expect(shapeOf(`could not read ${HOME}/a/b.yaml after 3 tries`)).toBe(
      shapeOf('could not read /var/tmp/x.yaml after 12 tries'),
    )
  })

  it('counts what an agent spent, and what failed, without making issues of them', () => {
    const spend = fromEvent(
      event({ type: 'usage', detail: { tokens: 1200, usd: 0.42, by: 'agent', model: 'opus' } }),
      HOME,
    )
    expect(spend.trouble).toBeUndefined()
    expect(spend.measures?.map((one) => [one.name, one.value, one.unit])).toEqual([
      ['tade.tokens', 1200, 'token'],
      ['tade.cost', 0.42, 'usd'],
    ])
    const failed = fromEvent(
      event({ type: 'failed', detail: { reason: 'the model refused' } }),
      HOME,
    )
    expect(failed.trouble).toBeUndefined()
    expect(failed.note?.level).toBe('error')
    expect(failed.measures?.[0]).toMatchObject({ name: 'tade.failed', kind: 'counter', value: 1 })
  })

  it('splits what it counts by project, and never by task', () => {
    // A task id is a slug made from the title somebody wrote: unbounded as a
    // series, and the one thing about the work that is not Tade's to send.
    const seen = fromEvent(event({ type: 'run_started', detail: { adapter: 'pi' } }), HOME)
    const about = seen.measures?.[0]?.about ?? {}
    expect(about.project).toBe('app')
    expect(about.task).toBeUndefined()
    expect(Object.values(about)).not.toContain('app/refunds')
  })

  it('says which harness a run was in, in the word every other metric uses', () => {
    const seen = fromEvent(
      event({
        type: 'run_started',
        detail: { adapter: 'pi', model: 'opus', cwd: '/Users/someone/w' },
      }),
      HOME,
    )
    expect(seen.measures?.[0]).toMatchObject({ name: 'tade.agent.runs', kind: 'counter', value: 1 })
    expect(seen.measures?.[0]?.about).toMatchObject({ harness: 'pi', model: 'opus' })
    // `cwd` is a path, and paths are nobody's business even scrubbed.
    expect(seen.measures?.[0]?.about?.cwd).toBeUndefined()
  })

  it('never makes a dimension of anything somebody wrote', () => {
    // `because` is a written sentence. As a dimension it would make a new
    // series every time somebody worded a hold differently.
    const held = fromEvent(
      event({ type: 'queue_held', detail: { because: 'the tests it waits on went red' } }),
      HOME,
    )
    expect(held.measures?.[0]?.about?.because).toBeUndefined()
    // It still reaches the line beside it, which is where prose belongs.
    expect(held.note?.about?.because).toBe('the tests it waits on went red')
  })

  it('counts a commit and how big it was, and whether it said whose it was', () => {
    const seen = fromEvent(
      event({
        type: 'commit_seen',
        detail: { sha: 'abc', attributed: true, added: 40, removed: 7, files: 3 },
      }),
      HOME,
    )
    expect(seen.measures?.map((one) => [one.name, one.value])).toEqual([
      ['tade.commits', 1],
      ['tade.lines.added', 40],
      ['tade.lines.removed', 7],
      ['tade.files.changed', 3],
    ])
    expect(seen.measures?.[0]?.about).toMatchObject({ attributed: true, project: 'app' })
    // The sha names a commit in somebody's repository: counted, never sent.
    expect(seen.measures?.[0]?.about?.sha).toBeUndefined()
  })

  it('counts a check run per check, and times only one that finished', () => {
    const ran = fromEvent(
      event({
        type: 'check_ran',
        detail: {
          run: 'a:types:here:0',
          check: 'types',
          state: 'failed',
          required: true,
          ms: 4200,
        },
      }),
      HOME,
    )
    expect(ran.measures?.map((one) => one.name)).toEqual(['tade.check.runs', 'tade.check.ms'])
    expect(ran.measures?.[0]?.about).toMatchObject({
      check: 'types',
      state: 'failed',
      required: true,
    })
    const unfinished = fromEvent(
      event({ type: 'check_ran', detail: { run: 'b', check: 'types', state: 'cancelled' } }),
      HOME,
    )
    expect(unfinished.measures?.map((one) => one.name)).toEqual(['tade.check.runs'])
  })

  it('keeps priced money and estimated money apart', () => {
    // pi prices each turn against its own catalog; Claude Code estimates. A
    // chart that sums the two without saying so reports a number nobody can
    // defend.
    const exact = fromEvent(
      event({ type: 'usage', detail: { usd: 1, tokens: 10, by: 'agent', priced: 'exact' } }),
      HOME,
    )
    expect(exact.measures?.[0]?.about).toMatchObject({ priced: 'exact' })
    const guessed = fromEvent(
      event({ type: 'usage', detail: { usd: 1, tokens: 10, by: 'agent', priced: 'estimate' } }),
      HOME,
    )
    expect(guessed.measures?.[0]?.about).toMatchObject({ priced: 'estimate' })
  })

  it('declares no dimension the allow-list would throw away', () => {
    // A dimension read from a detail key that `KEPT` drops is a dimension that
    // silently does nothing — the same defect as a config key with no reader,
    // and invisible because the metric still arrives, just flat.
    const written: Record<string, Record<string, string | number | boolean>> = {
      run_started: { adapter: 'pi', model: 'opus', approvals: 'policy' },
      turn_done: { status: 'ok' },
      tool_call: { tool: 'Bash', tier: 'hard', approved: 'automatically' },
      permission_granted: { tool: 'Bash', tier: 'soft' },
      permission_denied: { tool: 'Bash', tier: 'hard' },
      task_done: { by: 'agent', rule: 'said' },
      queue_held: { start: 'failed' },
      queue_started: { reopened: true },
      check_ran: {
        check: 'types',
        state: 'passed',
        required: true,
        where: 'here',
        runner: 'local',
      },
      commit_seen: { attributed: true },
    }
    for (const [type, detail] of Object.entries(written)) {
      const seen = fromEvent(event({ type: type as TadeEvent['type'], detail }), HOME)
      const about = seen.measures?.[0]?.about ?? {}
      for (const key of Object.keys(detail)) {
        // `adapter` is the one that is renamed on the way out.
        expect(about[key === 'adapter' ? 'harness' : key], `${type}.${key}`).toBeDefined()
      }
    }
  })

  it('counts nothing for a run that ended, because an exit is what goes missing', () => {
    // The journal behind `runtime.ts` had 100 `run_started` and 35
    // `run_exited`: a duration counted here would lose two runs in three.
    expect(
      fromEvent(event({ type: 'run_exited', detail: { code: 0 } }), HOME).measures,
    ).toBeUndefined()
  })
})

/** Everything the SDK would have sent, as items of `[header, payload]`. */
function items(sent: unknown[]): { type: string; payload: Record<string, unknown> }[] {
  return sent.flatMap((envelope) => {
    const [, list] = envelope as [unknown, [Record<string, unknown>, Record<string, unknown>][]]
    return list.map(([header, payload]) => ({ type: String(header.type), payload }))
  })
}

describe('sending', () => {
  let reporter: Reporter | null = null

  afterEach(async () => {
    await reporter?.close()
    reporter = null
  })

  const open = async (over: Record<string, unknown> = {}, sink?: (e: unknown) => void) => {
    reporter = await openReporter(
      {
        driver: 'sentry',
        dsn: DSN,
        errors: true,
        logs: true,
        metrics: true,
        traces: 1,
        agents: true,
        environment: 'test',
        ...over,
      },
      { release: 'tade@9.9.9', home: HOME, root: ROOT, ...(sink ? { sink } : {}) },
    )
    return reporter
  }

  it('sends a crash as an issue, with where it happened and nothing of whose machine it was', async () => {
    const sent: unknown[] = []
    const report = await open({}, (envelope) => sent.push(envelope))
    report.trouble({
      error: new Error(`it fell over reading ${HOME}/.tade/config.yaml`),
      where: 'the window',
      task: 'app/refunds',
      project: 'app',
      about: { driver: 'pty' },
    })
    await report.flush(1_000)

    const issue = items(sent).find((item) => item.type === 'event')?.payload as {
      tags: Record<string, string>
      release: string
      environment: string
      contexts: { tade?: Record<string, unknown> }
      exception: { values: { value: string; stacktrace: { frames: Record<string, unknown>[] } }[] }
    }
    expect(issue.tags).toMatchObject({ where: 'the window', task: 'app/refunds', project: 'app' })
    expect(issue.release).toBe('tade@9.9.9')
    expect(issue.environment).toBe('test')
    expect(issue.contexts.tade).toMatchObject({ driver: 'pty' })
    expect(issue.exception.values[0]?.value).toBe('it fell over reading ~/.tade/config.yaml')
    // The frames are Tade's own, with the lines around them to read.
    const own = issue.exception.values[0]?.stacktrace.frames.filter((frame) => frame.in_app) ?? []
    expect(own.length).toBeGreaterThan(0)
    expect(own.at(-1)?.context_line).toBeTruthy()
    expect(JSON.stringify(sent)).not.toContain(HOME)
  })

  it('keeps the lines of Tade’s own files, and of nobody else’s', async () => {
    const sent: unknown[] = []
    const report = await open({}, (envelope) => sent.push(envelope))
    // Thrown from inside a dependency: its source is not Tade's to send.
    await new Promise<void>((done) => {
      setTimeout(() => {
        report.trouble({ error: new Error('from somewhere else'), where: 'a timer' })
        done()
      }, 1)
    })
    await report.flush(1_000)
    const issue = items(sent).find((item) => item.type === 'event')?.payload as {
      exception: { values: { stacktrace: { frames: Record<string, unknown>[] } }[] }
    }
    for (const frame of issue.exception.values[0]?.stacktrace.frames ?? []) {
      if (frame.in_app !== true) expect(frame.context_line).toBeUndefined()
    }
  })

  it('times what an agent does as the work of a model, whatever else it is told to time', async () => {
    const sent: unknown[] = []
    // Tade's own work is not timed at all here; an agent's turn still is.
    const report = await open({ traces: 0, agents: true }, (envelope) => sent.push(envelope))
    const turn = report.doing({
      name: 'invoke_agent app/refunds',
      op: 'gen_ai.invoke_agent',
      attributes: { 'gen_ai.agent.name': 'app/refunds', 'gen_ai.request.model': 'opus' },
      startedAt: Date.now() - 4_000,
    })
    turn.inside({ name: 'execute_tool bash', op: 'gen_ai.execute_tool' }).end()
    turn.about({ 'gen_ai.usage.total_tokens': 1200 })
    turn.end()
    report.doing({ name: 'a status poll', op: 'tade.poll' }).end()
    await report.flush(1_000)

    const all = items(sent)
    const transaction = all.find((item) => item.type === 'transaction')?.payload as {
      transaction: string
      contexts: { trace: { op: string; data: Record<string, unknown> } }
      start_timestamp: number
      timestamp: number
    }
    expect(transaction.transaction).toBe('invoke_agent app/refunds')
    expect(transaction.contexts.trace.op).toBe('gen_ai.invoke_agent')
    expect(transaction.contexts.trace.data).toMatchObject({
      'gen_ai.agent.name': 'app/refunds',
      'gen_ai.request.model': 'opus',
      'gen_ai.usage.total_tokens': 1200,
    })
    expect(transaction.timestamp - transaction.start_timestamp).toBeGreaterThan(3)
    // The poll was not timed, and its name is nowhere.
    expect(JSON.stringify(sent)).not.toContain('a status poll')
  })

  it('sends no line at all when it was not asked for logs', async () => {
    // `beforeSendLog` is the whole of this gate since Sentry 11 took away the
    // option that used to stop a log being built in the first place, so the
    // thing worth holding is the wire: nothing about a note leaves.
    const sent: unknown[] = []
    const report = await open({ logs: false }, (envelope) => sent.push(envelope))
    report.note({
      at: Date.now(),
      level: 'info',
      said: 'run_started app/refunds',
      about: { task: 'app/refunds' },
    })
    await report.flush(1_000)
    expect(items(sent).some((item) => item.type === 'log')).toBe(false)
    expect(JSON.stringify(sent)).not.toContain('run_started app/refunds')
  })

  it('sends lines to read and numbers to watch', async () => {
    const sent: unknown[] = []
    const report = await open({}, (envelope) => sent.push(envelope))
    report.note({
      at: Date.now(),
      level: 'info',
      said: 'run_started app/refunds',
      about: { task: 'app/refunds' },
    })
    report.measure({ at: Date.now(), name: 'tade.agents', kind: 'gauge', value: 2 })
    await report.flush(1_000)
    const all = items(sent)
    const logs = all.find((item) => item.type === 'log')?.payload as {
      items: { body: string; attributes: Record<string, { value: unknown }> }[]
    }
    expect(logs.items[0]?.body).toBe('run_started app/refunds')
    expect(logs.items[0]?.attributes.task?.value).toBe('app/refunds')
    expect(all.some((item) => item.type.includes('metric'))).toBe(true)
  })

  it('reports a journal event as whatever it is worth, and nothing when it is worth nothing', async () => {
    const sent: unknown[] = []
    const report = await open({}, (envelope) => sent.push(envelope))
    saw(report, event({ type: 'said', detail: { text: 'fix the charge' } }), HOME)
    saw(
      report,
      event({ type: 'warning', task: null, detail: { message: 'tmux is not installed' } }),
      HOME,
    )
    saw(report, event({ type: 'run_started' }), HOME)
    await report.flush(1_000)
    const issue = items(sent).find((item) => item.type === 'event')?.payload as {
      message?: string
      level?: string
    }
    expect(issue.message).toBe('tade: tmux is not installed')
    expect(issue.level).toBe('warning')
    expect(JSON.stringify(sent)).not.toContain('fix the charge')
  })

  it('is off unless it is told where to send', async () => {
    const off = {
      driver: 'sentry',
      errors: true,
      logs: true,
      metrics: true,
      traces: 1,
      agents: true,
    }
    const here = { release: 'tade@9.9.9', home: HOME }
    expect((await openReporter({ ...off, dsn: '' }, here)).on).toBe(false)
    expect((await openReporter({ ...off, dsn: 'nonsense' }, here)).on).toBe(false)
    expect((await openReporter({ ...off, driver: 'none', dsn: DSN }, here)).on).toBe(false)
  })
})

// What Node hands over, and what the window does about it.
//
// TADE-1 is why this is tested at all: the window died of a `TypeError: A
// dynamic import callback was not specified.` — a dynamic `import()` in code
// compiled while Tade ran, in neither Tade nor the terminal library it draws
// with, rejecting on a Node that had no callback for it. It was never a throw
// the drawing could have caught: `import()` returns a promise, so by the time
// anything could go wrong the frame had been drawn. What ended Tade was the
// `throw` in `rejected`, which had it exactly backwards: registering the
// listener is what turns Node's default off, so the line was not passing
// Node's answer along, it was inventing one.

/**
 * Whatever `watchProcess` adds for one event, to be called on its own: the
 * question is what *our* listener does, and emitting the real thing would run
 * vitest's listeners for it too.
 */
function watching(event: 'unhandledRejection' | 'uncaughtException') {
  const listeners = (): unknown[] =>
    event === 'uncaughtException'
      ? (process.listeners('uncaughtException') as unknown[])
      : (process.listeners('unhandledRejection') as unknown[])
  const before = listeners()
  return (): ((reason: unknown) => void) => {
    const mine = listeners().filter((one) => !before.includes(one))
    expect(mine).toHaveLength(1)
    return mine[0] as (reason: unknown) => void
  }
}

/** A reporter that sends nowhere and keeps what it was told, so a test can read it. */
function recording(): { reporter: Reporter; seen: Trouble[] } {
  const seen: Trouble[] = []
  return { seen, reporter: { ...noReporter(), on: true, trouble: (one) => seen.push(one) } }
}

describe('what the process does when something goes wrong', () => {
  it('reports a promise nobody awaited, and leaves the window running', () => {
    const { reporter, seen } = recording()
    const exits: number[] = []
    const rejection = watching('unhandledRejection')
    const stop = watchProcess(reporter, { where: 'the window', exit: (code) => exits.push(code) })
    try {
      const reason = new TypeError('A dynamic import callback was not specified.')
      // The listener throwing is the whole mechanism: Node emits this from
      // inside its own tick, so a throw out of it is an uncaught exception,
      // and an uncaught exception is the window gone.
      expect(() => rejection()(reason)).not.toThrow()
      expect(seen).toEqual([{ error: reason, where: 'the window', level: 'error' }])
      expect(exits).toEqual([])
    } finally {
      stop()
    }
  })

  it('still ends on an uncaught exception, the terminal handed back first', async () => {
    const { reporter, seen } = recording()
    const order: string[] = []
    const crash = watching('uncaughtException')
    const stop = watchProcess(reporter, {
      where: 'the window',
      onFatal: () => {
        order.push('terminal back')
      },
      exit: (code) => order.push(`exit ${code}`),
    })
    try {
      crash()(new Error('the driver went'))
      await new Promise((resolve) => setTimeout(resolve, 0))
      // A crash that left the terminal in raw mode is a crash you cannot read,
      // so the terminal comes back before the exit and before the flush.
      expect(order).toEqual(['terminal back', 'exit 1'])
      expect(seen.map((one) => one.level)).toEqual(['fatal'])
    } finally {
      stop()
    }
  })
})
