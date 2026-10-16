import { spawnSync } from 'node:child_process'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LaneId } from '@tade/core'
import { until } from '@tade/drivers-core/conformance'
import { afterEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { TmuxDriver } from '../src/index.ts'

// A pane tmux calls dead is not one whose output has been written down.
//
// tmux says a pane is dead once it has handed the last of what it printed to
// the pipe, and `cat` writes that to the file the driver reads some time
// after. Here `cat` is a fifth of a second late, which a loaded machine can
// make it. Where tmux closed the pipe as the pane died (3.8 on), the bytes
// have to be in before the exit is reported, because whoever listens stops at
// the exit. An older tmux keeps a dead pane's pipe open, so `cat` never says it
// is done and there is nothing to wait for: there the bytes only have to come.

/** What tmux says about the dead pane in a session, asked of tmux itself rather than of its version. */
function deadPane(socket: string, session: string, env: NodeJS.ProcessEnv, format: string): string {
  const ran = spawnSync(
    'tmux',
    ['-L', socket, 'list-panes', '-s', '-t', session, '-F', `#{pane_dead} ${format}`],
    { env, encoding: 'utf8' },
  )
  const row = ran.stdout.split('\n').find((one) => one.startsWith('1 '))
  if (row === undefined) throw new Error(`no dead pane in ${session}: ${ran.stderr}`)
  return row.slice(2)
}

describe('a lane whose pipe is slow to write', () => {
  const drivers: TmuxDriver[] = []
  afterEach(async () => {
    for (const driver of drivers.splice(0)) await driver.shutdown()
  })

  it('is heard before it is said to have exited, wherever tmux lets the pipe say so', async () => {
    const dir = tmp('tade-tmux-cat-')
    writeFileSync(join(dir, 'cat'), '#!/bin/sh\nsleep 0.2\nexec /bin/cat "$@"\n')
    chmodSync(join(dir, 'cat'), 0o755)
    // The server's own environment is what its pipes run in.
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` }
    const socket = `tade-pipe-${process.pid}`
    const driver = new TmuxDriver({ socket, session: 'pipe', env })
    drivers.push(driver)

    const id = 'pipe/quick' as LaneId
    await driver.open({ id, cwd: dir, command: '/bin/sh', args: ['-c', 'printf said-late'] })
    let heard = ''
    let atExit: string | null = null
    driver.onOutput(id, (c) => (heard += Buffer.from(c).toString()), { replay: true })
    driver.onExit(id, () => (atExit = heard))
    await until(() => atExit !== null)

    if (deadPane(socket, 'pipe', env, '#{pane_pipe}') === '0') {
      expect(atExit).toContain('said-late')
    } else {
      await until(() => heard.includes('said-late'))
    }
  })
})
