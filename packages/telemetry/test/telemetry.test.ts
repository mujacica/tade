import type { WilcoEvent } from '@wilco/core'
import { describe, expect, it } from 'vitest'
import { reporterConformance } from '../src/conformance.ts'
import { noReporter } from '../src/none.ts'
import { openReporter, saw } from '../src/open.ts'
import { sentryReporter } from '../src/sentry.ts'
import {
  about,
  envelope,
  framesOf,
  fromEvent,
  readDsn,
  scrub,
  shapeOf,
  troubleEvent,
} from '../src/shape.ts'

// What Wilco sends about itself. Nothing here reaches a network: every send is
// answered here, and what would have gone on the wire is read as text.

const DSN = 'https://abc123@o1.ingest.sentry.io/4507'
const HOME = '/Users/someone'

reporterConformance('sentry', sentryReporter, { dsn: DSN })
reporterConformance('none', () => noReporter(), { dsn: DSN })

/** A Sentry that keeps what it was sent, in the order it arrived. */
function sentry(status = 200, headers: Record<string, string> = {}) {
  const sent: { url: string; auth: string; items: Record<string, unknown>[] }[] = []
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const lines = String(init?.body ?? '')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    sent.push({
      url: String(url),
      auth: String((init?.headers as Record<string, string>)?.['x-sentry-auth'] ?? ''),
      items: lines,
    })
    return new Response('', { status, headers })
  }) as typeof fetch
  return { fetcher, sent }
}

