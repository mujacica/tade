import { writeFileSync } from 'node:fs'
import { type ClientRequest, request } from 'node:http'
import { join } from 'node:path'
import { ConfigSchema } from '@tade/core'
import { afterEach, describe, expect, it } from 'vitest'
import { COOKIE, freePort, paired } from './away-harness.ts'
import { type FakeTerminal, type Repo, screenOf, until, windowUnderTest } from './harness.ts'

// The away view's chip in the strip at the foot, the whole way through: what
// it says is read off the listener and the streams open on it, a phone opening
// the page is drawn within a beat with nothing else moving, and pressing it goes
// where pairing is — the switch while nothing listens, the code while it does.
//
// **Loopback, on a port the machine said was free**, as every away test is.

describe('the away view, in the strip', () => {
  let terminal: FakeTerminal
  let repo: Repo
  let home: string
  const { start, click, find } = windowUnderTest((wired) => {
    terminal = wired.terminal
    repo = wired.repo
    home = wired.home
  })
  const streams: ClientRequest[] = []
  afterEach(() => {
    for (const one of streams.splice(0)) one.destroy()
  })

  /** The window, over a home whose away view listens on `port` where `enabled`. */
  async function opened(port: number, enabled: boolean): Promise<void> {
    const web = `surfaces:\n  web:\n    port: ${port}\n    enabled: ${enabled}\n`
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n${web}`)
    // Wide and tall enough for the strip to have room for the chip, and for the
    // Settings page to draw the switch it opens on.
    terminal.columns = 160
    terminal.rows = 90
    await start({
      config: ConfigSchema.parse({
        projects: { app: { root: repo.root } },
        surfaces: { web: { port, enabled } },
      }),
    })
  }

  /** Whether the strip at the foot says `said`, on the screen as it stands. */
  const footSays = (said: string) => () =>
    screenOf(terminal.written).some((line) => (line ?? '').includes(said))

  /** A page held open on the stream, the way a phone holds one. */
  function listen(port: number): void {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/stream',
        method: 'GET',
        headers: {
          host: `127.0.0.1:${port}`,
          cookie: COOKIE,
          accept: 'text/event-stream',
          'sec-fetch-site': 'same-origin',
        },
      },
      // Read, as a browser reads one.
      (res) => res.resume(),
    )
    req.on('error', () => {})
    req.end()
    streams.push(req)
  }

  it('says remote off while nothing listens, and opens the switch in Settings', async () => {
    await opened(await freePort(), false)
    await until('the chip', footSays('remote off'))
    const chip = find('remote off')
    click(chip.col + 1, chip.row)
    await until('the away page', footSays('Serve the away view'))
  })

  it('counts a phone opening the page, and opens the pairing panel', async () => {
    const port = await freePort()
    await paired(home, port, ['read'])
    await opened(port, true)
    // Listening, and nobody reading yet: a count it made, not an unknown.
    await until('the listener', footSays('remote 0'))
    listen(port)
    // Drawn by the beat that saw it, with nothing else on screen moving.
    await until('the phone', footSays('remote 1'))
    expect(screenOf(terminal.written).join('\n')).not.toContain('remote off')
    const chip = find('remote 1')
    click(chip.col + 1, chip.row)
    await until('the pairing panel', footSays('AWAY VIEW'))
    expect(footSays('remote 1')()).toBe(true)
    // And a page closed is a page closed, within a beat.
    for (const one of streams.splice(0)) one.destroy()
    await until('the phone gone', footSays('remote 0'))
  })
})
