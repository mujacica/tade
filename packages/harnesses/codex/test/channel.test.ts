import { rmSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { type ChannelRequest, CodexChannel } from '../src/channel.ts'

// The window's end of a Codex agent's socket, asked by the agent's own
// end (`ask.ts`) as one of its processes would ask it.
//
// The agent's side is read off disk by every hook and every MCP server Codex
// starts, and the window keeps the code it opened with. So a window open
// since the morning hears from an agent's side committed in the afternoon.
// TADE-8 was that on Claude Code's channel, which this one is line for line: a
// window from 16 Nov asked for `cancel`, which landed on 17 Nov, called it
// unreadable and answered `{}` — which the sender takes for having been heard.

const dirs: string[] = []
const channels: CodexChannel[] = []

afterEach(async () => {
  for (const channel of channels.splice(0)) await channel.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  delete process.env.TADE_RUN_SOCKET
})

async function opened(): Promise<{
  channel: CodexChannel
  heard: ChannelRequest[]
  warned: string[]
}> {
  const dir = tmp('tade-channel-')
  dirs.push(dir)
  const heard: ChannelRequest[] = []
  const warned: string[] = []
  const channel = await CodexChannel.listen({
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

/** The agent's end, loaded the way Codex's processes load it. */
async function agentFor(channel: CodexChannel) {
  vi.resetModules()
  process.env.TADE_RUN_SOCKET = channel.path
  return (await import('../src/ask.ts')) as typeof import('../src/ask.ts')
}

describe('CodexChannel', () => {
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
      "a Codex agent asked for `from_tomorrow`, which this window does not know: the agent's side is newer than the window, so restart Tade to catch up",
    ])
  })

  it('still calls what it cannot read unreadable, and never repeats it as a kind', async () => {
    const { channel, warned } = await opened()
    const { reach } = await agentFor(channel)
    await reach({ kind: 'cancel' })
    await reach({ kind: 'what anybody typed' })
    await reach(['hook'])
    expect(warned).toEqual([
      'an unreadable request from a Codex agent',
      'an unreadable request from a Codex agent',
      'an unreadable request from a Codex agent',
    ])
  })

  it('keeps a character whole when the request arrives cut through it', async () => {
    const { channel, heard, warned } = await opened()
    const bytes = Buffer.from(`${JSON.stringify({ kind: 'hook', event: { prompt: 'café' } })}\n`)
    const cut = bytes.indexOf(0xa9)
    const socket = connect(channel.path)
    const replied = new Promise<string>((resolve) => {
      let text = ''
      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => {
        text += chunk
      })
      socket.on('close', () => resolve(text))
    })
    socket.write(bytes.subarray(0, cut))
    setTimeout(() => socket.write(bytes.subarray(cut)), 10)
    expect(await replied).toBe('{"ok":true}\n')
    expect(heard).toEqual([{ kind: 'hook', event: { prompt: 'café' } }])
    expect(warned).toEqual([])
  })
})
