import { rmSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { SignalChannel } from '../src/channel.ts'
import type { WorkerSignal } from '../src/port.ts'

// Tade's end of the supervision socket, read as the agent's end writes it:
// bytes, in whatever pieces the kernel hands over.

const dirs: string[] = []
const channels: SignalChannel[] = []
const sockets: Socket[] = []
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy()
  for (const channel of channels.splice(0)) await channel.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function opened() {
  const dir = tmp('tade-channel-')
  dirs.push(dir)
  const heard: WorkerSignal[] = []
  const warned: string[] = []
  const channel = await SignalChannel.listen({
    path: join(dir, 's.sock'),
    run: 'r',
    onSignal: (signal) => heard.push(signal),
    onWarning: (message) => warned.push(message),
  })
  channels.push(channel)
  return { channel, heard, warned }
}

describe('SignalChannel', () => {
  it('keeps a character whole when a signal arrives cut through it', async () => {
    const { channel, heard, warned } = await opened()
    const bytes = Buffer.from(
      `${JSON.stringify({ type: 'message', run: 'r', at: 1, text: 'café' })}\n`,
    )
    const cut = bytes.indexOf(0xa9)
    const socket = connect(channel.path)
    sockets.push(socket)
    await new Promise<void>((done) => socket.once('connect', done))
    socket.write(bytes.subarray(0, cut))
    setTimeout(() => socket.write(bytes.subarray(cut)), 10)
    await vi.waitFor(() => expect(heard).toHaveLength(1))
    expect(heard[0]).toMatchObject({ type: 'message', text: 'café' })
    expect(warned).toEqual([])
  })
})
