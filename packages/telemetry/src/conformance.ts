import { describe, expect, it } from 'vitest'
import type { MakeReporter, ReporterOptions } from './port.ts'

// The suite every reporter passes. It asserts the promise the port makes —
// that reporting never throws, never blocks, never sends what it was told not
// to, and always answers with a span that can be ended — rather than what any
// one of them puts on a wire.

export interface ReporterConformanceOptions {
  /** Somewhere to send that this reporter accepts. */
  dsn: string
}

export function reporterConformance(
  id: string,
  make: MakeReporter,
  options: ReporterConformanceOptions,
): void {
  const open = (over: Partial<ReporterOptions> = {}) =>
    make({
      dsn: options.dsn,
      release: 'tade@9.9.9',
      environment: 'test',
      errors: true,
      logs: true,
      metrics: true,
      traces: 1,
      agents: true,
      home: '/home/someone',
      sink: () => {},
      ...over,
    })

  describe(`${id} (reporter conformance)`, () => {
    it('says which it is, and whether anything is sent', async () => {
      const reporter = await open()
      expect(reporter.id).toBe(id)
      expect(typeof reporter.on).toBe('boolean')
      await reporter.close()
    })

    it('sends nothing when it has nowhere to send', async () => {
      const nowhere = await open({ dsn: '' })
      expect(nowhere.on).toBe(false)
      nowhere.trouble({ error: new Error('x'), where: 'the suite' })
      await expect(nowhere.flush(100)).resolves.toBeUndefined()
      await nowhere.close()
    })

    it('never throws, whatever it is given', async () => {
      const reporter = await open()
      expect(() => reporter.trouble({ error: new Error('boom'), where: 'the suite' })).not.toThrow()
      expect(() => reporter.trouble({ error: 'a string', where: 'the suite' })).not.toThrow()
      expect(() => reporter.trouble({ error: { odd: true }, where: 'the suite' })).not.toThrow()
      expect(() =>
        reporter.note({ at: Date.now(), level: 'info', said: 'something' }),
      ).not.toThrow()
      expect(() =>
        reporter.measure({ at: Date.now(), name: 'tade.x', kind: 'gauge', value: 1 }),
      ).not.toThrow()
      await reporter.close()
    })

    it('answers with a span that can be ended, whatever it does with it', async () => {
      const reporter = await open()
      const span = reporter.doing({ name: 'something', op: 'tade.test' })
      expect(() => {
        span.about({ task: 'app/refunds' })
        const inside = span.inside({ name: 'inside it', op: 'tade.test.inner' })
        inside.end()
        span.wrong(new Error('it went wrong'))
        span.end()
      }).not.toThrow()
      // Ending a span nobody timed is still nothing to worry about.
      const untimed = (await open({ traces: 0 })).doing({ name: 'x', op: 'tade.test' })
      expect(() => untimed.end()).not.toThrow()
      await reporter.close()
    })

    it('carries on when what it sends to fails, and gives up in time', async () => {
      const angry = await open({
        sink: () => {
          throw new Error('the network is gone')
        },
      })
      angry.trouble({ error: new Error('boom'), where: 'the suite' })
      const started = Date.now()
      await expect(angry.flush(500)).resolves.toBeUndefined()
      expect(Date.now() - started).toBeLessThan(3_000)
      await angry.close()
    })

    it('sends nothing of a kind it was told not to send', async () => {
      const sent: unknown[] = []
      const reporter = await open({
        errors: false,
        logs: false,
        metrics: false,
        traces: 0,
        agents: false,
        sink: (envelope) => sent.push(envelope),
      })
      reporter.trouble({ error: new Error('boom'), where: 'the suite' })
      reporter.note({ at: Date.now(), level: 'info', said: 'something' })
      reporter.measure({ at: Date.now(), name: 'tade.x', kind: 'gauge', value: 1 })
      reporter.doing({ name: 'something', op: 'tade.test' }).end()
      await reporter.flush(500)
      // A session says a Tade ran; nothing it was told not to send is in it.
      const text = JSON.stringify(sent)
      expect(text).not.toContain('boom')
      expect(text).not.toContain('tade.x')
      expect(text).not.toContain('tade.test')
      await reporter.close()
    })

    it('closes without being opened, and twice', async () => {
      const reporter = await open()
      await reporter.close()
      await expect(reporter.close()).resolves.toBeUndefined()
    })
  })
}
