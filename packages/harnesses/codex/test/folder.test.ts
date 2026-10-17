import { mkdirSync, realpathSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TaskId } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { CodexAdapter } from '../src/adapter.ts'
import { rememberThread, threadOf } from '../src/sessions.ts'

// A folder's Codex threads, read and carried by the adapter alone: rollouts
// written the way Codex writes them, filed by day in a home of the test's own,
// and no Codex.

const CHAT = 'chats/2' as TaskId

function setUp() {
  const codexHome = tmp('tade-codex-folder-')
  const runDir = tmp('tcx-')
  const cwd = realpathSync(tmp('tade-codex-cwd-'))
  const adapter = new CodexAdapter({
    runDir,
    codexHome,
    home: tmp('tade-codex-home-'),
    bin: '/nonexistent/codex',
    type: async () => {},
  })
  /** A rollout as Codex writes one: its meta, then what was said. */
  const write = (thread: string, day: string, where: string, said: string[], at: number) => {
    const dir = join(codexHome, 'sessions', '2026', '10', day)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `rollout-2026-10-${day}T10-00-00-${thread}.jsonl`)
    const lines = [
      {
        timestamp: '2026-10-16T10:00:00Z',
        type: 'session_meta',
        payload: { id: thread, cwd: where },
      },
      ...said.map((message) => ({
        timestamp: '2026-10-16T10:00:01Z',
        type: 'event_msg',
        payload: { type: 'user_message', message },
      })),
    ]
    writeFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(''))
    utimesSync(file, at, at)
  }
  return { adapter, runDir, cwd, write }
}

describe('a folder’s Codex threads', () => {
  it('lists the ones started there, newest first, naming the chat’s own', async () => {
    const { adapter, runDir, cwd, write } = setUp()
    write('thread-mine', '15', cwd, ['why is the build slow'], 1_000)
    write('thread-chat', '16', cwd, ['look at my dotfiles'], 2_000)
    write('thread-there', '16', '/somewhere/else', ['not here'], 3_000)
    write('thread-empty', '14', cwd, [], 500)
    await rememberThread(CHAT, runDir, 'thread-chat')

    expect(await adapter.sessions(cwd, [CHAT])).toEqual([
      { id: 'thread-chat', at: 2_000_000, first: 'look at my dotfiles', task: CHAT },
      { id: 'thread-mine', at: 1_000_000, first: 'why is the build slow', task: null },
    ])
  })

  it('carries one into a chat by writing it down as the chat’s thread', async () => {
    const { adapter, runDir, cwd, write } = setUp()
    write('thread-mine', '15', cwd, ['why is the build slow'], 1_000)
    write('thread-there', '16', '/somewhere/else', ['not here'], 3_000)

    // Another folder's thread is not this folder's to carry.
    expect(await adapter.carrySession('thread-there', CHAT, cwd)).toBe(false)
    expect(await adapter.carrySession('thread-none', CHAT, cwd)).toBe(false)
    expect(await adapter.hasConversation(CHAT, cwd)).toBe(false)

    expect(await adapter.carrySession('thread-mine', CHAT, cwd)).toBe(true)
    expect(await threadOf(CHAT, runDir)).toBe('thread-mine')
    expect(await adapter.hasConversation(CHAT, cwd)).toBe(true)
    // And never pointed elsewhere once it has one.
    await expect(adapter.carrySession('thread-mine', CHAT, cwd)).rejects.toThrow(
      /already has a conversation/,
    )
  })
})
