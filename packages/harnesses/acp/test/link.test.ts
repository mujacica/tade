import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import type { WorkerCommand } from '@tade/harnesses-core'
import { afterEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { Link } from '../src/link.ts'

// The lane's end of its supervision socket, against a Tade that is a plain
// socket server.

const opened: { link: Link; server: Server }[] = []
afterEach(() => {
  for (const { link, server } of opened.splice(0)) {
    link.close()
    server.close()
  }
})

describe('the link', () => {
  it('keeps a character whole when a command arrives cut through it', async () => {
    const path = join(tmp('tade-acp-link-'), 's')
    const bytes = Buffer.from(`${JSON.stringify({ type: 'steer', message: 'café' })}\n`)
    const cut = bytes.indexOf(0xa9)
    const server = createServer((socket) => {
      socket.write(bytes.subarray(0, cut))
      setTimeout(() => socket.write(bytes.subarray(cut)), 10)
    })
    await new Promise<void>((resolve) => server.listen(path, resolve))
    const told = new Promise<WorkerCommand>((resolve) => {
      const link = new Link({
        path,
        onCommand: resolve,
        onConnect: () => {},
        onDisconnect: () => {},
      })
      opened.push({ link, server })
    })
    expect(await told).toEqual({ type: 'steer', message: 'café' })
  })
})
