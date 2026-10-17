import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { TaskId } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { PiAdapter, sessionIdFor } from '../src/adapter.ts'
import { sessionDirFor } from '../src/sessions.ts'

// A folder's pi sessions, read and carried by the adapter alone: sessions
// written the way pi writes them, under a sessions root of the test's own,
// and no pi.

const CHAT = 'chats/3' as TaskId

function setUp() {
  const root = tmp('tade-pi-folder-')
  const cwd = realpathSync(tmp('tade-pi-cwd-'))
  const dir = sessionDirFor(cwd, root)
  mkdirSync(dir, { recursive: true })
  /** A session as pi writes one: its header, then what was said. */
  const write = (id: string, when: string, said: string[], at: number) => {
    const file = join(dir, `${when}_${id}.jsonl`)
    const lines = [
      { type: 'session', version: 3, id, timestamp: '2026-10-16T10:00:00.000Z', cwd },
      ...said.map((text, n) => ({
        type: 'message',
        id: `m${n}`,
        parentId: null,
        timestamp: '2026-10-16T10:00:01.000Z',
        message: { role: 'user', content: [{ type: 'text', text }] },
      })),
    ]
    writeFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(''))
    utimesSync(file, at, at)
    return file
  }
  return {
    adapter: new PiAdapter({ runDir: tmp('tade-pi-run-'), sessionsRoot: root }),
    cwd,
    dir,
    write,
  }
}

describe('a folder’s pi sessions', () => {
  it('lists them newest first with the first thing said, naming the chat’s own', async () => {
    const { adapter, cwd, write } = setUp()
    write('8f1c-mine', '2026-10-15T10-00-00-000Z', ['tidy my downloads'], 1_000)
    write(sessionIdFor(CHAT), '2026-10-16T10-00-00-000Z', ['what changed in node 24'], 2_000)
    write('8f1c-empty', '2026-10-14T10-00-00-000Z', [], 500)

    expect(await adapter.sessions(cwd, [CHAT])).toEqual([
      { id: sessionIdFor(CHAT), at: 2_000_000, first: 'what changed in node 24', task: CHAT },
      { id: '8f1c-mine', at: 1_000_000, first: 'tidy my downloads', task: null },
    ])
  })

  it('carries one into a chat as a copy its header names, leaving it as it was', async () => {
    const { adapter, cwd, dir, write } = setUp()
    const original = write('8f1c-mine', '2026-10-15T10-00-00-000Z', ['tidy my downloads'], 1_000)
    const before = readFileSync(original, 'utf8')

    expect(await adapter.carrySession('8f1c-none', CHAT, cwd)).toBe(false)
    expect(await adapter.carrySession('8f1c-mine', CHAT, cwd)).toBe(true)

    expect(await adapter.hasConversation(CHAT, cwd)).toBe(true)
    const name = readdirSync(dir).find((one) => one.endsWith(`_${sessionIdFor(CHAT)}.jsonl`))
    const [head, ...rest] = readFileSync(join(dir, name ?? ''), 'utf8').split('\n')
    expect(JSON.parse(head ?? '')).toMatchObject({ type: 'session', id: sessionIdFor(CHAT), cwd })
    expect(rest.join('\n')).toContain('tidy my downloads')
    expect(readFileSync(original, 'utf8')).toBe(before)
    // And never written over once the chat has one of its own.
    await expect(adapter.carrySession('8f1c-mine', CHAT, cwd)).rejects.toThrow(
      /already has a conversation/,
    )
  })

  it('in a folder every working directory shares, lists only the ones started here', async () => {
    const shared = tmp('tade-pi-shared-')
    const cwd = realpathSync(tmp('tade-pi-cwd-'))
    const adapter = new PiAdapter({
      runDir: tmp('tade-pi-run-'),
      env: { PI_CODING_AGENT_SESSION_DIR: shared, HOME: tmp('tade-pi-home-') },
    })
    const write = (id: string, where: string, text: string) =>
      writeFileSync(
        join(shared, `2026-10-16T10-00-00-000Z_${id}.jsonl`),
        `${JSON.stringify({ type: 'session', version: 3, id, cwd: where })}\n${JSON.stringify({
          type: 'message',
          message: { role: 'user', content: [{ type: 'text', text }] },
        })}\n`,
      )
    write('here', cwd, 'mine')
    write('there', '/somewhere/else', 'not mine')

    expect((await adapter.sessions(cwd, [])).map((one) => one.id)).toEqual(['here'])
    expect(await adapter.carrySession('there', CHAT, cwd)).toBe(false)
  })
})
