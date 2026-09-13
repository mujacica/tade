import { PtyDriver } from '@wilco/drivers-pty'
import { TmuxDriver } from '@wilco/drivers-tmux'
import { describe, expect, it } from 'vitest'
import { chooseDriver } from '../src/workbench.ts'

// Where lanes go when the driver you asked for is not on this machine.
//
// Injected rather than probed, because the alternative is a test that only
// means something on a machine without tmux — which is not the machine anyone
// runs the suite on, and so would never actually check this.

const unavailable = (id: string, reason: string) => () =>
  Object.assign(new PtyDriver(), {
    id,
    available: async () => ({ ok: false, reason }),
  }) as unknown as PtyDriver

describe('choosing a driver', () => {
  const home = '/tmp/wilco-choice'

  it('uses the one you asked for when it can', async () => {
    const chosen = await chooseDriver({
      wanted: 'pty',
      fallback: 'pty',
      home,
      registry: { pty: () => new PtyDriver() },
    })
    expect(chosen.driver.id).toBe('pty')
    expect(chosen.warning).toBe('')
  })

  it('falls back, and says what happened and why', async () => {
    const chosen = await chooseDriver({
      wanted: 'tmux',
      fallback: 'pty',
      home,
      registry: { tmux: unavailable('tmux', 'tmux is not installed'), pty: () => new PtyDriver() },
    })
    expect(chosen.driver.id).toBe('pty')
    expect(chosen.warning).toContain('tmux is not installed')
    // The consequence, not just the substitution: this is the part that would
    // otherwise be discovered at the worst possible moment.
    expect(chosen.warning).toContain('will not outlive this window')
  })

  it('says nothing alarming when the fallback can do the same job', async () => {
    const chosen = await chooseDriver({
      wanted: 'ghostly',
      fallback: 'tmux',
      home,
      registry: {
        ghostly: unavailable('ghostly', 'no such terminal here'),
        tmux: () => new TmuxDriver({ socket: `wilco-test-${process.pid}` }),
      },
    })
    expect(chosen.driver.id).toBe('tmux')
    expect(chosen.warning).not.toContain('outlive')
  })

  it('refuses when the fallback is the driver itself', async () => {
    // Asking for the same thing twice is how you say "this or nothing".
    await expect(
      chooseDriver({
        wanted: 'tmux',
        fallback: 'tmux',
        home,
        registry: { tmux: unavailable('tmux', 'tmux is not installed') },
      }),
    ).rejects.toThrow(/tmux is not installed/)
  })

  it('refuses when neither can run here', async () => {
    await expect(
      chooseDriver({
        wanted: 'tmux',
        fallback: 'pty',
        home,
        registry: {
          tmux: unavailable('tmux', 'no tmux'),
          pty: unavailable('pty', 'no pseudo-terminals'),
        },
      }),
    ).rejects.toThrow(/neither/)
  })

  it('is an error, not a fallback, when the name means nothing at all', async () => {
    await expect(
      chooseDriver({ wanted: 'nowhere', fallback: 'pty', home, registry: {} }),
    ).rejects.toThrow(/unknown workspace driver/)
  })
})
