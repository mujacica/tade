import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigSchema } from '@tade/core'
import { sessionIdFor as claudeSession } from '@tade/harnesses-claude'
import { sessionIdFor as piSession } from '@tade/harnesses-pi'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { ORCHESTRATOR_TASK, orchestratorHistory } from '../src/orchestrator.ts'

// What was said to the orchestrator before the window closed, read back out of
// the record of whichever harness it talks through — without the model
// running, because a window shows it before the orchestrator has started.

const RECORDED = fileURLToPath(
  new URL('../../../test/fixtures/transcripts/claude-code/2.1/orchestrator.jsonl', import.meta.url),
)

describe('the conversation so far', () => {
  it('is read out of Claude Code’s own transcript when that is the harness it talks through', async () => {
    const account = tmp('tade-orch-claude-')
    const dir = join(account, 'projects', '-work-shop')
    mkdirSync(dir, { recursive: true })
    copyFileSync(RECORDED, join(dir, `${claudeSession(ORCHESTRATOR_TASK)}.jsonl`))
    const read = orchestratorHistory({
      config: ConfigSchema.parse({ orchestrator: { harness: 'claude-code' } }),
      runDir: tmp('tade-orch-run-'),
      env: { ...process.env, CLAUDE_CONFIG_DIR: account },
    })
    const page = await read({ limit: 3 })
    // The newest exchange is two items, so three reach back to the start of
    // the one before it: a page starts where something was sent.
    expect(page.items.map((item) => item.kind)).toEqual(['sent', 'reply', 'sent', 'tool'])
    expect(page.items.at(0)).toMatchObject({
      kind: 'sent',
      text: expect.stringContaining('stop the flaky agent'),
    })
    expect(page.earlier).not.toBeNull()
    const before = await read({ limit: 100, before: page.earlier })
    expect(before.items.at(-1)).toMatchObject({
      kind: 'reply',
      text: 'That repository has no history yet, so there is nothing to review.',
    })
    expect(before.earlier).toBeNull()
  })

  it('is empty where its harness has none', async () => {
    const read = orchestratorHistory({
      config: ConfigSchema.parse({ orchestrator: { harness: 'claude-code' } }),
      runDir: tmp('tade-orch-run-'),
      env: { ...process.env, CLAUDE_CONFIG_DIR: tmp('tade-orch-claude-') },
    })
    expect(await read({ limit: 10 })).toEqual({ items: [], earlier: null })
  })

  it('is read out of the session pi keeps for a headless run', async () => {
    const runDir = tmp('tade-orch-run-')
    const config = ConfigSchema.parse({ orchestrator: { harness: 'pi' } })
    mkdirSync(join(runDir, 'sessions'), { recursive: true })
    writeFileSync(
      join(runDir, 'sessions', `2026-09-19T11-47-15-509Z_${piSession(ORCHESTRATOR_TASK)}.jsonl`),
      `${[
        { type: 'session', version: 3, id: 'x' },
        {
          type: 'message',
          timestamp: '2026-09-19T11:47:17Z',
          message: { role: 'user', content: 'hello' },
        },
        {
          type: 'message',
          timestamp: '2026-09-19T11:47:18Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Hello.' }] },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join('\n')}\n`,
    )
    const page = await orchestratorHistory({ config, runDir })({ limit: 10 })
    expect(page.items.map((item) => item.kind)).toEqual(['sent', 'reply'])
  })
})
