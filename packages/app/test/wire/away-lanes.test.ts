import { request } from 'node:http'
import { readDevices } from '@tade/web'
import { afterEach, describe, expect, it } from 'vitest'
import { AWAY_CONTROLS, awayPanel } from '../../src/panels/away/state.ts'
import { COOKIE, closeAll, DEVICE, type Machine, machine, paired, waitFor } from './away-harness.ts'

// An agent's screen, from away: who may read one, when the window reads it,
// and what of it leaves the machine.
//
// **Real listener, real workbench, real device list**; the one stand-in is the
// driver's capture, because the thing under test is when the window *asks*
// for a screen and what it does with the answer — not a terminal emulator.
// It counts every ask, which is how "nothing for nobody" is held: as a number.

afterEach(closeAll)

/** What an agent's screen says, with a path and a credential in it. */
const SCREEN = [
  '  ✻ Running the migration',
  '  $ cat /Users/testperson/work/app/db/migrate.ts',
  '  OPENAI_API_KEY=sk-fake-Zq8wLm4Tn2Rv6Ks9',
  '  4 files touched',
].join('\n')

/** A window whose capture is counted, with one device paired as asked. */
async function ready(granted: readonly string[]): Promise<Machine & { reads: string[] }> {
  const one = await machine()
  one.running(one.task)
  await paired(one.home, one.port, ['read'], granted)
  const reads: string[] = []
  // The driver's own capture, stood in for: the workbench is real, and this is
  // the one call that would need a terminal behind it.
  ;(one.client as unknown as { capture: (lane: string) => Promise<string> }).capture = (lane) => {
    reads.push(lane)
    return Promise.resolve(SCREEN)
  }
  await one.away.open()
  return Object.assign(one, { reads })
}

/** One `GET`, with everything the guard asks of a read on it. */
function get(
  port: number,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((done, failed) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: { host: `127.0.0.1:${port}`, cookie: COOKIE, 'sec-fetch-site': 'same-origin' },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          done({ status: res.statusCode ?? 0, body: JSON.parse(text) as Record<string, unknown> })
        })
      },
    )
    req.on('error', failed)
    req.end()
  })
}

const settle = () => new Promise<void>((done) => setImmediate(done))

describe('a device granted agents’ screens', () => {
  it('starts no read on the ask, and is read on the next beat', async () => {
    const one = await ready(['lanes'])
    const first = await get(one.port, `/api/agent/app/migration`)
    expect(first.status).toBe(200)
    // **Asking reads nothing**: a handler answers out of what is held, and the
    // honest first answer is that the window has not looked yet.
    expect(first.body).toMatchObject({ here: true, screen: null, why: 'not read yet' })
    expect(one.reads).toEqual([])
    one.away.beat()
    await settle()
    expect(one.reads).toEqual(['app/migration/agent'])
    const next = await get(one.port, `/api/agent/app/migration`)
    const screen = next.body.screen as { lines: string[]; taken: number }
    expect(screen.lines).toContain('  4 files touched')
    expect(screen.taken).toBe(2)
    const said = JSON.stringify(next.body)
    expect(said).not.toContain('testperson')
    expect(said).not.toContain('sk-fake-Zq8wLm4Tn2Rv6Ks9')
  })

  it('costs nothing over a hundred beats while it is not asking', async () => {
    const one = await ready(['lanes'])
    for (let n = 0; n < 100; n += 1) one.away.beat()
    await settle()
    expect(one.reads).toEqual([])
  })

  it('makes the window read nothing for a task that is not there', async () => {
    const one = await ready(['lanes'])
    const answer = await get(one.port, `/api/agent/elsewhere/anything`)
    expect(answer.body).toMatchObject({ here: false, why: 'not here', screen: null })
    one.away.beat()
    await settle()
    expect(one.reads).toEqual([])
  })
})

describe('a device not granted them', () => {
  it('is told so, and its asking makes the window read nothing', async () => {
    const one = await ready([])
    const answer = await get(one.port, `/api/agent/app/migration`)
    expect(answer.body).toMatchObject({ here: true, screen: null, why: 'not granted' })
    one.away.beat()
    await settle()
    expect(one.reads).toEqual([])
  })
})

describe('the grant, which is a keypress at this machine', () => {
  it('turns on for one device, is written down, and turns off again', async () => {
    const one = await ready([])
    one.show()
    await one.away.submits().away?.(awayPanel(), `${AWAY_CONTROLS.see}${DEVICE}`)
    expect((await readDevices(one.home)).devices[0]?.granted).toEqual(['lanes'])
    expect(one.news.at(-1)).toBe('iPhone can see agents’ screens')
    const line = (await waitFor(one.client, 'web_paired'))[0] as { detail: Record<string, string> }
    expect(line.detail).toMatchObject({ device: DEVICE, reads: 'lanes', granted: 'at the machine' })

    // And the very next ask is answered with the screen's own reason, not the
    // grant's: the window reads the device list at every request.
    const after = await get(one.port, `/api/agent/app/migration`)
    expect(after.body.why).toBe('not read yet')

    await one.away.submits().away?.(awayPanel(), `${AWAY_CONTROLS.see}${DEVICE}`)
    expect((await readDevices(one.home)).devices[0]?.granted).toEqual([])
    expect(one.news.at(-1)).toBe('iPhone can no longer see agents’ screens')
  })

  it('keeps every other reading grant as it was', async () => {
    const one = await ready(['titles', 'notes'])
    await one.away.submits().away?.(awayPanel(), `${AWAY_CONTROLS.see}${DEVICE}`)
    expect((await readDevices(one.home)).devices[0]?.granted).toEqual(['titles', 'notes', 'lanes'])
  })
})
