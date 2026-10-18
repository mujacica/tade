import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ConfigSchema } from '@tade/core'
import type { FarEnd } from '@tade/remotes-core/far'
import { makeScriptedLink, type ScriptedOptions, type ScriptedRemote } from '@tade/remotes-scripted'
import { screenOf, until, type Wired } from './harness.ts'

// The window linked to a far end as the remote `vps`, and standing in its
// project `tade` — the way a person gets there: its name along the top
// pressed, and enter on its menu.
//
// Enter is pressed only once the menu has drawn `tade` as the row the keyboard
// is on (`▌`, `panels/menu/view.ts`). Until the link has heard from that
// machine its menu is one row that cannot be chosen — "nothing heard from it
// yet" — and enter on it does nothing, while other words on the screen may
// already say `tade`: a test that pressed on those sat on an open menu until
// it ran out of time.

/** What a test may ask of the scripted link besides where its remotes are. */
export type LinkAs = Pick<ScriptedOptions, 'terminals' | 'hesitant'>

/** The row the menu draws with the keyboard on the project: `▌ tade`, then what it says of it. */
const CHOSEN = /▌ tade(\s|$)/

export async function standingThere(wired: Wired, far: FarEnd, link: LinkAs = {}): Promise<void> {
  const rows = () => screenOf(wired.terminal.written)
  const table = new Map<string, ScriptedRemote>([['vps', far]])
  const session = await far.pair('mac')
  const vps = {
    ssh: 'vps',
    tade: 'tade',
    device: session.device,
    session: session.cookie,
    csrf: session.csrf,
    host: session.host,
  }
  const root = wired.repo.root
  // In the file too, so the window's own reading of it finds the same remote.
  await writeFile(
    join(wired.home, 'config.yaml'),
    [
      `projects:\n  app:\n    root: ${root}`,
      'remotes:\n  vps:',
      ...Object.entries(vps).map(([key, value]) => `    ${key}: ${value}`),
      '',
    ].join('\n'),
  )
  await wired.start({
    config: ConfigSchema.parse({ projects: { app: { root } }, remotes: { vps } }),
    remoteLinks: {
      ssh: (options) => makeScriptedLink({ ...options, remotes: table, ...link }),
    },
  })
  // Eighty columns fold a machine's projects into its chip: its menu is them.
  await until('vps along the top', () => (rows()[0] ?? '').includes('vps'), 20_000)
  const top = rows()[0] ?? ''
  wired.click(top.indexOf('vps') + 1, 0)
  const said = (what: string) => () => `${what}, where the screen shows:\n${rows().join('\n')}`
  await until(said('its menu on tade'), () => rows().some((row) => CHOSEN.test(row)), 20_000)
  wired.terminal.press('\r')
  await until(said('the menu chosen from'), () => !rows().some((row) => CHOSEN.test(row)), 20_000)
}

/**
 * Press an agent's row down the side, where the pane beside it may say its
 * name too. A miss says what the screen showed, as `wired.find` does.
 */
export function pressRow(wired: Wired, label: string): void {
  const lines = screenOf(wired.terminal.written)
  for (let at = 1; at < lines.length; at++) {
    const line = lines[at] ?? ''
    const edge = Math.max(line.indexOf('│'), line.indexOf('┃'))
    const col = line.indexOf(label)
    if (col >= 0 && (edge < 0 || col < edge)) {
      wired.click(col + 1, at)
      return
    }
  }
  throw new Error(
    lines.every((line) => line.trim() === '')
      ? `no row down the side says "${label}": nothing has been drawn yet`
      : `no row down the side says "${label}", where the screen shows:\n${lines.join('\n')}`,
  )
}