const event = (over: Partial<WilcoEvent> = {}): WilcoEvent => ({
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
    // A Sentry of your own, behind a path.
    expect(readDsn('https://k@sentry.acme.internal/inner/42')?.url).toBe(
      'https://sentry.acme.internal/inner/api/42/envelope/',
    )
    expect(readDsn('https://sentry.io/4507')).toBeNull()
    expect(readDsn('https://abc@sentry.io/')).toBeNull()
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

  it('sends only the few details that are Wilco’s own words, never anybody’s text', () => {
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
          message: `could not read ${HOME}/.wilco/config.yaml`,
        },
        HOME,
      ),
    ).toEqual({
      reason: 'tests failed twice',
      code: 1,
      stopped: true,
      message: 'could not read ~/.wilco/config.yaml',
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
  it('makes Wilco’s own warnings issues, grouped by what they say rather than what they name', () => {
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
      where: 'wilco',
      level: 'warning',
      fingerprint: [
        'wilco',
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
    expect(spend.measures).toEqual([
      {
        at: Date.parse('2026-09-16T09:00:00.000Z'),
        name: 'wilco.tokens',
        kind: 'distribution',
        value: 1200,
        unit: 'token',
        about: { by: 'agent', model: 'opus' },
      },
      {
        at: Date.parse('2026-09-16T09:00:00.000Z'),
        name: 'wilco.cost',
        kind: 'distribution',
        value: 0.42,
        unit: 'usd',
        about: { by: 'agent', model: 'opus' },
      },
    ])
    const failed = fromEvent(
      event({ type: 'failed', detail: { reason: 'the model refused' } }),
      HOME,
    )
    expect(failed.trouble).toBeUndefined()
    expect(failed.note?.level).toBe('error')
    expect(failed.measures?.[0]).toMatchObject({ name: 'wilco.failed', kind: 'counter', value: 1 })
  })
})

describe('what a crash looks like', () => {
  it('is its stack, oldest first, with what is not Wilco’s marked and no home in it', () => {
    const stack = [
      'TypeError: cannot read properties of undefined',
      `    at draw (${HOME}/wilco/packages/app/src/view.ts:120:7)`,
      `    at Object.tick (${HOME}/wilco/node_modules/pi-tui/index.js:9:1)`,
      '    at node:internal/process/task_queues:95:5',
    ].join('\n')
    expect(framesOf(stack, HOME)).toEqual([
      { filename: 'node:internal/process/task_queues', lineno: 95, colno: 5, in_app: false },
      {
        filename: '~/wilco/node_modules/pi-tui/index.js',
        function: 'Object.tick',
        lineno: 9,
        colno: 1,
        in_app: false,
      },
      {
        filename: '~/wilco/packages/app/src/view.ts',
        function: 'draw',
        lineno: 120,
        colno: 7,
        in_app: true,
      },
    ])
  })

  it('is an event with where it happened, what it was about, and the version it happened in', () => {
    const error = new Error('it fell over')
    error.stack = `Error: it fell over\n    at draw (${HOME}/wilco/packages/app/src/view.ts:1:1)`
    const payload = troubleEvent(
      { error, where: 'the window', task: 'app/refunds', project: 'app', level: 'error' },
      {
        release: '9.9.9',
        environment: 'laptop',
        home: HOME,
        trace: 'a'.repeat(32),
        now: 1_000,
        id: 'b'.repeat(32),
      },
    )
    expect(payload).toMatchObject({
      event_id: 'b'.repeat(32),
      timestamp: 1,
      level: 'error',
      release: '9.9.9',
      environment: 'laptop',
      tags: { where: 'the window', task: 'app/refunds', project: 'app' },
    })
    const values = (payload.exception as { values: { value: string }[] }).values
    expect(values[0]?.value).toBe('it fell over')
    // Nothing that has no stack is dropped: it is said instead.
    const said = troubleEvent(
      { error: 'the driver would not start', where: 'wilco' },
      {
        release: '9.9.9',
        environment: 'laptop',
        home: HOME,
        trace: 'a'.repeat(32),
        now: 1_000,
        id: 'c'.repeat(32),
      },
    )
    expect(said.message).toEqual({ formatted: 'wilco: the driver would not start' })
  })
})

describe('sending', () => {
  const opened = (fetcher: typeof fetch, over: Record<string, unknown> = {}) =>
    openReporter(
      {
        driver: 'sentry',
        dsn: DSN,
        errors: true,
        logs: true,
        metrics: true,
        environment: 'test',
        ...over,
      },
      { release: '9.9.9', home: HOME, fetch: fetcher, everyMs: 10_000 },
    )

  it('posts an envelope Sentry can read, signed with the key from the DSN', async () => {
    const { fetcher, sent } = sentry()
    const reporter = opened(fetcher)
    reporter.trouble({ error: new Error('boom'), where: 'the window' })
    reporter.note({
      at: 1_000,
      level: 'info',
      said: 'run_started app/refunds',
      about: { task: 'app/refunds' },
    })
    reporter.measure({ at: 1_000, name: 'wilco.agents', kind: 'gauge', value: 2 })
    await reporter.flush()

    expect(sent[0]?.url).toBe('https://o1.ingest.sentry.io/api/4507/envelope/')
    expect(sent[0]?.auth).toContain('sentry_key=abc123')
    expect(sent[0]?.auth).toContain('sentry_client=wilco/9.9.9')
    // The crash goes on its own, then the lines and numbers together.
    expect(sent[0]?.items[1]).toMatchObject({ type: 'event' })
    expect(sent[1]?.items.map((item) => item.type)).toEqual([
      undefined,
      'log',
      undefined,
      'trace_metric',
      undefined,
    ])
    const logs = sent[1]?.items[2] as {
      items: { body: string; attributes: Record<string, unknown> }[]
    }
    expect(logs.items[0]).toMatchObject({
      body: 'run_started app/refunds',
      level: 'info',
      attributes: {
        task: { value: 'app/refunds', type: 'string' },
        'sentry.release': { value: '9.9.9', type: 'string' },
      },
    })
    const metrics = sent[1]?.items[4] as { items: { name: string; value: number; type: string }[] }
    expect(metrics.items[0]).toMatchObject({ name: 'wilco.agents', value: 2, type: 'gauge' })
    await reporter.close()
  })

  it('sends the same trouble once a minute, however often it happens', async () => {
    const { fetcher, sent } = sentry()
    let clock = 1_000
    const reporter = openReporter(
      { driver: 'sentry', dsn: DSN, errors: true, logs: false, metrics: false },
      { release: '9.9.9', home: HOME, fetch: fetcher, now: () => clock, everyMs: 10_000 },
    )
    for (let i = 0; i < 5; i++) {
      reporter.trouble({
        error: new Error('the same thing'),
        where: 'the window',
        fingerprint: ['x'],
      })
    }
    await reporter.flush()
    expect(sent).toHaveLength(1)
    clock += 61_000
    reporter.trouble({
      error: new Error('the same thing'),
      where: 'the window',
      fingerprint: ['x'],
    })
    await reporter.flush()
    expect(sent).toHaveLength(2)
    await reporter.close()
  })

  it('waits when Sentry says to, and never grows without end', async () => {
    const { fetcher, sent } = sentry(429, { 'retry-after': '120' })
    let clock = 1_000
    const reporter = openReporter(
      { driver: 'sentry', dsn: DSN, errors: false, logs: true, metrics: false },
      { release: '9.9.9', home: HOME, fetch: fetcher, now: () => clock, everyMs: 10_000 },
    )
    reporter.note({ at: clock, level: 'info', said: 'one' })
    await reporter.flush()
    expect(sent).toHaveLength(1)
    // Told to wait two minutes: nothing goes until then, and what piles up is bounded.
    for (let i = 0; i < 2_000; i++) reporter.note({ at: clock, level: 'info', said: `line ${i}` })
    await reporter.flush()
    expect(sent).toHaveLength(1)
    clock += 121_000
    await reporter.flush()
    expect(sent).toHaveLength(2)
    const lines = sent[1]?.items[2] as { items: unknown[] }
    expect(lines.items.length).toBeLessThanOrEqual(500)
    await reporter.close()
  })

  it('is off unless it is told where to send', () => {
    expect(
      openReporter(
        { driver: 'sentry', dsn: '', errors: true, logs: true, metrics: true },
        { release: '1', home: HOME },
      ).on,
    ).toBe(false)
    expect(
      openReporter(
        { driver: 'none', dsn: DSN, errors: true, logs: true, metrics: true },
        { release: '1', home: HOME },
      ).on,
    ).toBe(false)
    expect(
      openReporter(
        { driver: 'sentry', dsn: 'nonsense', errors: true, logs: true, metrics: true },
        { release: '1', home: HOME },
      ).on,
    ).toBe(false)
  })

  it('reports a journal event as whatever it is worth, and nothing when it is worth nothing', async () => {
    const { fetcher, sent } = sentry()
    const reporter = opened(fetcher)
    saw(reporter, event({ type: 'said', detail: { text: 'fix the charge' } }), HOME)
    saw(
      reporter,
      event({ type: 'warning', task: null, detail: { message: 'tmux is not installed' } }),
      HOME,
    )
    saw(reporter, event({ type: 'run_started' }), HOME)
    await reporter.flush()
    expect(sent).toHaveLength(2)
    const issue = sent[0]?.items[2] as { message?: { formatted: string }; level: string }
    expect(issue.message?.formatted).toBe('wilco: tmux is not installed')
    expect(issue.level).toBe('warning')
    await reporter.close()
  })
})

describe('the envelope', () => {
  it('is a header, then each item with the length of what follows', () => {
    const text = envelope({ dsn: DSN }, [{ header: { type: 'event' }, payload: { a: 1 } }])
    const lines = text.trim().split('\n')
    expect(JSON.parse(lines[0] ?? '')).toEqual({ dsn: DSN })
    expect(JSON.parse(lines[1] ?? '')).toEqual({ type: 'event', length: 7 })
    expect(lines[2]).toBe('{"a":1}')
    expect(text.endsWith('\n')).toBe(true)
  })
})
