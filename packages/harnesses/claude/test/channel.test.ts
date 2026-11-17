import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { type ChannelRequest, ClaudeChannel } from '../src/channel.ts'

// The window's end of a Claude Code agent's socket, asked by the agent's own
// end (`ask.ts`) as one of its processes would ask it.
//
// The agent's side is read off disk by every hook and every MCP server Claude
// Code starts, and the window keeps the code it opened with. So a window open
// since the morning hears from an agent's side committed in the afternoon:
// TADE-8 was a window from 16 Nov asked for `cancel`, which landed on 17 Nov,
// and it called that unreadable and answered `{}` — which the sender takes for
// having been heard.

const dirs: string[] = []
const channels: ClaudeChannel[] = []

afterEach(async () => {
  for (const channel of channels.splice(0)) await channel.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  delete process.env.TADE_RUN_SOCKET
})

async function opened(): Promise<{
  channel: ClaudeChannel
  heard: ChannelRequest[]
  warned: string[]
}> {
  const dir = tmp('tade-channel-')
  dirs.push(dir)
  const heard: ChannelRequest[] = []
  const warned: string[] = []
  const channel = await ClaudeChannel.listen({
    path: join(dir, 's'),
    onRequest: async (request) => {
      heard.push(request)
      return { ok: true }
    },
    onWarning: (message) => warned.push(message),
  })
  channels.push(channel)
  return { channel, heard, warned }
}

/** The agent's end, loaded the way Claude Code's processes load it. */
async function agentFor(channel: ClaudeChannel) {
  vi.resetModules()
  process.env.TADE_RUN_SOCKET = channel.path
  return (await import('../src/ask.ts')) as typeof import('../src/ask.ts')
}

describe('ClaudeChannel', () => {
  it('answers what it knows', async () => {
    const { channel, heard, warned } = await opened()
    const { reach } = await agentFor(channel)
    expect(await reach({ kind: 'cancel', callId: 'c1' })).toEqual({
      reply: { ok: true },
      reached: true,
    })
    expect(heard).toEqual([{ kind: 'cancel', callId: 'c1' }])
    expect(warned).toEqual([])
  })

  it('does not take a request newer than it is for having been heard, and names it', async () => {
    const { channel, heard, warned } = await opened()
    const { reach } = await agentFor(channel)
    const { reached } = await reach({ kind: 'from_tomorrow', callId: 'c1' })
    expect(reached).toBe(false)
    expect(heard).toEqual([])
    expect(warned).toEqual([
      "a Claude Code agent asked for `from_tomorrow`, which this window does not know: the agent's side is newer than the window, so restart Tade to catch up",
    ])
  })

  it('still calls what it cannot read unreadable, and never repeats it as a kind', async () => {
    const { channel, warned } = await opened()
    const { reach } = await agentFor(channel)
    await reach({ kind: 'cancel' })
    await reach({ kind: 'what anybody typed' })
    await reach(['hook'])
    expect(warned).toEqual([
      'an unreadable request from a Claude Code agent',
      'an unreadable request from a Claude Code agent',
      'an unreadable request from a Claude Code agent',
    ])
  })
})
