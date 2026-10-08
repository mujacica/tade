import { createServer, get } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ConfigSchema } from '@tade/core'
import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import { type FakeTerminal, type Repo, until, windowUnderTest } from './harness.ts'

// It starts, draws what it found, stops, and reloads. Nothing here is about
// one subject: this is `App` itself — the lifecycle, and the bar along the
// bottom that says what is true while it runs.

describe('the window, booted', () => {
  let terminal: FakeTerminal
  let client: Workbench
  let repo: Repo
  const { start, click, find } = windowUnderTest((wired) => {
    terminal = wired.terminal
    client = wired.client
    repo = wired.repo
  })

  /**
   * Whether anything answers on this port of this machine.
   *
   * A real request, because the question is whether a socket exists: a field
   * on the subject would be the subject's own answer to the thing under test.
   */
  const answers = (port: number): Promise<boolean> =>
    new Promise((done) => {
      const req = get({ host: '127.0.0.1', port, path: '/' }, (res) => {
        res.resume()
        done(true)
      })
      req.on('error', () => done(false))
      req.end()
    })

  /** A port nothing is on: a fixed one is a test about whoever's laptop. */
  const freePort = async (): Promise<number> => {
    const server = createServer()
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
    const port = (server.address() as AddressInfo).port
    await new Promise<void>((done) => server.close(() => done()))
    return port
  }

  it('boots and draws the tasks it found', async () => {
    await start()
    await until('the tasks to be drawn', () => terminal.written.includes('refunds'))
    expect(terminal.written).toContain('search')
    expect(terminal.written).toContain('app')
  })

  it('always shows the orchestrator', async () => {
    await start()
    // It cannot be closed: it is how you see what Tade heard.
    await until('the orchestrator strip', () => terminal.written.includes('orchestrator'))
  })

  it('stops cleanly, and stopping twice is safe', async () => {
    const started = await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    await started.stop()
    await started.stop()
    // Whoever is waiting on the window is released, or this never resolves.
    await started.wait()
  })

  it('reloads when the reload key is pressed and nothing is running', async () => {
    let reloaded = false
    await start({
      reloadWindow: async () => {
        reloaded = true
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.press('\x1b[114;6u')
    await until('reload to be called', () => reloaded)
  })

  it('warns before reloading when lanes cannot survive', async () => {
    await client.openTerminal({ project: 'app' })
    let reloaded = false
    await start({
      reloadWindow: async () => {
        reloaded = true
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.written = ''
    terminal.press('\x1b[114;6u')
    await until('the reload panel', () => terminal.written.includes('Reload Tade?'))
    expect(reloaded).toBe(false)
    // Dismiss the panel so the test ends cleanly.
    terminal.written = ''
    terminal.press('\x1b')
    await until('the panel to close', () => !terminal.written.includes('Reload Tade?'))
  })

  it('listens for nobody while the away view is off, which is the default', async () => {
    // The whole of "off means no listener", at the level somebody would
    // actually be wrong at: the window boots, draws, and nothing is bound.
    // The subject's own tests say it constructs nothing; this says `app.ts`
    // never asked it to.
    const port = await freePort()
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    expect(await answers(port)).toBe(false)
  })

  it('serves the away view where a person turned it on, and it dies with the window', async () => {
    // Loopback, on a port the machine said was free. The listener is the
    // window's: it comes up in `begin` and goes in `stop`, with no reaper, no
    // pidfile and no detached process — which is what makes closing Tade
    // harmless and is the half of the claim only a booted window can make.
    const port = await freePort()
    const started = await start({
      config: ConfigSchema.parse({
        projects: { app: { root: repo.root } },
        surfaces: { web: { enabled: true, port } },
      }),
    })
    await until('the away view to answer', async () => await answers(port))
    await started.stop()
    await until('the away view to have gone', async () => !(await answers(port)))
  })

  it('opens the Spend panel from the status bar', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('today'))
    const status = find('today')
    terminal.written = ''
    click(status.col + 1, status.row)
    // Its own title and its column heads: the sections under them scroll, like
    // every other panel's body, so which of them is in view is the window's size.
    await until('the spend panel', () => terminal.written.includes('WORKING'))
  })

  it('shows agent spend in the status bar', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('today'))
    terminal.written = ''
    await client.log.append({
      type: 'usage',
      task: 'app/refunds',
      detail: { model: 'anthropic/claude-sonnet-5', tokens: 1500, usd: 0.351 },
    })
    await until('agent spend in status bar', () => terminal.written.includes('$0.35'))
  })
})
