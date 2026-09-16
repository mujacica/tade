import { describe, expect, it } from 'vitest'
import type { MakeReporter, ReporterOptions } from './port.ts'

// The suite every reporter passes. It asserts the promise the port makes —
// that reporting never throws, never blocks, and never sends what it was told
// not to — rather than what any one of them puts on a wire.

export interface ReporterConformanceOptions {
  /** Somewhere to send that this reporter accepts. */
  dsn: string
  /** Answers instead of a network. The suite must never reach one. */
  fetch?: typeof fetch
}

export function reporterConformance(
  id: string,
  make: MakeReporter,
  options: ReporterConformanceOptions,
): void {
  const offline: typeof fetch = async () => new Response('', { status: 200 })
  const open = (over: Partial<ReporterOptions> = {}) =>
    make({
      dsn: options.dsn,
      release: '9.9.9',
      environment: 'test',
      errors: true,
      logs: true,
      metrics: true,
      home: '/home/someone',
      fetch: options.fetch ?? offline,
      everyMs: 10_000,
      ...over,
    })

  describe(`${id} (reporter conformance)`, () => {
    it('says which it is, and whether anything is sent', () => {
      const reporter = open()
      expect(reporter.id).toBe(id)
      expect(typeof reporter.on).toBe('boolean')
    })

    it('sends nothing when it has nowhere to send', async () => {
      const nowhere = open({ dsn: '' })
      expect(nowhere.on).toBe(false)
      nowhere.trouble({ error: new Error('x'), where: 'the suite' })
      await expect(nowhere.flush(100)).resolves.toBeUndefined()
      await nowhere.close()
    })

    it('never throws, whatever it is given', async () => {
      const reporter = open()
      expect(() => reporter.trouble({ error: new Error('boom'), where: 'the suite' })).not.toThrow()
      expect(() => reporter.trouble({ error: 'a string', where: 'the suite' })).not.toThrow()
      expect(() => reporter.trouble({ error: { odd: true }, where: 'the suite' })).not.toThrow()
      expect(() =>
        reporter.note({ at: Date.now(), level: 'info', said: 'something' }),
      ).not.toThrow()
      expect(() =>
        reporter.measure({ at: Date.now(), name: 'wilco.x', kind: 'gauge', value: 1 }),
      ).not.toThrow()
      await reporter.close()
    })

    it('carries on when what it sends to fails, and gives up in time', async () => {
      const angry: typeof fetch = async () => {
        throw new Error('the network is gone')
      }
      const reporter = open({ fetch: angry })
      reporter.trouble({ error: new Error('boom'), where: 'the suite' })
      await expect(reporter.flush(500)).resolves.toBeUndefined()
      const slow: typeof fetch = () => new Promise(() => {})
      const waiting = open({ fetch: slow })
      waiting.trouble({ error: new Error('boom'), where: 'the suite' })
      const started = Date.now()
      await waiting.flush(50)
      expect(Date.now() - started).toBeLessThan(2_000)
      await reporter.close()
    })

    it('sends nothing of a kind it was told not to send', async () => {
      const sent: string[] = []
      const watching: typeof fetch = async (_url, init) => {
        sent.push(String(init?.body ?? ''))
        return new Response('', { status: 200 })
      }
      const reporter = open({ fetch: watching, errors: false, logs: false, metrics: false })
      reporter.trouble({ error: new Error('boom'), where: 'the suite' })
      reporter.note({ at: Date.now(), level: 'info', said: 'something' })
      reporter.measure({ at: Date.now(), name: 'wilco.x', kind: 'gauge', value: 1 })
      await reporter.flush(500)
      expect(sent).toEqual([])
      await reporter.close()
    })

    it('closes without being opened, and twice', async () => {
      const reporter = open()
      await reporter.close()
      await expect(reporter.close()).resolves.toBeUndefined()
    })
  })
}
