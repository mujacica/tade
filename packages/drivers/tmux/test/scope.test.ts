import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LaneId } from '@tade/core'
import { until } from '@tade/drivers-core/conformance'
import { afterEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { TmuxDriver } from '../src/index.ts'
import { scopedStart, userServiceOf } from '../src/scope.ts'

// Restarting `tade.service` must never end an agent.
//
// A service's default `KillMode=control-group` ends everything in its cgroup,
// and a tmux server Tade started is in Tade's — so under a service of the
// user's manager the server is started in a scope of its own. Whether that
// survives a real `systemctl --user restart` was proved in a Debian container
// with systemd as its first process (the task's commit says how); what is held
// here is everything up to that: which processes count as running under such a
// service, the exact line that makes the scope, and that a lane opened through
// it — or through the plain start a failed scope falls back to — is a lane.

describe('which processes run under a service of the user’s manager', () => {
  const cases: [string, string, string | null][] = [
    [
      'a user service, cgroup v2',
      '0::/user.slice/user-1000.slice/user@1000.service/app.slice/tade.service\n',
      'tade.service',
    ],
    [
      'a user service, cgroup v1',
      '12:pids:/user.slice\n1:name=systemd:/user.slice/user-1000.slice/user@1000.service/tade.service\n',
      'tade.service',
    ],
    ['a login over SSH', '0::/user.slice/user-1000.slice/session-3.scope\n', null],
    [
      'a scope of its own',
      '0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-r1.scope',
      null,
    ],
    ['a system service — a CI runner', '0::/system.slice/actions.runner.repo.service\n', null],
    [
      'the user manager itself',
      '0::/user.slice/user-1000.slice/user@1000.service/init.scope',
      null,
    ],
    ['a container’s root', '0::/\n', null],
    ['no cgroup at all — a Mac', '', null],
  ]
  for (const [what, cgroup, unit] of cases) {
    it(`${what}: ${unit ?? 'no'}`, () => {
      expect(userServiceOf(cgroup)).toBe(unit)
    })
  }
})

describe('the line that makes the scope', () => {
  it('asks the user’s manager for a scope named after the socket, then runs tmux in it', () => {
    expect(scopedStart('tade', ['new-session', '-d'], '42-x')).toEqual([
      '--user',
      '--scope',
      '--quiet',
      '--collect',
      '--unit=tade-lanes-tade-42-x',
      "--description=Tade's lanes (tmux -L tade)",
      'tmux',
      '-L',
      'tade',
      'new-session',
      '-d',
    ])
  })

  it('names the scope only with what a unit name may hold', () => {
    expect(scopedStart('a b/c', [], '1')[4]).toBe('--unit=tade-lanes-a-b-c-1')
  })
})

describe('starting the lanes’ server under a user service', () => {
  const drivers: TmuxDriver[] = []
  afterEach(async () => {
    for (const driver of drivers.splice(0)) await driver.shutdown()
  })

  /**
   * A driver that believes it runs as `tade.service`, with a `systemd-run` on
   * its PATH that writes down what it was asked and then does it — or fails
   * the way one does with no user manager to talk to.
   */
  function underService(fails: boolean) {
    const dir = tmp('tade-scope-')
    const cgroup = join(dir, 'cgroup')
    writeFileSync(
      cgroup,
      '0::/user.slice/user-1000.slice/user@1000.service/app.slice/tade.service\n',
    )
    const asked = join(dir, 'asked')
    writeFileSync(asked, '')
    const fake = join(dir, 'systemd-run')
    writeFileSync(
      fake,
      [
        '#!/bin/sh',
        `printf '%s\\n' "$*" >> '${asked}'`,
        fails ? 'echo "Failed to connect to bus: No medium found" >&2; exit 1' : '',
        'while [ $# -gt 0 ]; do case "$1" in --*) shift ;; *) break ;; esac; done',
        'exec "$@"',
      ].join('\n'),
    )
    chmodSync(fake, 0o755)
    const troubles: string[] = []
    const driver = new TmuxDriver({
      socket: `tade-scope-${process.pid}-${fails ? 'f' : 'y'}`,
      session: 'scope',
      cgroup,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
      trouble: (problem) => troubles.push(problem.message),
    })
    drivers.push(driver)
    return { driver, asked: () => readFileSync(asked, 'utf8'), troubles, cwd: dir }
  }

  async function echoes(driver: TmuxDriver, cwd: string): Promise<void> {
    const id = 'scope/agent' as LaneId
    await driver.open({ id, cwd, command: 'sh', args: ['-c', 'read line; echo "got:$line"'] })
    await driver.write(id, new TextEncoder().encode('hello\r'))
    await until(async () => (await driver.capture(id, { lines: 50 })).includes('got:hello'))
  }

  it('starts it through systemd-run, in a scope, and the lane works', async () => {
    const box = underService(false)
    await echoes(box.driver, box.cwd)
    const asked = box.asked()
    expect(asked).toMatch(/^--user --scope --quiet --collect --unit=tade-lanes-tade-scope-/)
    expect(asked).toContain(' tmux -L tade-scope-')
    expect(asked).toContain(' new-session -d -s scope ')
    // Asked once: the session is there after that, and nothing else starts a server.
    expect(asked.trim().split('\n')).toHaveLength(1)
    expect(box.troubles).toEqual([])
  })

  it('says so and starts it plainly when no scope can be made, rather than starting nothing', async () => {
    const box = underService(true)
    await echoes(box.driver, box.cwd)
    expect(box.asked()).toContain('--scope')
    expect(box.troubles).toHaveLength(1)
    expect(box.troubles[0]).toContain('No medium found')
    expect(box.troubles[0]).toContain('stopping tade.service will end every agent in it')
  })
})
