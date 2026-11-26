import { request } from 'node:http'
import { GRANTS, SCOPES, type Snapshot } from '@tade/web'
import { afterEach, describe, expect, it } from 'vitest'
import {
  COOKIE,
  closeAll,
  type Machine,
  machine,
  OTHER,
  paired,
  projectionOf,
} from './away-harness.ts'
import { until } from './harness.ts'

// Every other machine's projection, handed to the person's own phone through
// the real listener and the window's own beat: whole when its stream opens or
// a machine is first heard, its change after, and nothing at all to a device
// that is not the person's own (ONE-AWAY-VIEW step 1).

afterEach(closeAll)

const EPOCH = '0b1e0000-0000-4000-8000-000000000000'

/** What another machine would have sent: a real projection, at its own epoch and revision. */
function ipax(one: Machine, rev: number, title: string): Snapshot {
  const made = projectionOf(one, [...GRANTS], OTHER)
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
    await paired(one.home, one.port, [...SCOPES], [...GRANTS])
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

  it('is never sent to a device that is not the person’s own', async () => {
    let held: Snapshot | null = null
    const one = await machine({ copies: () => [{ name: 'ipax', projection: held }] })
    await paired(one.home, one.port, ['read'], [...GRANTS])
    await one.away.open()
    held = ipax(one, 4, 'x')
    const stream = await listen(one.port)
    await until('the stream to open', () => stream.text().includes('event: snapshot'))
    // A change to this machine's own world, on the same beat a copy would
    // have gone: waited for by what arrives after it, never by a sleep.
    one.running(one.task)
    await one.refresh()
    await until('the beat’s own delta', () => stream.text().includes('event: delta'))
    expect(machineFrames(stream.text())).toEqual([])
    stream.close()
  })
})
