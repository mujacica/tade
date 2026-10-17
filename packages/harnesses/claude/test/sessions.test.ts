import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TaskId } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { ClaudeAdapter } from '../src/adapter.ts'
import { folderFor } from '../src/sessions.ts'
import { sessionIdFor } from '../src/transcript.ts'

// A folder's conversations as Claude Code keeps them, read and carried by the
// adapter alone: transcripts written the way Claude Code writes them, in a
// config folder of the test's own, and no Claude Code.

const CHAT = 'chats/5' as TaskId

/** A transcript as Claude Code writes one: its bookkeeping first, then what was said. */
function transcript(id: string, said: string[]): string {
  return [
    { type: 'mode', mode: 'normal', sessionId: id },
    ...said.map((words, n) => ({
      type: 'user',
      message: { role: 'user', content: words },
      sessionId: id,
      timestamp: `2026-10-16T19:0${n}:00.000Z`,
    })),
  ]
    .map((line) => `${JSON.stringify(line)}\n`)
    .join('')
}

async function setUp() {
  const configDir = tmp('tade-claude-sessions-')
  const cwd = tmp('tade-claude-cwd-')
  const folder = await folderFor(cwd, configDir)
  mkdirSync(folder, { recursive: true })
  const write = (id: string, said: string[], at: number) => {
    const file = join(folder, `${id}.jsonl`)
    writeFileSync(file, transcript(id, said))
    utimesSync(file, at, at)
    return file
  }
  return {
    adapter: new ClaudeAdapter({ runDir: tmp('tcc-'), configDir }),
    configDir,
    cwd,
    folder,
    write,
  }
}

describe('a folder’s Claude Code conversations', () => {
  it('lists them newest first with the first thing said, naming the chat’s own', async () => {
    const { adapter, cwd, write } = await setUp()
    const mine = 'a1b2c3d4-0000-4000-8000-000000000001'
    write(mine, ['what is eating my disk?\nand why'], 1_000)
    write(sessionIdFor(CHAT), ['research SA:MP'], 3_000)
    // Opened and never spoken to: nothing in it to pick up.
    write('a1b2c3d4-0000-4000-8000-000000000002', [], 2_000)

    expect(await adapter.sessions(cwd, [CHAT])).toEqual([
      { id: sessionIdFor(CHAT), at: 3_000_000, first: 'research SA:MP', task: CHAT },
      { id: mine, at: 1_000_000, first: 'what is eating my disk?', task: null },
    ])
    // Another folder's are nobody's here.
    expect(await adapter.sessions(tmp('tade-claude-elsewhere-'), [])).toEqual([])
  })

  it('finds a chat’s conversation wherever Claude Code filed it', async () => {
    const { adapter, configDir, cwd } = await setUp()
    const elsewhere = join(configDir, 'projects', '-somewhere-else')
    mkdirSync(elsewhere, { recursive: true })
    writeFileSync(join(elsewhere, `${sessionIdFor(CHAT)}.jsonl`), transcript('x', ['hello']))

    const [found] = await adapter.sessions(cwd, [CHAT])
    expect(found).toMatchObject({ id: sessionIdFor(CHAT), first: 'hello', task: CHAT })
  })

  it('carries one into a chat as a copy under the chat’s session, leaving it as it was', async () => {
    const { adapter, cwd, folder, write } = await setUp()
    const theirs = 'a1b2c3d4-0000-4000-8000-000000000003'
    const original = write(theirs, ['plan the trip'], 1_000)
    mkdirSync(join(folder, theirs, 'subagents'), { recursive: true })
    writeFileSync(join(folder, theirs, 'subagents', 'one.jsonl'), '{}\n')
    const before = readFileSync(original, 'utf8')

    expect(await adapter.hasConversation(CHAT, cwd)).toBe(false)
    expect(await adapter.carrySession(theirs, CHAT, cwd)).toBe(true)

    expect(await adapter.hasConversation(CHAT, cwd)).toBe(true)
    const carried = readFileSync(join(folder, `${sessionIdFor(CHAT)}.jsonl`), 'utf8')
    // Every line names the chat's session now, so it is never listed twice under one id.
    expect(carried).toContain(`"sessionId":"${sessionIdFor(CHAT)}"`)
    expect(carried).not.toContain(theirs)
    expect(carried).toContain('plan the trip')
    expect(readFileSync(join(folder, sessionIdFor(CHAT), 'subagents', 'one.jsonl'), 'utf8')).toBe(
      '{}\n',
    )
    expect(readFileSync(original, 'utf8')).toBe(before)
  })

  it('carries nothing it does not have, and never writes over a chat’s own', async () => {
    const { adapter, cwd, write } = await setUp()
    expect(await adapter.carrySession('a1b2c3d4-0000-4000-8000-00000000000f', CHAT, cwd)).toBe(
      false,
    )
    expect(await adapter.carrySession('../../etc/passwd', CHAT, cwd)).toBe(false)

    const theirs = 'a1b2c3d4-0000-4000-8000-000000000004'
    write(theirs, ['one'], 1_000)
    write(sessionIdFor(CHAT), ['its own'], 2_000)
    await expect(adapter.carrySession(theirs, CHAT, cwd)).rejects.toThrow(
      /already has a conversation/,
    )
  })
})
