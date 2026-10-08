import { fileURLToPath } from 'node:url'
import { EventType, type TadeEvent } from '@tade/core'
import { afterEach, describe, expect, it } from 'vitest'
import { openReporter, saw } from '../src/open.ts'
import type { Reporter } from '../src/port.ts'
import { about, fromEvent, readDsn, scrub } from '../src/shape.ts'

// The proof that a leak cannot happen, rather than a sample of ones that do
// not. `telemetry.test.ts` is about what Tade *does* send — an issue worth
// reading, a number worth watching; this file is about the other half of the
// promise, which is the one that costs somebody their work if it is broken:
// what you said, what an agent wrote, a task's title, a prompt, a note and a
// credential are never in an envelope, whatever event carries them and
// whatever the event is worth.
//
// So it sweeps: every event type there is, crossed with every key anybody
// writes somebody's words under, through `fromEvent` and then through the
// real reporter with the wire replaced by a list. A key added to the journal
// tomorrow is answered tomorrow, because `KEPT` is a denial with exceptions
// and this is the test of it.

const DSN = 'https://abc123@o1.ingest.sentry.io/4507'
const HOME = '/Users/someone'
const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** A marker nothing else in an envelope could be, so finding it is finding a leak. */
const WORDS = 'ZZ-the-words-somebody-wrote-ZZ'

/**
 * Every key a journal event carries somebody's words under.
 *
 * Read off what Tade writes: `said` and `intent_spoken` are yours verbatim,
 * `title` and `summary` name the work, `prompt`, `context` and `opening` are
 * what an agent was told, `text`, `body` and `note` are what was written
 * about it, and the rest are paths, commands and credentials — a machine's
 * own business. None of them is Tade's to send, and the shape of a leak is
 * always one of them quietly appearing in `KEPT`.
 */
const NOBODY_ELSE_S = [
  'args',
  // The away view's network identifiers and the name somebody gave their own
  // phone. `device` — a 16-hex id Tade minted — is kept and is enough to join
  // two lines together; where that device is, what it is called, and what
  // address or hostname it reached is a fact about somebody's network and
  // somebody's words, and none of it leaves the machine.
  'bind',
  'body',
  'branch',
  'from',
  'host',
  'label',
  'port',
  'command',
  'context',
  'cwd',
  'dsn',
  'file',
  'intent',
  'intent_spoken',
  'input',
  'key',
  'links',
  'note',
  'opening',
  'path',
  'paths',
  'prompt',
  'said',
  'sha',
  'slug',
  'summary',
  'text',
  'title',
  'token',
  'url',
  'worktree',
] as const

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

/** A detail with the marker under every key that is nobody's to send. */
const hostile = (): Record<string, unknown> =>
  Object.fromEntries(NOBODY_ELSE_S.map((key) => [key, `${WORDS} (${key})`]))

describe('what is never sent, whatever carries it', () => {
  it('drops every key that holds somebody’s words, from every event there is', () => {
    for (const type of EventType.options) {
      for (const urgency of ['blocking', 'notable', 'routine'] as const) {
        const sent = fromEvent(event({ type, urgency, detail: hostile() }), HOME)
        expect(JSON.stringify(sent), `${type} (${urgency})`).not.toContain(WORDS)
      }
    }
  })

  it('drops them one at a time too, so no key is only safe in company', () => {
    // The sweep above would still pass if one key leaked and another key's
    // presence happened to change the shape. One at a time is the real claim.
    for (const key of NOBODY_ELSE_S) {
      expect(about({ [key]: WORDS }, HOME), key).toEqual({})
    }
  })

  it('sends only names, counts and flags — never a value with a shape to hide in', () => {
    // `about` is the one door, so what it lets through is the whole surface:
    // a string, a finite number, a boolean. An object or a list would carry
    // whatever was nested in it past every check above.
    const through = about(
      {
        // Allowed keys, with values that are not what an allowed key holds.
        reason: { nested: WORDS },
        message: [WORDS],
        because: null,
        why: undefined,
        code: Number.NaN,
        exit: Number.POSITIVE_INFINITY,
        found: 3,
        stopped: true,
        state: 'failed',
      },
      HOME,
    )
    expect(through).toEqual({ found: 3, stopped: true, state: 'failed' })
    expect(JSON.stringify(through)).not.toContain(WORDS)
  })

  it('cuts what it does send to something a person reads, after it is cleaned', () => {
    // Cleaned first and cut second: a credential past the cut would otherwise
    // be one the cut happened to hide rather than one that was taken out.
    const long = `${'x'.repeat(400)} ghp_0123456789abcdefghijklmnop`
    const said = about({ message: long }, HOME).message
    expect(typeof said === 'string' && said.length).toBeLessThanOrEqual(200)
    expect(String(said)).not.toContain('ghp_')
    const nearby = about({ message: `sntrys_abcdefghijklmnop ${'y'.repeat(400)}` }, HOME).message
    expect(String(nearby)).not.toContain('sntrys_')
  })

  it('takes the machine’s own paths out everywhere they appear, not only the first', () => {
    expect(scrub(`${HOME}/a and ${HOME}/b`, HOME)).toBe('~/a and ~/b')
    // A home nothing could mean is left alone: `/` would turn every path into
    // a row of tildes, which says less than the path did.
    expect(scrub('/etc/hosts', '/')).toBe('/etc/hosts')
    expect(scrub('/etc/hosts', '')).toBe('/etc/hosts')
  })

  it('refuses a DSN that is not one, rather than posting somewhere it was never told about', () => {
    expect(readDsn('ftp://k@host/1')).toBeNull()
    expect(readDsn('file:///tmp/envelopes/1')).toBeNull()
    expect(readDsn('https://o1.ingest.sentry.io/4507')).toBeNull()
    expect(readDsn('https://k@o1.ingest.sentry.io/not-a-number')).toBeNull()
    expect(readDsn(`  ${DSN}  `)?.key).toBe('abc123')
  })
})

describe('what actually reaches the wire', () => {
  let reporter: Reporter | null = null

  afterEach(async () => {
    await reporter?.close()
    reporter = null
  })

  it('carries none of it into an envelope, for any event the journal holds', async () => {
    // The same sweep, through the whole reporter: `fromEvent` deciding right
    // and the SDK sending something else is a leak the pure test cannot see.
    const sent: unknown[] = []
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
      },
      { release: 'tade@9.9.9', home: HOME, root: ROOT, sink: (one) => sent.push(one) },
    )
    for (const type of EventType.options) {
      saw(reporter, event({ type, detail: hostile() }), HOME)
    }
    // And a crash whose message and detail are full of it.
    reporter.trouble({
      error: new Error(`it fell over on ${HOME}/.tade/config.yaml with ${WORDS}`),
      where: 'the window',
      about: { driver: 'pty', reason: WORDS },
    })
    await reporter.flush(2_000)

    const text = JSON.stringify(sent)
    expect(sent.length).toBeGreaterThan(0)
    // The crash's own message is Tade's to send, so the marker in it is
    // expected; nothing that came out of a journal detail is.
    for (const key of NOBODY_ELSE_S) expect(text, key).not.toContain(`${WORDS} (${key})`)
    // And the machine is nobody's business even in the words Tade wrote.
    expect(text).not.toContain(HOME)
  })
})
