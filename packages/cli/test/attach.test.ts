import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LaneId } from '@wilco/core'
import { DaemonClient } from '@wilco/daemon/client'
import { Daemon } from '@wilco/daemon/server'
import { until } from '@wilco/driver-conformance'
import { spawn } from 'node-pty'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'

const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const echo = fileURLToPath(new URL('../../driver-conformance/src/echo-child.js', import.meta.url))

/** Wait for the attach banner, reporting what the terminal actually showed. */
async function awaitBanner(output: string[]): Promise<void> {
  try {
    await until(() => output.join('').includes('[attached'))
  } catch {
    throw new Error(`never attached. Terminal showed: ${JSON.stringify(output.join(''))}`)
  }
}

// `wilco attach` puts the user's terminal in raw mode. If it ever fails to put
// it back, people are left with a broken terminal, so this runs the real
// command inside a real pty and compares `stty -g` before and after.

describe('wilco attach', () => {
  let home: string
  let socket: string
  let daemon: Daemon
  let client: DaemonClient
  const lane = 'app/t/shell' as LaneId

  beforeEach(async () => {
    home = tmp('wilco-attach-')
    socket = join(home, 'wilco.sock')
    daemon = await Daemon.start({ home, socket })
    client = await DaemonClient.connect(socket)
    await client.spawn({
      id: lane,
      task: 'app/t',
      kind: 'shell',
      cwd: home,
      command: process.execPath,
      args: [echo],
      cols: 80,
      rows: 24,
    })
  })

  afterEach(async () => {
    await client.close().catch(() => {})
    await daemon.stop().catch(() => {})
  })

  it('restores terminal settings when the client is killed', async () => {
    const before = join(home, 'stty-before')
    const after = join(home, 'stty-after')
    const output: string[] = []
    // The attach runs in the foreground of this pty, so it may touch the tty.
    const term = spawn(
      '/bin/sh',
      ['-c', `stty -g > ${before}; ${process.execPath} ${bin} attach ${lane}; stty -g > ${after}`],
      {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: home,
        env: { ...process.env, WILCO_SOCKET: socket, WILCO_HOME: home } as Record<string, string>,
      },
    )
    term.onData((d) => output.push(d))

    await awaitBanner(output)
    // pgrep -f matches the shell too (its argv contains the command), so pick
    // the node process explicitly.
    const pid = await until(() => {
      const r = spawnSync('pgrep', ['-f', `bin.ts attach ${lane}`], { encoding: 'utf8' })
      for (const candidate of r.stdout.trim().split('\n').filter(Boolean)) {
        const comm = spawnSync('ps', ['-p', candidate, '-o', 'comm='], {
          encoding: 'utf8',
        }).stdout.trim()
        if (comm.endsWith('node')) return Number(candidate)
      }
      return 0
    })
    process.kill(pid, 'SIGTERM')

    // The shell creates this file the moment it redirects, before `stty` has
    // written into it, so wait for content rather than existence.
    await until(() => existsSync(after) && readFileSync(after, 'utf8').trim().length > 0)
    expect(readFileSync(after, 'utf8')).toBe(readFileSync(before, 'utf8'))
    term.kill()
  }, 30_000)

  it('passes input through to the lane and detaches on Ctrl-\\ twice', async () => {
    const output: string[] = []
    const term = spawn('/bin/sh', ['-c', `${process.execPath} ${bin} attach ${lane}`], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: home,
      env: { ...process.env, WILCO_SOCKET: socket, WILCO_HOME: home } as Record<string, string>,
    })
    term.onData((d) => output.push(d))
    let exited = false
    term.onExit(() => {
      exited = true
    })

    await awaitBanner(output)
    term.write('hello\n')
    // The keystrokes reached the lane, not just the local terminal.
    await until(async () => (await client.capture(lane)).includes('got:hello'))

    term.write('\x1c\x1c')
    await until(() => exited)
    expect(output.join('')).toContain('[detached]')
    // The lane is still running: detaching is not killing.
    expect((await client.lane(lane))?.alive).toBe(true)
  }, 30_000)
})
