import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LaneHandle, LaneSpec, WorkspaceDriver } from '@tade/drivers-core'
import { PtyDriver } from '@tade/drivers-pty'
import { describe, expect, it } from 'vitest'
import { proveALane } from '../src/prove.ts'

// The check that proves a setup. The real one runs a real process in a real
// pty, because that is the whole point of it: a wizard that says "all set"
// without ever starting one is how `posix_spawnp failed.` reaches a user.
//
// The rest is answered by a driver that records what was asked of it. Twenty
// methods of the port for five that are used, so it is built by hand and cast:
// what is being tested is what `proveALane` does to a driver, and a driver
// that cannot open a lane is the thing being asked about rather than an error.

const HOME = mkdtempSync(join(tmpdir(), 'tade-prove-'))

interface Fake {
  driver: WorkspaceDriver
  calls: string[]
}

function fakeDriver(
  over: {
    available?: () => Promise<{ ok: true } | { ok: false; reason: string }>
    open?: (spec: LaneSpec) => Promise<LaneHandle>
    output?: string
    exit?: { code: number | null } | null
  } = {},
): Fake {
  const calls: string[] = []
  const driver = {
    id: 'fake',
    capabilities: { detach: true },
    async available() {
      calls.push('available')
      return over.available ? over.available() : { ok: true as const }
    },
    async open(spec: LaneSpec) {
      calls.push(`open ${spec.command} ${spec.args.join(' ')}`)
      if (over.open) return over.open(spec)
      return { id: spec.id } as LaneHandle
    },
    onOutput(_lane: string, listener: (chunk: Uint8Array) => void) {
      calls.push('onOutput')
      if (over.output !== undefined) listener(new TextEncoder().encode(over.output))
      return () => {}
    },
    onExit(_lane: string, listener: (exit: { code: number | null }) => void) {
      calls.push('onExit')
      // Null is a lane that never ends, which is what the deadline is for.
      if (over.exit !== null) listener(over.exit ?? { code: 0 })
      return () => {}
    },
    async capture() {
      calls.push('capture')
      return ''
    },
    async close() {
      calls.push('close')
    },
    async detach() {
      calls.push('detach')
    },
    async shutdown() {
      calls.push('shutdown')
    },
  }
  return { driver: driver as unknown as WorkspaceDriver, calls }
}

describe('proving that a lane opens', () => {
  it('opens one, runs a command in it, reads what it printed and closes it', async () => {
    // The real driver and a real process: nothing here is a double.
    const proof = await proveALane({
      driver: 'pty',
      home: HOME,
      cwd: process.cwd(),
      make: () => new PtyDriver(),
    })
    expect(proof).toMatchObject({ ok: true, driver: 'pty' })
    expect(proof.says).toContain('ran a command in it')
  }, 30_000)

  it('leaves nothing behind, and never ends anybody else’s lanes', async () => {
    // `detach`, never `shutdown`: under tmux the lanes of one home share a
    // session and shutting the driver down kills it, so proving that a lane
    // can open would have ended every agent working in that checkout.
    const fake = fakeDriver({ output: 'tade-lane-ok' })
    const proof = await proveALane({
      driver: 'fake',
      home: HOME,
      cwd: '/tmp',
      make: () => fake.driver,
    })
    expect(proof.ok).toBe(true)
    expect(fake.calls).toContain('close')
    expect(fake.calls).toContain('detach')
    expect(fake.calls).not.toContain('shutdown')
    // Closed before it is let go of, or a tmux window would outlive the driver
    // that could still have closed it.
    expect(fake.calls.indexOf('close')).toBeLessThan(fake.calls.indexOf('detach'))
  })

  it('closes the lane even where the command never finishes', async () => {
    const fake = fakeDriver({ exit: null })
    const proof = await proveALane({
      driver: 'fake',
      home: HOME,
      cwd: '/tmp',
      make: () => fake.driver,
      deadlineMs: 50,
    })
    expect(proof.ok).toBe(false)
    expect(proof.says).toContain('never finished')
    expect(fake.calls).toContain('close')
    expect(fake.calls).toContain('detach')
  })

  it('says the driver’s own reason where it cannot run here', async () => {
    const fake = fakeDriver({
      available: async () => ({ ok: false, reason: 'tmux is not installed (brew install tmux)' }),
    })
    const proof = await proveALane({
      driver: 'fake',
      home: HOME,
      cwd: '/tmp',
      make: () => fake.driver,
    })
    expect(proof).toMatchObject({ ok: false, says: 'tmux is not installed (brew install tmux)' })
    // Nothing was opened, so there was nothing to run.
    expect(fake.calls).not.toContain('onExit')
  })

  it('says what went wrong rather than throwing it', async () => {
    const fake = fakeDriver({
      open: async () => {
        throw new Error('posix_spawnp failed.\nand a second line nobody reads')
      },
    })
    const proof = await proveALane({
      driver: 'fake',
      home: HOME,
      cwd: '/tmp',
      make: () => fake.driver,
    })
    expect(proof.ok).toBe(false)
    // One line: this is read on a checklist.
    expect(proof.says).toBe('a lane could not be opened under fake: posix_spawnp failed.')
  })

  it('does not take a command that exited badly, or one that printed nothing, for a lane', async () => {
    const angry = fakeDriver({ exit: { code: 3 }, output: 'no such file' })
    const said = await proveALane({
      driver: 'fake',
      home: HOME,
      cwd: '/tmp',
      make: () => angry.driver,
    })
    expect(said.ok).toBe(false)
    expect(said.says).toContain('exited 3')
    expect(said.says).toContain('no such file')

    // Exited 0 and said nothing: a driver that cannot read a lane back is not
    // a lane Tade can watch an agent in.
    const quiet = fakeDriver({ output: '' })
    const quietly = await proveALane({
      driver: 'fake',
      home: HOME,
      cwd: '/tmp',
      make: () => quiet.driver,
    })
    expect(quietly.ok).toBe(false)
    expect(quietly.says).toContain('nothing it printed came back')
  })

  it('names the drivers there are when asked for one that does not exist', async () => {
    const proof = await proveALane({ driver: 'ghostty', home: HOME, cwd: '/tmp' })
    expect(proof).toMatchObject({ ok: false, driver: 'ghostty' })
    expect(proof.says).toContain('pty')
    expect(proof.says).toContain('tmux')
  })
})
