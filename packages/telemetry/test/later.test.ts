import { describe, expect, it } from 'vitest'
import { later } from '../src/later.ts'
import { openReporterLater } from '../src/open.ts'
import type { Reporter, Span, Work } from '../src/port.ts'

// The stand-in a window opens with, so Sentry's SDK is loaded after the first
// frame rather than before it. What it is held to: nothing said before it
// opens is lost or reordered, a span is timed from when it began, and a crash
// before it opened is still sent.

/** A reporter that writes down what it was told, in order. */
function scripted(): { reporter: Reporter; said: string[] } {
  const said: string[] = []
  const span = (name: string): Span => ({
    about: (attributes) => said.push(`${name} about ${JSON.stringify(attributes)}`),
    inside: (work: Work) => {
      said.push(`${name} inside ${work.name} at ${work.startedAt}`)
      return span(work.name)
    },
    wrong: () => said.push(`${name} wrong`),
    end: (at) => said.push(`${name} end at ${at}`),
  })
  return {
    said,
    reporter: {
      id: 'scripted',
      on: true,
      trouble: (trouble) => said.push(`trouble ${trouble.where}`),
      note: (note) => said.push(`note ${note.said}`),
      measure: (measure) => said.push(`measure ${measure.name}`),
      doing: (work) => {
        said.push(`doing ${work.name} at ${work.startedAt}`)
        return span(work.name)
      },
      flush: async () => {
        said.push('flush')
      },
      close: async () => {
        said.push('close')
      },
    },
  }
}

describe('a reporter opened after the window draws', () => {
  it('is nothing at all where nothing would be sent, and loads nothing', async () => {
    let made = 0
    const { reporter, open } = later(
      async () => {
        made++
        return scripted().reporter
      },
      { on: false },
    )
    expect(reporter.on).toBe(false)
    reporter.trouble({ error: new Error('x'), where: 'the window' })
    await open()
    await reporter.close()
    expect(made).toBe(0)
  })

  it('keeps what is said before it opens, and says it in order once it does', async () => {
    const real = scripted()
    const { reporter, open } = later(async () => real.reporter, { on: true })
    reporter.trouble({ error: new Error('x'), where: 'the window' })
    reporter.note({ at: 1, level: 'info', said: 'opened' })
    reporter.measure({ at: 1, name: 'tade.agents', kind: 'gauge', value: 2 })
    expect(real.said).toEqual([])
    expect(reporter.id).toBe('later')
    await open()
    expect(real.said).toEqual(['trouble the window', 'note opened', 'measure tade.agents'])
    expect(reporter.id).toBe('scripted')
    // And straight through from then on.
    reporter.note({ at: 2, level: 'info', said: 'after' })
    expect(real.said.at(-1)).toBe('note after')
  })

  it('times a span from when it began, not from when it was handed over', async () => {
    let now = 100
    const real = scripted()
    const { reporter, open } = later(async () => real.reporter, { on: true, now: () => now })
    const opening = reporter.doing({ name: 'open the window', op: 'tade.open' })
    now = 150
    const inner = opening.inside({ name: 'open the workbench', op: 'tade.workbench' })
    inner.about({ lanes: 3 })
    inner.wrong(new Error('no driver'))
    now = 200
    inner.end()
    now = 300
    opening.end()
    now = 1_000
    await open()
    expect(real.said).toEqual([
      'doing open the window at 100',
      'open the window inside open the workbench at 150',
      'open the workbench about {"lanes":3}',
      'open the workbench wrong',
      'open the workbench end at 200',
      'open the window end at 300',
    ])
    // Once open, a span is the real one's, timed as it is.
    reporter.doing({ name: 'a look', op: 'tade.look' })
    expect(real.said.at(-1)).toBe('doing a look at undefined')
  })

  it('keeps a moment that was said, rather than the moment it was told', async () => {
    const real = scripted()
    const { reporter, open } = later(async () => real.reporter, { on: true, now: () => 500 })
    reporter.doing({ name: 'open the window', op: 'tade.open', startedAt: 42 }).end(99)
    await open()
    expect(real.said).toEqual(['doing open the window at 42', 'open the window end at 99'])
  })

  it('opens on a flush, so a crash before the window drew is still sent', async () => {
    const real = scripted()
    let made = 0
    const { reporter } = later(
      async () => {
        made++
        return real.reporter
      },
      { on: true },
    )
    reporter.trouble({ error: new Error('boom'), where: 'the window', level: 'fatal' })
    await reporter.flush(2_000)
    expect(made).toBe(1)
    expect(real.said).toEqual(['trouble the window', 'flush'])
  })

  it('closes without loading anything when nothing was ever said', async () => {
    let made = 0
    const { reporter } = later(
      async () => {
        made++
        return scripted().reporter
      },
      { on: true },
    )
    await reporter.close()
    expect(made).toBe(0)
  })

  it('opens once, however often it is asked', async () => {
    let made = 0
    const { open } = later(
      async () => {
        made++
        return scripted().reporter
      },
      { on: true },
    )
    await Promise.all([open(), open(), open()])
    expect(made).toBe(1)
  })

  it('is nothing, never a throw, when the reporter behind it cannot be opened', async () => {
    const { reporter, open } = later(() => Promise.reject(new Error('no SDK')), { on: true })
    reporter.trouble({ error: new Error('x'), where: 'the window' })
    const span = reporter.doing({ name: 'x', op: 'tade.test' })
    await expect(open()).resolves.toBeUndefined()
    expect(() => span.end()).not.toThrow()
    await expect(reporter.close()).resolves.toBeUndefined()
  })
})

describe('the window’s reporter, opened late', () => {
  const config = {
    driver: 'sentry',
    errors: true,
    logs: true,
    metrics: true,
    traces: 1,
    agents: true,
    environment: 'test',
  }
  const here = { release: 'tade@9.9.9', home: '/Users/someone', sink: () => {} }

  it('is off without a DSN, and loads nothing to be off', async () => {
    const { reporter } = openReporterLater({ ...config, dsn: ' ' }, here)
    expect(reporter.on).toBe(false)
    expect(reporter.id).toBe('none')
  })

  it('is on with one, and is the reporter that names once it is open', async () => {
    const { reporter, open } = openReporterLater(
      { ...config, dsn: 'https://abc123@o1.ingest.sentry.io/4507' },
      { ...here, now: () => 1 },
    )
    expect(reporter.on).toBe(true)
    await open()
    expect(reporter.id).toBe('sentry')
    await reporter.close()
  })
})
