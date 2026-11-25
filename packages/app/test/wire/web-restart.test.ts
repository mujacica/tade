import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Wiring } from '../../src/wire/context.ts'
import { NO_WINDOW, restartingFrom } from '../../src/wire/web-restart.ts'

// Tade started again from the person's own phone (`web-restart.ts`): the
// window's own reload, written down as the device's before it goes and started
// only once the answer has had its moment — and said, not offered, where
// nothing would start it again. With no face (`tade serve`) the count is the
// window's own fold over the lanes.

afterEach(() => {
  vi.useRealTimers()
})

/** The few parts of a window the half reaches, recording what it did. */
function wiring(
  reload: boolean,
  lanes: { detach: boolean; panes: number[]; terminals: number } = {
    detach: true,
    panes: [],
    terminals: 0,
  },
) {
  const did: string[] = []
  const wire = {
    state: {
      panes: lanes.panes.map((n, at) => ({
        task: `shop/${at}`,
        lanes: Array.from({ length: n }, (_, one) => ({ id: `shop/${at}/${one}`, kind: 'agent' })),
      })),
      terminals: Array.from({ length: lanes.terminals }, (_, one) => ({ id: `t${one}` })),
    },
    opts: {
      ...(reload && {
        reloadWindow: async () => {
          did.push('reload')
        },
      }),
      client: {
        driver: { capabilities: { detach: lanes.detach } },
        log: {
          append: async (event: { type: string; detail: Record<string, string> }) => {
            did.push(`${event.type} ${JSON.stringify(event.detail)}`)
          },
        },
      },
    },
    note: (err: unknown) => did.push(`noted ${String(err)}`),
  } as unknown as Wiring
  return { wire, did }
}

describe('restarting from the person’s own phone', () => {
  it('answers the lanes the window says a reload would end', () => {
    const { wire } = wiring(true)
    expect(restartingFrom(wire, () => 2).standing()).toEqual({ stops: 2 })
  })

  it('says it cannot where nothing would start it again: a `tade serve` no service keeps', () => {
    expect(restartingFrom(wiring(false).wire).standing()).toEqual({ cannot: NO_WINDOW })
    expect(restartingFrom(wiring(false).wire, () => 0).standing()).toEqual({ cannot: NO_WINDOW })
  })

  it('counts, with no face, what the window’s reload panel would: every lane, where they die with Tade', () => {
    // `tade serve` under the unit: its reload is the service's restart.
    const dying = wiring(true, { detach: false, panes: [2, 1], terminals: 1 })
    expect(restartingFrom(dying.wire).standing()).toEqual({ stops: 4 })
    const outliving = wiring(true, { detach: true, panes: [2, 1], terminals: 1 })
    expect(restartingFrom(outliving.wire).standing()).toEqual({ stops: 0 })
  })

  it('writes the restart down as the device’s, then reloads once, after the answer', async () => {
    vi.useFakeTimers()
    const { wire, did } = wiring(true)
    const half = restartingFrom(wire, () => 0)
    half.restart('00112233445566aa', false)
    half.restart('00112233445566aa', false)
    await vi.advanceTimersByTimeAsync(0)
    expect(did).toEqual(['web_did {"device":"00112233445566aa","verb":"restart","state":"done"}'])
    await vi.runAllTimersAsync()
    expect(did.filter((one) => one === 'reload')).toHaveLength(1)
    // Going, nothing is said to stop.
    expect(half.standing()).toEqual({ stops: 0 })
  })

  it('reloads every machine on a person’s press, as the strip’s reload does', async () => {
    vi.useFakeTimers()
    const { wire, did } = wiring(true)
    const half = restartingFrom(
      wire,
      () => 0,
      async () => {
        did.push('every machine')
      },
    )
    half.restart('00112233445566aa', false)
    await vi.runAllTimersAsync()
    expect(did.slice(1)).toEqual(['every machine'])
  })

  it('reloads this machine alone when another machine’s reload of every machine asks', async () => {
    // Fanning out again would ask the machine that is waiting for this one to come back.
    vi.useFakeTimers()
    const { wire, did } = wiring(true)
    const half = restartingFrom(
      wire,
      () => 0,
      async () => {
        did.push('every machine')
      },
    )
    half.restart('owner-link', true)
    await vi.runAllTimersAsync()
    expect(did.slice(1)).toEqual(['reload'])
  })

  it('restarts nothing anywhere where nothing would start this one again', async () => {
    vi.useFakeTimers()
    const { wire, did } = wiring(false)
    const half = restartingFrom(
      wire,
      () => 0,
      async () => {
        did.push('every machine')
      },
    )
    half.restart('00112233445566aa', false)
    await vi.runAllTimersAsync()
    expect(did).toEqual([])
  })
})
