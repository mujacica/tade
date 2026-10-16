import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema, PUBLIC_DIR } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { freePort } from './away-harness.ts'
import { type FakeTerminal, type Repo, screenOf, until, windowUnderTest } from './harness.ts'

// A public name, through the window: the listener comes up for it on this
// machine as before, the code carries the name a phone will use off this
// wifi, and where nothing can listen for Caddy the page says why — on a
// machine with no `/run/tade`, which is every machine that runs this suite.
// The socket itself, its directory and Caddy's header are `@tade/web`'s
// `public.test.ts`, over a directory a test can make.

describe('a public name, in the window', () => {
  let terminal: FakeTerminal
  let repo: Repo
  let home: string
  const { start, click, find } = windowUnderTest((wired) => {
    terminal = wired.terminal
    repo = wired.repo
    home = wired.home
  })

  it('pairs by the name, and says why nothing listens for Caddy where it cannot', async () => {
    // A box that really has the directory would come up instead, which is right
    // and is not what this asks.
    if (existsSync(PUBLIC_DIR)) return
    const port = await freePort()
    const web = { enabled: true, port, public: 'tade.example.com' }
    writeFileSync(
      join(home, 'config.yaml'),
      `projects:\n  app:\n    root: ${repo.root}\nsurfaces:\n  web:\n    enabled: true\n    port: ${port}\n    public: tade.example.com\n`,
    )
    terminal.columns = 160
    terminal.rows = 90
    await start({
      config: ConfigSchema.parse({ projects: { app: { root: repo.root } }, surfaces: { web } }),
    })
    await until('the first frame', () => terminal.written.includes('Settings'))
    const button = find('Settings ')
    click(button.col + 1, button.row)
    await until('the settings', () => terminal.written.includes('Away view'))
    const category = find('Away view')
    click(category.col + 1, category.row)
    await until('the link', () => terminal.written.includes('https://tade.example.com/pair#'))
    await until('why nothing listens for Caddy', () =>
      screenOf(terminal.written).join('\n').includes('nothing listens for Caddy'),
    )
    const page = screenOf(terminal.written).join('\n')
    expect(page).toContain('○ tade.example.com')
    expect(page).toContain(`${PUBLIC_DIR} is not there`)
    expect(page).toContain('Public name')
  })
})
