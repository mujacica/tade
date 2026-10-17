import { mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { PiAdapter, runSocket, sessionIdFor } from '../src/adapter.ts'
import { sessionDirFor } from '../src/sessions.ts'

// pi's agents run as a user of their own (`agents.user`): pi keeps its
// sessions in that user's home, so that is where Tade looks, and its socket
// is that user's group's to reach. It has no sandbox, and says so.

const made: PiAdapter[] = []
afterEach(async () => {
  for (const one of made.splice(0)) await one.detach()
})

describe('pi run as a user of its own', () => {
  it('finds a task’s conversation in that user’s home, not this one', async () => {
    const home = tmp('pi-home-')
    const cwd = realpathSync(tmp('pi-cwd-'))
    const one = new PiAdapter({ runDir: tmp('pi-agent-'), user: 'tade-agent', home })
    made.push(one)
    expect(await one.hasConversation('app/refunds', cwd)).toBe(false)
    const dir = sessionDirFor(cwd, join(home, '.pi', 'agent', 'sessions'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `2026-10-18T00-00-00-000Z_${sessionIdFor('app/refunds')}.jsonl`),
      `${JSON.stringify({ type: 'session', id: sessionIdFor('app/refunds'), cwd })}\n`,
    )
    expect(await one.hasConversation('app/refunds', cwd)).toBe(true)
  })

  it('listens on a socket its group can reach, and says it has no sandbox', async () => {
    const socketDir = tmp('pi-agent-')
    const one = new PiAdapter({
      runDir: tmp('pi-agent-'),
      socketDir,
      user: 'tade-agent',
      home: tmp('pi-home-'),
    })
    made.push(one)
    await one.supervise({ run: 'app/t/agent', task: 'app/t', cwd: tmp('pi-cwd-'), prompt: '' })
    expect(statSync(runSocket(socketDir, 'app/t/agent')).mode & 0o777).toBe(0o660)
    expect(one.capabilities.sandbox).toBe(false)
    expect(one.capabilities.why.sandbox).toContain('no sandbox of its own')
  })
})
