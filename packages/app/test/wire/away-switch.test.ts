import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema } from '@tade/core'
import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import { freePort } from './away-harness.ts'
import { type FakeTerminal, type Repo, screenOf, until, windowUnderTest } from './harness.ts'

// The away view, turned on from its own switch on the Settings page — the
// whole way through, because what was wrong was the wiring: the switch saved,
// said *applies when Tade next starts*, and the page went on showing switches.
// Turning it on is now the listener coming up at once, and the page drawing
// what it is for under the switch: the link, the code, how to use them, and
// the devices.
//
// **Loopback, on a port the machine said was free**, as every away test is:
// a test that bound the network would leave a listener on whoever ran it.

describe('the away view, turned on from Settings', () => {
  let terminal: FakeTerminal
  let client: Workbench
  let repo: Repo
  let home: string
  const { start, click, find, opened } = windowUnderTest((wired) => {
    terminal = wired.terminal
    client = wired.client
    repo = wired.repo
    home = wired.home
  })

  /** The window, over a home whose away view would listen on `port`, opened on the Away page. */
  async function onTheAwayPage(port: number): Promise<void> {
    await windowOver({ port })
    const button = find('Settings ')
    click(button.col + 1, button.row)
    await until('the settings', () => terminal.written.includes('Away view'))
    const category = find('Away view')
    click(category.col + 1, category.row)
    await until('the away page', () => terminal.written.includes('Serve the away view'))
  }

  /** The window, over a home whose away view is set as `web` says. */
  async function windowOver(web: { port: number; enabled?: boolean }): Promise<void> {
    const on = web.enabled === true ? '    enabled: true\n' : ''
    const config = `projects:\n  app:\n    root: ${repo.root}\nsurfaces:\n  web:\n${on}    port: ${web.port}\n`
    writeFileSync(join(home, 'config.yaml'), config)
    // Tall and wide enough for the code beside the page's own categories: a
    // code that does not fit is not drawn at all, and says so.
    terminal.columns = 160
    terminal.rows = 90
    await start({
      config: ConfigSchema.parse({ projects: { app: { root: repo.root } }, surfaces: { web } }),
    })
    await until('the first frame', () => terminal.written.includes('Settings'))
  }

  /** Whether something answers on this machine at `port`. */
  async function answers(port: number): Promise<boolean> {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) })
      return true
    } catch {
      return false
    }
  }

  it('says what a paired device may do as names under one heading, nothing cut', async () => {
    await onTheAwayPage(await freePort())
    const page = screenOf(terminal.written).join('\n')
    expect(page).toContain('A PAIRED DEVICE MAY')
    for (const name of ['Act', 'Talk to Tade', 'Save draft workflows', 'Get notifications']) {
      expect(page).toContain(name)
    }
    // The sentences each row used to be, and the ellipsis they were cut with.
    expect(page).not.toContain('Let a paired device')
    expect(page).not.toMatch(/Let a .*…/)
  })

  it('listens at once, and draws the link and the code under its switch', async () => {
    const port = await freePort()
    await onTheAwayPage(port)
    expect(await answers(port)).toBe(false)
    const row = find('Serve the away view')
    click(row.col + 1, row.row)
    terminal.written = ''
    terminal.press(' ')
    // Not *applies when Tade next starts*: the listener, now, and a code for it.
    await until('the link', () => terminal.written.includes(`http://localhost:${port}/pair#`))
    expect(await answers(port)).toBe(true)
    const page = screenOf(terminal.written).join('\n')
    expect(page).toContain('Open the link on this machine')
    expect(page).toContain('DEVICES')
    expect(page).toContain('No device has been paired.')
    expect(page).toContain('█')
    // Written down as a change a person made, and the listener as having come up.
    expect(client.config.surfaces.web.enabled).toBe(true)

    // And off is off at once too: the direction that takes authority away.
    terminal.written = ''
    terminal.press(' ')
    await until('the listener gone', async () => !(await answers(port)))
    await until('the page without a code', () =>
      screenOf(terminal.written).every((line) => !(line ?? '').includes('/pair#')),
    )
    expect(client.config.surfaces.web.enabled).toBe(false)
  })

  it('waits for nothing to start again: no row on the page says it would', async () => {
    await onTheAwayPage(await freePort())
    const page = screenOf(terminal.written).join('\n')
    expect(page).toContain('Who can reach it')
    expect(page).not.toContain('on restart')
  })

  it('moves to a port typed on the page while it listens, and the code with it', async () => {
    const first = await freePort()
    await onTheAwayPage(first)
    const row = find('Serve the away view')
    click(row.col + 1, row.row)
    terminal.press(' ')
    await until('the link', () => terminal.written.includes(`http://localhost:${first}/pair#`))
    expect(await answers(first)).toBe(true)

    // The number, opened with enter, emptied and typed into as a person would,
    // and left with enter.
    const second = await freePort()
    const port = find('Port')
    click(port.col + 1, port.row)
    terminal.press('\r')
    terminal.press('\x15')
    terminal.press(String(second))
    terminal.written = ''
    terminal.press('\r')
    await until('the new port', async () => await answers(second))
    expect(await answers(first)).toBe(false)
    expect(client.config.surfaces.web.port).toBe(second)
    // The page draws a code for the listener there is, never the one there was.
    await until('the new link', () => terminal.written.includes(`http://localhost:${second}/pair#`))
  })

  it('mints a new code from the page, once the one it showed is gone', async () => {
    const port = await freePort()
    await onTheAwayPage(port)
    const row = find('Serve the away view')
    click(row.col + 1, row.row)
    terminal.press(' ')
    await until('the link', () => terminal.written.includes(`http://localhost:${port}/pair#`))
    const first = linkOn(screenOf(terminal.written))
    // `New code` is the panel's own control, carried out by the subject that
    // holds the tickets — pressed here, on the Settings page.
    const again = find('New code')
    terminal.written = ''
    click(again.col + 1, again.row)
    await until('another link', () => {
      const now = linkOn(screenOf(terminal.written))
      return now !== null && now !== first
    })
  })

  it('opens the link in the browser from the link itself and from Open beside it', async () => {
    const port = await freePort()
    await onTheAwayPage(port)
    const row = find('Serve the away view')
    click(row.col + 1, row.row)
    terminal.press(' ')
    await until('the link', () => terminal.written.includes(`http://localhost:${port}/pair#`))
    const link = linkOn(screenOf(terminal.written))
    // A press on the address, then on the button: the same act both times,
    // handed to the desktop the way every link is.
    const places = { 'the link': find(`localhost:${port}/pair#`), Open: find('[Open] [Copy]') }
    for (const [label, at] of Object.entries(places)) {
      terminal.written = ''
      click(at.col + 1, at.row)
      await until(`opened from ${label}`, () => opened.length > 0)
      expect(opened.at(-1)?.args).toContain(link)
      opened.length = 0
      // Said in the strip as the act, never as the address: it carries a ticket.
      await until('the flash', () => terminal.written.includes('opened the pairing link'))
    }
  })

  it('opens it from the AWAY VIEW panel the same way', async () => {
    const port = await freePort()
    await windowOver({ port, enabled: true })
    const line = find('Ask Tade anything')
    click(line.col, line.row)
    await until('the line open', () =>
      screenOf(terminal.written).some((row) => row.includes('enter sends')),
    )
    for (const char of '/away') terminal.press(char)
    await until('what was typed', () =>
      screenOf(terminal.written).some((row) => row.includes('/away')),
    )
    terminal.written = ''
    terminal.press('\r')
    await until('the panel', () => terminal.written.includes('AWAY VIEW'))
    await until('its link', () => linkOn(screenOf(terminal.written)) !== null)
    const link = linkOn(screenOf(terminal.written))
    const at = find(`localhost:${port}/pair#`)
    click(at.col + 1, at.row)
    await until('opened', () => opened.length > 0)
    expect(opened.at(-1)?.args).toContain(link)
  })
})

/** The pairing link drawn on a screen, or null. */
function linkOn(lines: readonly string[]): string | null {
  for (const line of lines) {
    const found = (line ?? '').match(/http:\/\/localhost:\d+\/pair#\S+/)
    if (found) return found[0]
  }
  return null
}
