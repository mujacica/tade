import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigSchema } from '@tade/core'
import { sessionIdFor as claudeSession } from '@tade/harnesses-claude'
import { sessionIdFor as piSession } from '@tade/harnesses-pi'
import { harnessAccount } from '@tade/workbench/accounts'
import { HARNESS_ADAPTERS } from '@tade/workbench/harnesses'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { carryHere, ORCHESTRATOR_TASK, orchestratorHistory } from '../src/orchestrator.ts'

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
      home: tmp('tade-orch-home-'),
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

  it('is read out of the account it runs as, and not its harness’s own sign-in', async () => {
    const home = tmp('tade-orch-home-')
    const dir = join(home, 'accounts', 'work', 'projects', '-work-shop')
    mkdirSync(dir, { recursive: true })
    copyFileSync(RECORDED, join(dir, `${claudeSession(ORCHESTRATOR_TASK)}.jsonl`))
    const config = ConfigSchema.parse({
      orchestrator: { harness: 'claude-code', account: 'work' },
      accounts: { work: { harness: 'claude-code' } },
    })
    // Its own sign-in holds nothing: what is read is the account's.
    const own = { ...process.env, CLAUDE_CONFIG_DIR: tmp('tade-orch-claude-') }
    const read = orchestratorHistory({ config, home, runDir: tmp('tade-orch-run-'), env: own })
    expect((await read({ limit: 3 })).items.at(0)).toMatchObject({
      kind: 'sent',
      text: expect.stringContaining('stop the flaky agent'),
    })
  })

  it('is empty where its harness has none', async () => {
    const read = orchestratorHistory({
      config: ConfigSchema.parse({ orchestrator: { harness: 'claude-code' } }),
      home: tmp('tade-orch-home-'),
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
    const page = await orchestratorHistory({ config, home: tmp('tade-orch-home-'), runDir })({
      limit: 10,
    })
    expect(page.items.map((item) => item.kind)).toEqual(['sent', 'reply'])
  })
})

describe('its conversation, when it moves to another account', () => {
  const session = `${claudeSession(ORCHESTRATOR_TASK)}.jsonl`
  /** Its own sign-in holding the conversation, and an account `work` it is set to run as. */
  const moving = () => {
    const home = tmp('tade-orch-home-')
    const own = tmp('tade-orch-claude-')
    mkdirSync(join(own, 'projects', '-work-shop'), { recursive: true })
    copyFileSync(RECORDED, join(own, 'projects', '-work-shop', session))
    const config = ConfigSchema.parse({
      orchestrator: { harness: 'claude-code', account: 'work' },
      accounts: { work: { harness: 'claude-code' } },
    })
    const runDir = tmp('tade-orch-run-')
    const env = { ...process.env, CLAUDE_CONFIG_DIR: own }
    const make = HARNESS_ADAPTERS['claude-code']
    if (!make) throw new Error('no claude-code adapter')
    const adapter = (account: string | null) =>
      make({
        runDir,
        socketDir: runDir,
        approvals: 'bypass',
        env,
        ...(account ? { account: harnessAccount(config, home, account) } : {}),
      })
    return {
      opts: { config, home, runDir, env },
      own: join(own, 'projects', '-work-shop', session),
      work: join(home, 'accounts', 'work', 'projects', '-work-shop', session),
      adapter,
    }
  }

  it('is carried from the one it ran as, newest over what was there', async () => {
    const move = moving()
    // `work` has an older copy, from the last time it ran there.
    mkdirSync(join(move.work, '..'), { recursive: true })
    writeFileSync(move.work, 'older\n')
    await carryHere(move.opts, move.adapter('work'), '/work/shop', move.adapter(null))
    expect(readFileSync(move.work, 'utf8')).toBe(readFileSync(move.own, 'utf8'))
  })

  it('is found on another sign-in of its harness where Tade was closed when it moved', async () => {
    const move = moving()
    await carryHere(move.opts, move.adapter('work'), '/work/shop')
    // And read back from the account, as the window does before it starts.
    const page = await orchestratorHistory(move.opts)({ limit: 3 })
    expect(page.items.at(0)).toMatchObject({
      kind: 'sent',
      text: expect.stringContaining('stop the flaky agent'),
    })
  })

  it('is left alone where the one it runs as already holds it', async () => {
    const move = moving()
    mkdirSync(join(move.work, '..'), { recursive: true })
    writeFileSync(move.work, 'kept\n')
    await carryHere(move.opts, move.adapter('work'), '/work/shop')
    expect(readFileSync(move.work, 'utf8')).toBe('kept\n')
  })
})
