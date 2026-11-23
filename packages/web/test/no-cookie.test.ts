import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { devicesPath } from '../src/devices.ts'
import { mayBeSession } from '../src/sessions.ts'
import { ask, closeAll, type Running, start } from './harness.ts'

// A request with no session — no cookie, or junk where one goes — is
// anybody's, as often as they like, and the device list only grows: so it is
// answered `no_session` without the list being read at all. What is seen is
// the list's own warning about a line it could not read, which is said the
// first time the list is read with that line in it.

afterEach(closeAll)

/** Whether the list was read: its unreadable line said. */
const read = (one: Running) =>
  one.told.some(
    (told) => told.type === 'warning' && String(told.detail.message).includes('paired-device list'),
  )

async function listener(): Promise<Running> {
  const one = await start()
  await mkdir(dirname(devicesPath(one.home)), { recursive: true })
  await writeFile(devicesPath(one.home), 'this is not a line of the list\n', { mode: 0o600 })
  return one
}

describe('a request that offers no session', () => {
  it('is no_session without the device list being read', async () => {
    const one = await listener()
    for (const cookie of [undefined, 'other=1', 'tade_away=junk', 'tade_away=0011.x']) {
      const answer = await ask(one, '/api/snapshot', {
        headers: cookie === undefined ? {} : { cookie },
      })
      expect(answer.status, String(cookie)).toBe(401)
    }
    expect(read(one)).toBe(false)
  })

  it('reads it where something shaped like a session was offered, which is what is looked up', async () => {
    const one = await listener()
    const cookie = `tade_away=0011223344556677.${'a'.repeat(43)}`
    expect(mayBeSession(cookie)).toBe(true)
    expect((await ask(one, '/api/snapshot', { headers: { cookie } })).status).toBe(401)
    expect(read(one)).toBe(true)
  })
})
