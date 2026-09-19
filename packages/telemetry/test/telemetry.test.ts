import { fileURLToPath } from 'node:url'
import type { TadeEvent } from '@tade/core'
import { afterEach, describe, expect, it } from 'vitest'
import { reporterConformance } from '../src/conformance.ts'
import { noReporter } from '../src/none.ts'
import { openReporter, saw } from '../src/open.ts'
import type { Reporter } from '../src/port.ts'
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
