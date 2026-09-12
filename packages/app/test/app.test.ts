import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Terminal } from '@earendil-works/pi-tui'
import { ConfigSchema } from '@wilco/core'
import { DaemonClient } from '@wilco/daemon/client'
import { Daemon } from '@wilco/daemon/server'
import { Speaker } from '@wilco/surface-voice'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { App } from '../src/app.ts'

// The window against a real daemon and a real repository. Everything it shows
// is tested elsewhere without a terminal; what is tested here is the wiring —
// that it boots, draws, and that a keystroke reaches it at all.

/**
 * A terminal that keeps what was drawn instead of drawing it, and hands back
 * the callback the TUI registers so a test can press keys.
 */
class FakeTerminal implements Terminal {
  columns = 80
  rows = 24
  kittyProtocolActive = false
  /** Everything written, which is the screen as the user would see it. */
  written = ''
  private onInput: ((data: string) => void) | null = null

  start(onInput: (data: string) => void, _onResize: () => void): void {
    this.onInput = onInput
  }

  /** Press a key, exactly as a terminal would deliver it. */
  press(data: string): void {
    this.onInput?.(data)
  }

  write(data: string): void {
    this.written += data
  }

  stop(): void {}
  async drainInput(): Promise<void> {}
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

/** Wait for something to become true, rather than for a fixed time. */
async function until(what: string, ok: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (ok()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

describe('the window, wired up', () => {
  let repo: ReturnType<typeof mkrepo>
  let home: string
  let daemon: Daemon
  let client: DaemonClient
  let terminal: FakeTerminal
  let app: App | null = null

  beforeEach(async () => {
    repo = mkrepo()
    repo.commit('first')
    repo.addTask('refunds', { project: 'app', intent: 'refunds double-charge on retries' })
    repo.addTask('search', { project: 'app', intent: 'search is slow above ten thousand rows' })
    // A tmp home, so status never reads the real machine's agent transcripts.
    home = tmp('wilco-app-')
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    daemon = await Daemon.start({ home, socket: join(home, 'w.sock') })
    client = await DaemonClient.connect(daemon.socketPath)
    terminal = new FakeTerminal()
  })

  afterEach(async () => {
    await app?.stop().catch(() => {})
    app = null
    await client.close().catch(() => {})
    await daemon.stop().catch(() => {})
  })

  async function start(): Promise<App> {
    const speaker = await Speaker.create({
      soundDir: tmp('wilco-app-sound-'),
      platform: 'darwin',
      // Never actually make a noise in a test run.
      run: async () => {},
    })
    app = await App.start({
      client,
      config: ConfigSchema.parse({ projects: { app: { root: repo.root } } }),
      home,
      cwd: repo.root,
      terminal,
      speaker,
      frameMs: 50,
    })
    return app
  }

  it('boots and draws the tasks it found', async () => {
    await start()
    await until('the tasks to be drawn', () => terminal.written.includes('refunds'))
    expect(terminal.written).toContain('search')
    expect(terminal.written).toContain('app')
  })

  it('always shows the orchestrator', async () => {
    await start()
    // It cannot be closed: it is how you see what Wilco heard.
    await until('the orchestrator strip', () => terminal.written.includes('orchestrator'))
  })

  it('takes a keystroke and opens the dictation line', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.written = ''
    // ctrl+space, as a terminal without the Kitty protocol sends it.
    terminal.press('\x00')
    await until('the dictation line', () => terminal.written.includes('◉'))
  })

  it('holds a line addressed to Wilco rather than typing it at the agent', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.written = ''
    for (const char of 'wilco par') terminal.press(char)
    await until('the held line', () => terminal.written.includes('◌'))
  })

  it('moves between agents on tab', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.written = ''
    terminal.press('\t')
    // The marker has to land somewhere; which task is the model's business.
    await until('a redraw with the focus marker', () => terminal.written.includes('▸'))
  })

  it('stops cleanly, and stopping twice is safe', async () => {
    const started = await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    await started.stop()
    await started.stop()
    // Whoever is waiting on the window is released, or this never resolves.
    await started.wait()
  })
})
