import type { RunResult } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { ownUnit, restartAsService, unitOf } from '../src/commands/serve-restart.ts'

// `tade serve` started again from the person's own phone (`serve-restart.ts`):
// systemd's restart of the unit Tade wrote, read out of the process's own
// cgroup, queued without waiting on the stop that ends this very process — and
// nothing at all where nothing would start it again.

/** What `systemctl` answers, recording what it was asked. */
function systemctl(answer: Partial<RunResult> = {}) {
  const asked: string[][] = []
  const run = async (command: string, args: readonly string[]): Promise<RunResult> => {
    asked.push([command, ...args])
    return { code: 0, stdout: '', stderr: '', missing: false, timedOut: false, ...answer }
  }
  return { run, asked }
}

describe('the unit `tade serve` runs in', () => {
  it('is read off its cgroup, under either hierarchy', () => {
    expect(
      unitOf('0::/user.slice/user-1000.slice/user@1000.service/app.slice/tade.service\n'),
    ).toBe('tade.service')
    expect(
      unitOf(
        '12:pids:/user.slice\n1:name=systemd:/user.slice/user-1000.slice/user@1000.service/tade.service\n',
      ),
    ).toBe('tade.service')
  })

  it('is no unit where it was started by hand, or cannot be read', () => {
    expect(unitOf('0::/user.slice/user-1000.slice/session-3.scope\n')).toBeNull()
    expect(
      ownUnit(() => {
        throw new Error('ENOENT: no /proc here')
      }),
    ).toBeNull()
  })
})

describe('restarting it', () => {
  it('asks systemd to restart the unit Tade wrote, without waiting on its own stop', async () => {
    const { run, asked } = systemctl()
    const restart = restartAsService('tade.service', run)
    await restart?.()
    expect(asked).toEqual([['systemctl', '--user', 'restart', '--no-block', 'tade.service']])
  })

  it('offers nothing under a unit of somebody else’s, or none', () => {
    expect(restartAsService('my-tade.service', systemctl().run)).toBeUndefined()
    expect(restartAsService(null, systemctl().run)).toBeUndefined()
  })

  it('says what systemd answered where it would not', async () => {
    const { run } = systemctl({ code: 1, stderr: 'Failed to connect to bus: No medium found\n' })
    await expect(restartAsService('tade.service', run)?.()).rejects.toThrow(
      'systemd would not restart tade.service: Failed to connect to bus: No medium found',
    )
  })
})
