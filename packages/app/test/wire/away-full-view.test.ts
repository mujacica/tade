import { request } from 'node:http'
import { applyDelta, type Delta, type Projector, type Snapshot } from '@tade/web'
import { afterEach, describe, expect, it } from 'vitest'
import { COOKIE, closeAll, DEVICE, type Machine, machine, paired } from './away-harness.ts'
import { until } from './harness.ts'

// A device whose only open stream is the full view's (`?only=window`) through
// the real listener and the window's own beat: nothing of the projection is
// sent down it, so the beat builds none for it — and the overview the same
// device opens afterwards still starts level, its cursor replayed up to the
// revision a fresh page would be handed, with no resync and no revision skipped.

afterEach(closeAll)

interface Stream {
  text(): string
  close(): void
}

/** An open stream, and every byte the server has written to it. */
function listen(port: number, path: string, cursor?: string): Promise<Stream> {
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
          ...(cursor === undefined ? {} : { 'last-event-id': cursor }),
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

interface Read {
  event: string
  id: string | null
  data: unknown
}

/** The frames a stream carried that have an event, read back. */
function framesOf(text: string): Read[] {
  return text
    .split('\n\n')
    .filter((frame) => frame.includes('event: '))
    .map((frame) => {
      const lines = frame.split('\n')
      const field = (name: string) =>
        lines.find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2) ?? null
      const data = field('data')
      return {
        event: field('event') ?? '',
        id: field('id'),
        data: data === null ? null : JSON.parse(data),
      }
    })
}

const named = (stream: Stream, event: string) =>
  framesOf(stream.text()).filter((one) => one.event === event)
const revOf = (id: string | null) => Number(id?.split(':')[1])

/** The window's projector for the harness's device, with every beat it is asked for counted. */
function counted(one: Machine): { projector: Projector; beats: () => number } {
  const projector = (one.away as unknown as { projectors: Map<string, Projector> }).projectors.get(
    DEVICE,
  )
  if (projector === undefined) throw new Error('the device should have a projector by now')
  let beats = 0
  const beat = projector.beat.bind(projector)
  projector.beat = (input, now) => {
    beats += 1
    return beat(input, now)
  }
  return { projector, beats: () => beats }
}

/** A second task in the project, and in what the window sees: something for a projection to move by. */
async function another(one: Machine, slug: string): Promise<string> {
  const made = await one.client.createTask({ project: 'app', slug, intent: `then ${slug}` })
  one.watch(made.id)
  await one.refresh()
  return made.id
}

describe('a device whose only stream is the full view', () => {
  it('is projected by no beat, and its overview opening later starts level', async () => {
    const one = await machine()
    await paired(one.home, one.port)
    await one.away.open()

    // The overview, as the phone held it before going to an agent's full screen.
    const before = await listen(one.port, '/api/stream')
    await until('the snapshot', () => named(before, 'snapshot').length === 1)
    const [opening] = named(before, 'snapshot')
    let held = opening?.data as Snapshot
    const cursor = opening?.id ?? ''
    before.close()
    const full = await listen(one.port, '/api/stream?only=window')
    await until('the full view and nothing else', () => {
      const streams = (one.away as unknown as { streams: { projected(): string[] } }).streams
      return one.away.facts().remote?.devices === 1 && streams.projected().length === 0
    })

    // Two changes and their beats, and not one projection built for them.
    const { projector, beats } = counted(one)
    const second = await another(one, 'second')
    await another(one, 'third')
    for (let at = 0; at < 5; at++) await one.refresh()
    expect(beats()).toBe(0)
    // The strip still counts the full view as somebody reading.
    expect(one.away.facts().remote?.devices).toBe(1)
    expect(named(full, 'delta')).toEqual([])
    expect(named(full, 'snapshot')).toEqual([])

    // The overview again, at the cursor it held, with no beat and no other page
    // in between: caught up out of the ring as it opens, with no resync and no
    // snapshot, to the revision the projector is at.
    const again = await listen(one.port, '/api/stream', cursor)
    await until('the replay', () => named(again, 'delta').length > 0)
    expect(named(again, 'resync')).toEqual([])
    expect(named(again, 'snapshot')).toEqual([])
    for (const frame of named(again, 'delta')) held = applyDelta(held, frame.data as Delta)
    expect(held.fresh.rev).toBe(projector.rev)
    expect(revOf(named(again, 'delta').at(-1)?.id ?? null)).toBe(projector.rev)
    expect(held.tasks.map((task) => task.id)).toContain(second)

    // Which is exactly what a fresh page is handed, and opening one moves the
    // first on by nothing.
    const replayed = named(again, 'delta').length
    const fresh = await listen(one.port, '/api/stream')
    await until('a fresh page’s snapshot', () => named(fresh, 'snapshot').length === 1)
    const whole = named(fresh, 'snapshot')[0]?.data as Snapshot
    expect(whole.fresh.rev).toBe(held.fresh.rev)
    expect(held.tasks.map((task) => task.id).sort()).toEqual(
      whole.tasks.map((task) => task.id).sort(),
    )
    expect(named(again, 'delta')).toHaveLength(replayed)

    // And from there on the beat moves both pages on by the same next revision.
    await another(one, 'fourth')
    await until('the next delta', () => named(again, 'delta').length === replayed + 1)
    const next = named(again, 'delta').at(-1)
    expect(revOf(next?.id ?? null)).toBe(whole.fresh.rev + 1)
    held = applyDelta(held, next?.data as Delta)
    expect(held.fresh.rev).toBe(projector.rev)
    again.close()
    fresh.close()
    full.close()
  })
})
