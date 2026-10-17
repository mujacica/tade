import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { notifier, takeNotifySocket } from '../src/notify.ts'

// What `tade serve` tells systemd, through a `systemd-notify` that writes down
// what it was asked to say and exits as it is told to. That systemd's own
// hears it, under `NotifyAccess=all`, was proved in a Debian container.

/** A PATH whose `systemd-notify` writes its words down and exits `code`, saying `err`. */
function notifyAt(code = 0, err = ''): { env: NodeJS.ProcessEnv; said: () => string[] } {
  const dir = tmp('tade-notify-')
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const told = join(dir, 'told')
  writeFileSync(
    join(bin, 'systemd-notify'),
    `#!/bin/sh\nprintf '%s|%s\\n' "$NOTIFY_SOCKET" "$*" >> '${told}'\nprintf '%s' '${err}' >&2\nexit ${code}\n`,
  )
  chmodSync(join(bin, 'systemd-notify'), 0o755)
  return {
    env: { PATH: bin },
    said: () => (existsSync(told) ? readFileSync(told, 'utf8').trim().split('\n') : []),
  }
}

describe('the socket systemd hands it', () => {
  it('is taken out of the environment, so nothing started from here inherits it', () => {
    const env: NodeJS.ProcessEnv = { NOTIFY_SOCKET: '/run/user/1001/systemd/notify', PATH: '/x' }
    expect(takeNotifySocket(env)).toBe('/run/user/1001/systemd/notify')
    expect(env).toEqual({ PATH: '/x' })
    expect(takeNotifySocket(env)).toBeNull()
    expect(takeNotifySocket({ NOTIFY_SOCKET: '' })).toBeNull()
  })
})

describe('telling it', () => {
  it('says ready with a status on one line, and stopping, to the socket it was handed', async () => {
    const at = notifyAt()
    const trouble: string[] = []
    const notify = notifier('@/org/freedesktop/systemd1/notify', (one) => trouble.push(one), at.env)
    await notify.ready('holding /home/you/.tade\n  with no screen')
    await notify.stopping()
    expect(at.said()).toEqual([
      '@/org/freedesktop/systemd1/notify|READY=1 STATUS=holding /home/you/.tade with no screen',
      '@/org/freedesktop/systemd1/notify|STOPPING=1',
    ])
    expect(trouble).toEqual([])
  })

  it('runs nothing where no service manager is listening', async () => {
    const at = notifyAt()
    const notify = notifier(null, () => {}, at.env)
    await notify.ready('holding')
    await notify.stopping()
    expect(at.said()).toEqual([])
  })

  it('says it could not, and why: a unit never told it is ready is stopped and started again', async () => {
    const failing = notifyAt(1, 'Failed to notify init system: Permission denied')
    const trouble: string[] = []
    await notifier('/run/n', (one) => trouble.push(one), failing.env).ready('holding')
    expect(trouble).toEqual([
      'systemd was not told this is ready (Failed to notify init system: Permission denied), so it will stop the unit when its start times out',
    ])
    const none: string[] = []
    await notifier('/run/n', (one) => none.push(one), {
      PATH: tmp('tade-notify-empty-'),
    }).stopping()
    expect(none).toEqual([
      'systemd was not told this is stopping (there is no systemd-notify on its PATH)',
    ])
  })
})
