import { fileURLToPath } from 'node:url'
import { ExtensionHost } from '@tade/extensions-core'
import type { McpTransport, OfferedTool, ServerSession } from '@tade/mcp-core'
import { makeStdioTransport } from '@tade/mcp-stdio'
import { describe, expect, it, vi } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { brokered, ServerSessions } from '../src/index.ts'

// A server turned off while the window runs is not only refused at the gate:
// its session ends there and then, and a program's process with it, because
// whoever started one ends it — and a window holding open somebody else's
// program for a server a person turned off, until it quits, is a process
// nobody asked for. Real processes, on purpose: the stdio transport's own
// fixture, in the slow end of the suite beside its tests.

const SERVER = fileURLToPath(new URL('../../stdio/test/fixtures/server.ts', import.meta.url))

const offered = (name: string): OfferedTool => ({
  name,
  description: `Does ${name}.`,
  input: { type: 'object', properties: {} },
})

/** Whether a process of this id is still there to be signalled. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The fixture as a server somebody wrote down and turned on, its programs counted. */
async function running() {
  const opened: number[] = []
  const counted = (): McpTransport => {
    const transport = makeStdioTransport()
    return {
      ...transport,
      open: (server, ctx) => {
        opened.push(Date.now())
        return transport.open(server, ctx)
      },
    }
  }
  const mcp = brokered({
    servers: {
      local: { enabled: true, transport: 'stdio', command: process.execPath, args: [SERVER] },
    },
    home: tmp('mcp-off-'),
    catalogue: [],
    transports: { stdio: counted },
    cache: () => ({
      about: { title: 'a works server', version: '1.2.3' },
      tools: [offered('told'), offered('lingers')],
      asked: '2026-10-17T08:00:00.000Z',
    }),
    env: { PATH: process.env.PATH ?? '' },
  })
  const host = await ExtensionHost.load({
    brokered: mcp.extensions,
    config: { extensions: {}, projects: {} },
    home: tmp('mcp-off-'),
    env: {},
  })
  const ask = (tool: string) => host.call(tool, {}, { caller: { kind: 'orchestrator' } })
  return { mcp, host, ask, opened }
}

describe('a stdio server turned off while the window runs', () => {
  it('has its process ended at once, rather than when Tade quits', async () => {
    const { mcp, host, ask, opened } = await running()
    try {
      const { pid } = JSON.parse((await ask('mcp_local_told')).text) as { pid: number }
      expect(alive(pid)).toBe(true)
      // What `Settings.use` hands both, from whichever door turned it off.
      host.useServers({ local: { enabled: false } })
      await mcp.useServers({ local: { enabled: false } })
      expect(alive(pid)).toBe(false)
      await expect(ask('mcp_local_told')).rejects.toThrow('is off: turned off')
      expect(opened).toHaveLength(1)
    } finally {
      await mcp.close()
    }
  })

  it('is not started again by a call that was already on its way when it was', async () => {
    // Past the gate before the switch: its session ends under it, and the one
    // retry a server that went away is given may not open the program again.
    const { mcp, ask, opened } = await running()
    try {
      const { pid } = JSON.parse((await ask('mcp_local_told')).text) as { pid: number }
      const lingering = expect(ask('mcp_local_lingers')).rejects.toThrow('local was turned off')
      await mcp.useServers({ local: { enabled: false } })
      await lingering
      expect(alive(pid)).toBe(false)
      expect(opened).toHaveLength(1)
      // Turned on again, it connects the next time Tade starts — not now.
      await mcp.useServers({ local: { enabled: true } })
      await expect(ask('mcp_local_told')).rejects.toThrow('local was turned off')
      expect(opened).toHaveLength(1)
    } finally {
      await mcp.close()
    }
  })
})

describe('ending the sessions a server holds', () => {
  /** A session that answers nothing, and writes down that it was ended. */
  const session = (
    ended: string[],
    name: string,
    close: () => Promise<void> = async () => {},
  ): ServerSession => ({
    about: { title: name, version: '1' },
    listTools: async () => [],
    callTool: async () => ({ text: '', failed: false }),
    onToolsChanged: () => () => {},
    onGone: () => () => {},
    close: () => {
      ended.push(name)
      return close()
    },
  })

  it('ends the window’s and every project’s, and nobody else’s', async () => {
    // A server that runs one per project has a session in each, named after
    // it; a server whose name starts the same way is a different server.
    const ended: string[] = []
    const sessions = new ServerSessions()
    for (const key of ['linear', 'linear in /work/app', 'linear in /work/api', 'linear-two']) {
      await sessions.of(key, async () => session(ended, key))
    }
    await sessions.end('linear')
    expect(ended.sort()).toEqual(['linear', 'linear in /work/api', 'linear in /work/app'])
    await sessions.close()
    expect(ended).toContain('linear-two')
  })

  it('waits a few seconds for one that never finishes ending, and no longer', async () => {
    // A server reached over the network that never answers its goodbye may
    // not hold up whoever turned it off, which is the window's beat.
    vi.useFakeTimers()
    try {
      const ended: string[] = []
      const sessions = new ServerSessions()
      await sessions.of('stuck', async () => session(ended, 'stuck', () => new Promise(() => {})))
      let over = false
      const ending = sessions.end('stuck').then(() => {
        over = true
      })
      await vi.advanceTimersByTimeAsync(4_999)
      expect(ended).toEqual(['stuck'])
      expect(over).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await ending
      expect(over).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
