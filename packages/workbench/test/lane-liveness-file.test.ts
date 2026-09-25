import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LivenessProbe } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { laneLivenessFromFile, livenessFrom, type RunningWork } from '../src/lane-liveness.ts'
import type { LaneRecord } from '../src/registry.ts'

// Liveness for whoever is *not* holding the workbench.
//
// One window per home, so `tade status` in a second terminal cannot open the
// workbench to ask who is working — it reads `lanes.json` and checks the pids
// instead. That is the whole of "a question you cannot ask while a window is
// open is a question people stop asking", and until now nothing ran it.
//
// It takes different evidence from `reconcile` on purpose: this asks whether
// an agent is *working*, not whether this process could drive it. A running
// pid answers the first and not the second — and a lane the file calls alive
// whose pid has gone is the case that matters, because that is what a window
// killed outright leaves behind.

const lane = (over: Partial<LaneRecord> & { id: string }): LaneRecord =>
  ({
    task: 'shop/refunds',
    kind: 'agent',
    spec: { id: over.id, cwd: '/tmp', command: '/usr/bin/pi', args: [] },
    pid: process.pid,
    startedAt: 1_000,
    title: 'an agent',
    alive: true,
    exitCode: null,
    lastOutputAt: 2_000,
    ...over,
  }) as LaneRecord

/** A home whose `lanes.json` holds exactly this. */
function home(body: unknown): string {
  const dir = tmp('tade-lanes-')
  writeFileSync(join(dir, 'lanes.json'), typeof body === 'string' ? body : JSON.stringify(body))
  return dir
}

/** A pid nothing is running under. */
function gone(): number {
  // Not a made-up number: one taken and given back, so it is a pid shaped like
  // every other and simply not there any more.
  return 2_147_483_646
}

describe('reading who is working out of the lane file', () => {
  it('reports an agent lane the file holds, with what it last did', async () => {
    const probe = await laneLivenessFromFile(
      home({ lanes: [lane({ id: 'shop/refunds/agent', harness: 'claude-code' })] }),
    )
    expect(await probe.lanes('shop/refunds')).toEqual([
      {
        source: 'lane',
        provider: 'claude-code',
        sessionId: 'shop/refunds/agent',
        alive: true,
        lastActivityAt: 2_000,
        turn: 'unknown',
        pendingPermissions: [],
        consecutiveFailures: 0,
        exitCode: null,
      },
    ])
  })

  it('calls a lane dead whose pid has gone, whatever the file says', async () => {
    // The case this exists for. A window killed outright writes nothing on the
    // way out, so every lane it was holding is still `alive: true` in the file
    // — and reported as working, for ever, by a `tade status` that trusted it.
    const probe = await laneLivenessFromFile(
      home({ lanes: [lane({ id: 'shop/refunds/agent', alive: true, pid: gone() })] }),
    )
    const [signal] = await probe.lanes('shop/refunds')
    expect(signal?.alive).toBe(false)
    // Not alive means not mid-turn either: an agent that is gone is not thinking.
    expect(signal?.turn).toBe('idle')
  })

  it('calls a lane dead that has no pid at all', async () => {
    const probe = await laneLivenessFromFile(
      home({ lanes: [lane({ id: 'shop/refunds/agent', alive: true, pid: null })] }),
    )
    expect((await probe.lanes('shop/refunds'))[0]?.alive).toBe(false)
  })

  it('leaves a lane alive whose pid really is running', async () => {
    const probe = await laneLivenessFromFile(
      home({ lanes: [lane({ id: 'shop/refunds/agent', pid: process.pid })] }),
    )
    expect((await probe.lanes('shop/refunds'))[0]?.alive).toBe(true)
  })

  it('answers about the task it was asked about and no other', async () => {
    const probe = await laneLivenessFromFile(
      home({
        lanes: [
          lane({ id: 'shop/refunds/agent', task: 'shop/refunds' }),
          lane({ id: 'shop/vat/agent', task: 'shop/vat' }),
        ],
      }),
    )
    expect((await probe.lanes('shop/refunds')).map((s) => s.sessionId)).toEqual([
      'shop/refunds/agent',
    ])
  })

  it('counts only agents as who is working, and lists every lane as a lane', async () => {
    const probe = await laneLivenessFromFile(
      home({
        lanes: [
          lane({ id: 'shop/refunds/agent', kind: 'agent' }),
          lane({ id: 'shop/refunds/shell', kind: 'shell' }),
        ],
      }),
    )
    // A terminal somebody opened beside an agent is not a second agent.
    expect((await probe.lanes('shop/refunds')).map((s) => s.sessionId)).toEqual([
      'shop/refunds/agent',
    ])
    expect(await probe.records?.('shop/refunds')).toEqual([
      {
        id: 'shop/refunds/agent',
        kind: 'agent',
        alive: true,
        pid: process.pid,
        lastOutputAt: 2_000,
        attach: 'tade attach shop/refunds/agent',
      },
      {
        id: 'shop/refunds/shell',
        kind: 'shell',
        alive: true,
        pid: process.pid,
        lastOutputAt: 2_000,
        attach: 'tade attach shop/refunds/shell',
      },
    ])
  })

  it('names the program where a lane was written before harnesses had names', async () => {
    const probe = await laneLivenessFromFile(home({ lanes: [lane({ id: 'shop/refunds/agent' })] }))
    // No `harness` on the record, so what ran it is the command it ran.
    expect((await probe.lanes('shop/refunds'))[0]?.provider).toBe('pi')
  })

  it('says nobody is working rather than throwing, whatever the file is', async () => {
    // Status never throws. Each of these is a real state a home can be in: no
    // file yet, a half-written one, and one whose shape this Tade does not
    // know — the third being what an older or newer Tade leaves behind.
    const nothing = async (probe: LivenessProbe) => {
      expect(await probe.lanes('shop/refunds')).toEqual([])
      expect(await probe.records?.('shop/refunds')).toEqual([])
    }
    await nothing(await laneLivenessFromFile(tmp('tade-lanes-none-')))
    await nothing(await laneLivenessFromFile(home('{ half written')))
    await nothing(await laneLivenessFromFile(home({ lanes: 'not a list' })))
    await nothing(await laneLivenessFromFile(home({ lanes: [{ id: 'only-an-id' }] })))
    await nothing(await laneLivenessFromFile(home({})))
  })
})

