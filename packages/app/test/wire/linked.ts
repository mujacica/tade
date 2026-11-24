import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ConfigSchema } from '@tade/core'
import { type FarAgent, type FarEnd, startFarEnd } from '@tade/remotes-core/far'
import { makeScriptedLink, type ScriptedRemote } from '@tade/remotes-scripted'
import { screenOf, until, type Wired } from './harness.ts'

// The window linked to a far end as the remote `ipax`, with `hello` and `tade`
// open there and wide enough for every tab along the top — the person's own
// Mac and VPS, as the row first showed them.

export async function linkedToIpax(
  wired: Wired,
  /** Handed the far end the moment it is up, so a test closes it whatever happens next. */
  keep: (far: FarEnd) => void,
  agents: readonly FarAgent[] = [],
): Promise<FarEnd> {
  const far = await startFarEnd({ projects: ['hello', 'tade'] })
  keep(far)
  far.show(['hello', 'tade'], {}, agents)
  wired.terminal.resize(200, 40)
  const table = new Map<string, ScriptedRemote>([['ipax', far]])
  const session = await far.pair('mac')
  const ipax = {
    ssh: 'ipax',
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
      'remotes:\n  ipax:',
      ...Object.entries(ipax).map(([key, value]) => `    ${key}: ${value}`),
      '',
    ].join('\n'),
  )
  await wired.start({
    config: ConfigSchema.parse({ projects: { app: { root } }, remotes: { ipax } }),
    remoteLinks: { ssh: (options) => makeScriptedLink({ ...options, remotes: table }) },
  })
  const top = () => screenOf(wired.terminal.written)[0] ?? ''
  await until(
    () => `ipax’s tabs along the top, where it reads:\n${top()}`,
    () => top().indexOf(' tade ', top().indexOf('ipax')) > 0,
    20_000,
  )
  return far
}
