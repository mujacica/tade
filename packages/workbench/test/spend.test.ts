import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type LaneId, spendFrom } from '@tade/core'
import { ECHO_CHILD } from '@tade/drivers-core/conformance'
import { sessionIdFor } from '@tade/harnesses-pi'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { Workbench } from '../src/workbench.ts'

// Money spent while nobody was watching.
//
// Under a driver whose lanes outlive the window, an agent keeps working after
// Tade closes and has nowhere to report what it costs. The harness writes it
// down anyway, so opening again is where the journal catches up.

describe('accounting for a closed window', () => {
  let home: string
  let sessionsRoot: string
  let tade: Workbench | null = null

  /** A harness session for this task, with one priced reply in it, shaped the way pi writes one. */
  function session(task: string, usd: number, tokens: number): void {
    const dir = join(sessionsRoot, `-src-${task.replace(/\//g, '-')}-`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `2026-09-13T04-14-42-404Z_${sessionIdFor(task)}.jsonl`),
      `${JSON.stringify({
        type: 'message',
        message: {
          role: 'assistant',
          provider: 'openrouter',
          model: 'moonshotai/kimi-k2.6',
          usage: {
            input: tokens,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: tokens,
            cost: { total: usd },
          },
        },
      })}\n`,
    )
  }

  const open = () => Workbench.open({ home, sessionsRoot })

  beforeEach(async () => {
    home = tmp('tade-spend-')
    sessionsRoot = tmp('tade-sessions-')
    // An agent lane that has existed. It is dead by the time we reopen, which
    // is exactly the case that matters: the work happened, we were not there.
    const first = await open()
    await first.spawn({
      id: 'app/refunds/agent' as LaneId,
      task: 'app/refunds',
      kind: 'agent',
      cwd: home,
      command: process.execPath,
      args: [ECHO_CHILD],
    })
    await first.close()
  })

  afterEach(async () => {
    await tade?.close().catch(() => {})
    tade = null
  })

  it('records what the session says was spent while it was closed', async () => {
    session('app/refunds', 0.42, 1_200)
    tade = await open()

    const spend = spendFrom(await tade.events({ types: ['usage'] }))
    expect(spend.byTask['app/refunds']?.tokens).toBe(1_200)
    expect(spend.byTask['app/refunds']?.usd).toBeCloseTo(0.42)
    expect(spend.total.hasCost).toBe(true)
    // On the model it ran on, not on "unknown" — by its own name, which is
    // the row the money of every other route to it is already in.
    expect(spend.byModel['kimi-k2.6']?.tokens).toBe(1_200)
  })

  it('does not charge the same tokens twice on the next open', async () => {
    session('app/refunds', 0.42, 1_200)
    tade = await open()
    await tade.close()

    tade = await open()
    const spend = spendFrom(await tade.events({ types: ['usage'] }))
    // The journal has caught up with the session; there is nothing left to add.
    expect(spend.byTask['app/refunds']?.tokens).toBe(1_200)
  })

  it('adds only what is new when the agent worked on after that', async () => {
    session('app/refunds', 0.42, 1_200)
    tade = await open()
    await tade.close()

    // It kept going while we were away.
    session('app/refunds', 1.0, 3_000)
    tade = await open()
    const spend = spendFrom(await tade.events({ types: ['usage'] }))
    expect(spend.byTask['app/refunds']?.tokens).toBe(3_000)
    expect(spend.byTask['app/refunds']?.usd).toBeCloseTo(1.0)
  })

  it('never invents a refund when the journal knows more than the session', async () => {
    session('app/refunds', 5, 9_000)
    tade = await open()
    await tade.close()

    // The session was trimmed or replaced. Subtracting to make the two agree
    // would corrupt every total that reads the journal.
    session('app/refunds', 1, 1_000)
    tade = await open()
    const spend = spendFrom(await tade.events({ types: ['usage'] }))
    expect(spend.byTask['app/refunds']?.tokens).toBe(9_000)
  })

  it('says nothing at all about a task whose agent never ran', async () => {
    tade = await open()
    expect(await tade.events({ types: ['usage'] })).toHaveLength(0)
  })
})
