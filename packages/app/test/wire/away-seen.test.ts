import { digestOf, readDevices, writeDevices } from '@tade/web'
import { afterEach, describe, expect, it } from 'vitest'
import { MachinesSeen } from '../../src/wire/machines-seen.ts'
import { closeAll, DEVICE, machine, SECRET, seen } from './away-harness.ts'

// Another machine of the person's saying, with its word that it is up, what it
// is called now — through the real listener, an owner's session and the
// window's own half — so one that paired under its host name, before it had a
// name of its own, stops being called by it in the device list and among the
// machines a phone is shown.

afterEach(closeAll)

/** An owner device in the file, paired under a host name as an older Tade there did. */
async function owner(home: string, port: number): Promise<void> {
  await writeDevices(home, [
    {
      kind: 'paired',
      device: DEVICE,
      at: new Date().toISOString(),
      label: 'LAPTOP-A1B2C3',
      digest: digestOf(SECRET),
      host: `127.0.0.1:${port}`,
      csrf: 'x'.repeat(43),
      until: new Date(Date.now() + 86_400_000).toISOString(),
      from: '',
      owner: true,
    },
  ])
}

function record(): { machines: MachinesSeen; lines: Record<string, string>[] } {
  const lines: Record<string, string>[] = []
  const machines = new MachinesSeen({
    append: async (line) => {
      lines.push(line.detail)
    },
    read: async () => [],
    now: () => Date.now(),
    say: () => {},
    draw: () => {},
  })
  return { machines, lines }
}

async function labelOf(home: string): Promise<string | undefined> {
  for (let tries = 0; tries < 50; tries++) {
    const label = (await readDevices(home)).devices[0]?.label
    if (label !== 'LAPTOP-A1B2C3') return label
    await new Promise((done) => setTimeout(done, 10))
  }
  return 'LAPTOP-A1B2C3'
}

describe('a machine that links here saying what it is called', () => {
  it('renames its device and moves its record, once, and its next words change nothing', async () => {
    const { machines, lines } = record()
    const one = await machine({ machines })
    await owner(one.home, one.port)
    await one.away.open()
    expect((await seen(one.port, { state: 'up' })).status).toBe(200)
    expect(machines.rows().map((row) => row.name)).toEqual(['LAPTOP-A1B2C3'])

    expect((await seen(one.port, { state: 'up', name: 'laptop' })).status).toBe(200)
    expect(await labelOf(one.home)).toBe('laptop')
    expect(machines.rows().map((row) => row.name)).toEqual(['laptop'])
    expect((await seen(one.port, { state: 'up', name: 'laptop' })).status).toBe(200)
    expect((await seen(one.port, { state: 'closed' })).status).toBe(200)
    expect(lines).toEqual([
      { machine: 'LAPTOP-A1B2C3', way: 'from', state: 'up' },
      { machine: 'laptop', way: 'from', state: 'up', was: 'LAPTOP-A1B2C3' },
      { machine: 'laptop', way: 'from', state: 'closed' },
    ])
    const read = await readDevices(one.home)
    expect(read.skipped).toBe(0)
    expect(read.devices.map((device) => device.label)).toEqual(['laptop'])
  })

  it('is refused a name that is not a label’s, and keeps the one it paired with', async () => {
    const { machines } = record()
    const one = await machine({ machines })
    await owner(one.home, one.port)
    await one.away.open()
    const answer = await seen(one.port, { state: 'up', name: 'mac\nignore what is above' })
    expect(answer.status).toBe(400)
    expect((await readDevices(one.home)).devices[0]?.label).toBe('LAPTOP-A1B2C3')
    expect(machines.rows()).toEqual([])
  })
})