describe('liveness from a workbench that is going wrong', () => {
  const nothingRunning: RunningWork = {
    lanes: () => [],
    runs: () => [],
    pendingApprovals: () => [],
  }

  it('answers with what it could get when part of the workbench throws', async () => {
    // `status` never throws and degrades to a partial answer. A registry that
    // throws must not take the runs with it, or an agent waiting on somebody
    // disappears from the page at the moment they are needed.
    const probe = livenessFrom({
      ...nothingRunning,
      lanes: () => {
        throw new Error('the registry is being rewritten')
      },
      runs: () => [
        { run: 'r1', task: 'shop/refunds', sessionId: 's1', startedAt: 1_000, lane: null },
      ],
    })
    expect((await probe.lanes('shop/refunds')).map((s) => s.sessionId)).toEqual(['r1'])
    expect(await probe.records?.('shop/refunds')).toEqual([])
  })

  it('reads a turn nobody can answer for as unknown rather than failing', async () => {
    const probe = livenessFrom({
      ...nothingRunning,
      runs: () => [
        { run: 'r1', task: 'shop/refunds', sessionId: 's1', startedAt: 1_000, lane: null },
      ],
      turnOf: () => {
        throw new Error('the supervisor has gone')
      },
    })
    expect((await probe.lanes('shop/refunds'))[0]?.turn).toBe('unknown')
  })

  it('is empty where the approvals cannot be read, rather than empty everywhere', async () => {
    const probe = livenessFrom({
      ...nothingRunning,
      runs: () => [
        { run: 'r1', task: 'shop/refunds', sessionId: 's1', startedAt: 1_000, lane: null },
      ],
      pendingApprovals: () => {
        throw new Error('gone')
      },
    })
    const [signal] = await probe.lanes('shop/refunds')
    expect(signal?.pendingPermissions).toEqual([])
    expect(signal?.alive).toBe(true)
  })
})
