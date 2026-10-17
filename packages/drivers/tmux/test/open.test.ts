import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { LaneId } from '@tade/core'
import { until } from '@tade/drivers-core/conformance'
import { afterEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { TmuxDriver } from '../src/index.ts'

// What `open` asks of tmux, held against tmux itself: each driver here is on a
// server of its own that nothing has started yet, which is the driver a
// machine has when it starts its agents.

describe('opening lanes on tmux', () => {
  const drivers: TmuxDriver[] = []
  let n = 0
  const fresh = (session: string) => {
    const socket = `tade-open-${process.pid}-${++n}`
    const driver = new TmuxDriver({ socket, session })
    drivers.push(driver)
    return { driver, socket }
  }
  afterEach(async () => {
    for (const driver of drivers.splice(0)) await driver.shutdown()
  })

  // Every open that found no session made one, and tmux refused all but the
  // first with `duplicate session`: four lanes opened together were one lane
  // and three errors, every time.
  it('opens every lane asked for at once, though no session has been made yet', async () => {
    const { driver } = fresh('cold')
    const cwd = tmp('tade-tmux-cold-')
    const ids = Array.from({ length: 8 }, (_, i) => `cold/l${i}` as LaneId)
    const opened = await Promise.allSettled(
      ids.map((id) => driver.open({ id, cwd, command: 'cat', args: [] })),
    )
    const said = opened.map((o) => (o.status === 'fulfilled' ? 'opened' : String(o.reason)))
    expect(said).toEqual(ids.map(() => 'opened'))
    expect((await driver.list()).map((lane) => lane.id).sort()).toEqual(ids)
  })

  // tmux reads an argument that ends in `;` as the end of a command, so a value
  // ending in one split the call that opens the lane, and what followed it was
  // read as a command of its own: `unknown command`, and no lane.
  it('hands a lane a directory, an environment and an id ending in `;` as given', async () => {
    const { driver, socket } = fresh('semi')
    const cwd = join(tmp('tade-tmux-semi-'), 'ends;')
    mkdirSync(cwd)
    const id = 'semi/ends;' as LaneId
    await driver.open({
      id,
      cwd,
      command: '/bin/sh',
      args: ['-c', 'printf "[%s][%s]" "$TADE_X" "$(pwd -P)"; exec cat'],
      env: { TADE_X: 'a;b;' },
    })
    let heard = ''
    driver.onOutput(id, (c) => (heard += Buffer.from(c).toString()), { replay: true })
    await until(() => heard.includes(`[a;b;][${cwd}]`))
    // The id the window carries for whoever looks at the server by hand.
    const asked = ['-L', socket, 'list-windows', '-t', '=semi', '-F', '#{@tade-lane}']
    const kept = spawnSync('tmux', asked, { encoding: 'utf8' })
    expect(kept.stdout.split('\n')).toContain(id)
  })
})
