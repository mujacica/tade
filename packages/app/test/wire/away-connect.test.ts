import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ConfigSchema } from '@tade/core'
import { CONNECT_OFF } from '@tade/web'
import { describe, expect, it } from 'vitest'
import { type FakeTerminal, type Repo, screenOf, until, windowUnderTest } from './harness.ts'

// Where the guided pages that connect a source are, on Settings › Intake,
// through the whole window: the Away subject is the one that knows whether its
// door is up, Settings draws what it says under the switch every source is
// behind, and Open hands this machine's own address to the desktop — the same
// answer `tade web connect` prints (`@tade/web`'s `connectWhere`). Nothing is
// spawned: the harness records what would have opened.

/** A port nothing is on: `surfaces.web.port` is a person's bookmark, never "whatever is free". */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((done) => server.close(() => done()))
  return port
}

describe('the connect pages, from Settings › Intake', () => {
  let terminal: FakeTerminal
  let repo: Repo
  const wired = windowUnderTest((one) => {
    terminal = one.terminal
    repo = one.repo
  })
  const { start, click, find } = wired
  const screen = () => screenOf(terminal.written)

  /** Settings open on Intake, on the page of the source called `title`. */
  async function onSource(web: Record<string, unknown>, title: string): Promise<void> {
    terminal.columns = 160
    terminal.rows = 60
    await start({
      config: ConfigSchema.parse({ projects: { app: { root: repo.root } }, surfaces: { web } }),
    })
    const button = find('Settings ')
    click(button.col + 1, button.row)
    await until('the settings', () => screen().some((row) => row.includes('Intake')))
    const category = find('Intake')
    click(category.col + 1, category.row)
    await until('the sources', () => screen().some((row) => row.includes('Local door')))
    // The first source is the one the page opens on; pressing its tab again is a press like any other.
    const tab = find(title)
    click(tab.col + 1, tab.row)
    await until(`${title}'s page`, () => screen().some((row) => row.includes('Accept requests')))
  }

  it('says this machine’s own address on a source it connects, and Open hands it over', async () => {
    const port = await freePort()
    await onSource({ enabled: true, port }, 'GitHub')
    const url = `http://localhost:${port}/connect`
    await until('the address', () => screen().some((row) => row.includes(url)))
    expect(screen().some((row) => row.includes(`ssh -L ${port}:localhost:${port}`))).toBe(true)
    const heading = find('Connect GitHub')
    const col = screen()[heading.row]?.indexOf(' Open ') ?? -1
    expect(col).toBeGreaterThan(heading.col)
    click(col + 2, heading.row)
    await until('it opened', () => wired.opened.length > 0)
    expect(wired.opened.at(-1)?.args).toContain(url)
    await until('the flash', () => screen().some((row) => row.includes('opened the connect pages')))
  })

  it('says why where the away view is off, with nothing to press', async () => {
    await onSource({ enabled: false }, 'Slack')
    await until('the row', () => screen().some((row) => row.includes('Connect Slack')))
    const heading = find('Connect Slack')
    expect(screen()[heading.row]).not.toContain(' Open ')
    // Wrapped to the form, so asked of the words that start it.
    const start = CONNECT_OFF.slice(0, 40)
    expect(screen().some((row) => row.includes(start))).toBe(true)
  })

  it('draws nothing to connect on the local door', async () => {
    await onSource({ enabled: true, port: await freePort() }, 'Local door')
    expect(screen().some((row) => row.includes('Connect '))).toBe(false)
  })
})
