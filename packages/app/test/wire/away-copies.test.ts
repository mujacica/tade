import { request } from 'node:http'
import { digestOf, type Snapshot, writeDevices } from '@tade/web'
import { afterEach, describe, expect, it } from 'vitest'
import {
  COOKIE,
  closeAll,
  DEVICE,
  type Machine,
  machine,
  OTHER,
  paired,
  projectionOf,
  SECRET,
} from './away-harness.ts'
import { until } from './harness.ts'

// Every other machine's projection, handed to the person's own phone through
// the real listener and the window's own beat: whole when its stream opens or
// a machine is first heard, its change after (ONE-AWAY-VIEW step 1). A
// machine's own link is never sent them: it is one of the machines.

afterEach(closeAll)

const EPOCH = '0b1e0000-0000-4000-8000-000000000000'

/** What another machine would have sent: a real projection, at its own epoch and revision. */
function ipax(one: Machine, rev: number, title: string): Snapshot {
  const made = projectionOf(one, OTHER)
  return {
    ...made,
    fresh: { ...made.fresh, epoch: EPOCH, rev },
    tasks: made.tasks.map((task) => ({ ...task, title: { words: title, more: false } })),
  }
}

/** An open stream, and every byte the server has written to it. */
function listen(port: number, path = '/api/stream'): Promise<{ text(): string; close(): void }> {
  return new Promise((done, failed) => {
    let said = ''
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: {
          host: `127.0.0.1:${port}`,
          cookie: COOKIE,
          accept: 'text/event-stream',
          'sec-fetch-site': 'same-origin',
        },
      },
      (res) => {
        res.on('data', (chunk: Buffer) => {
          said += chunk.toString('utf8')
        })
        done({ text: () => said, close: () => req.destroy() })
      },
    )
    req.on('error', failed)
    req.end()
  })
}

/** The `machine` frames a stream carried, read back. */
function machineFrames(text: string): { machine: string; kind: string; from?: number }[] {
  return text
    .split('\n\n')
    .filter((frame) => frame.startsWith('event: machine\n'))
    .map((frame) => JSON.parse(frame.slice(frame.indexOf('data: ') + 6)))
}

describe('another machine’s copy on the person’s own phone', () => {
  it('is whole at first, then only what changed, as the window’s beat moves', async () => {
    let held: Snapshot | null = null
    const one = await machine({ copies: () => [{ name: 'ipax', projection: held }] })
    await paired(one.home, one.port)
    await one.away.open()
    held = ipax(one, 4, 'Fix the parser')
    const stream = await listen(one.port)
    await until('the stream to open', () => stream.text().includes('event: snapshot'))
    await one.refresh()
    await until('the copy, whole', () => machineFrames(stream.text()).length === 1)
    expect(machineFrames(stream.text())[0]).toMatchObject({ machine: 'ipax', kind: 'whole' })

    held = ipax(one, 5, 'Fix the parser for good')
    await one.refresh()
    await until('its change', () => machineFrames(stream.text()).length === 2)
    expect(machineFrames(stream.text())[1]).toMatchObject({ kind: 'change', from: 4 })
    stream.close()

    // A page that opens again is sent it whole, with no beat in between.
    const again = await listen(one.port)
    await until('the copy on a new stream', () => machineFrames(again.text()).length === 1)
    expect(machineFrames(again.text())[0]).toMatchObject({ machine: 'ipax', kind: 'whole' })
    again.close()

    // One that says it holds the copy at the revision it was last sent is not
    // sent it again: the first it hears of it is the next change.
    const resumed = await listen(one.port, `/api/stream?held=${EPOCH}:5:ipax`)
    await until('the stream to open again', () => resumed.text().includes('event: snapshot'))
    held = ipax(one, 6, 'Fix the parser, and test it')
    await one.refresh()
    await until('the change after it', () => machineFrames(resumed.text()).length === 1)
    expect(machineFrames(resumed.text())[0]).toMatchObject({ kind: 'change', from: 5 })
    resumed.close()
  })
})

/** The harness's device again, as `tade web pair --owner` writes one: another machine's link. */
async function owner(home: string, port: number): Promise<void> {
  await writeDevices(home, [
    {
      kind: 'paired',
      device: DEVICE,
      at: new Date().toISOString(),
      label: 'mac',
      digest: digestOf(SECRET),
      host: `127.0.0.1:${port}`,
      csrf: 'x'.repeat(43),
      until: new Date(Date.now() + 86_400_000).toISOString(),
      from: '',
      owner: true,
    },
  ])
}

describe('another machine’s copy on a machine’s own link', () => {
  // `sentCopies` decides it on both paths, the stream's opening and the beat,
  // and reads the device list as it is now. So one stream is followed from a
  // link to a phone: the first copy it is sent has to be the one the beat moved
  // after it became a phone, and anything a link was sent would come before it.
  it('is sent neither on opening nor on the beat', async () => {
    let held: Snapshot | null = null
    const one = await machine({ copies: () => [{ name: 'ipax', projection: held }] })
    await paired(one.home, one.port)
    await one.away.open()

    // A phone's page, so the window holds a copy a stream that opens could be sent.
    held = ipax(one, 4, 'Fix the parser')
    const phone = await listen(one.port)
    await until('the phone’s stream to open', () => phone.text().includes('event: snapshot'))
    await one.refresh()
    await until('the copy on the phone', () => machineFrames(phone.text()).length === 1)
    phone.close()

    await owner(one.home, one.port)
    await one.away.reread()
    const link = await listen(one.port)
    await until('the link’s stream to open', () => link.text().includes('event: snapshot'))
    held = ipax(one, 5, 'Fix the parser for good')
    await one.refresh()

    await paired(one.home, one.port)
    await one.away.reread()
    held = ipax(one, 6, 'Fix the parser, and test it')
    await one.refresh()
    await until('the copy, once a phone', () => machineFrames(link.text()).length > 0)
    const frames = machineFrames(link.text()) as { kind: string; snapshot?: Snapshot }[]
    expect(frames).toHaveLength(1)
    expect(frames[0]?.kind).toBe('whole')
    expect(frames[0]?.snapshot?.fresh.rev).toBe(6)
    link.close()
  })
})
