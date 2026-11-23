import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Wiring } from '../../src/wire/context.ts'
import { NO_WINDOW, restartingFrom } from '../../src/wire/web-restart.ts'

// Tade started again from the person's own phone (`web-restart.ts`): the
// window's own reload, written down as the device's before it goes and started
// only once the answer has had its moment — and said, not offered, where there
// is no window to start again.

afterEach(() => {
  vi.useRealTimers()
})

/** The few parts of a window the half reaches, recording what it did. */
function wiring(reload: boolean) {
  const did: string[] = []
  const wire = {
    opts: {
      ...(reload && {
        reloadWindow: async () => {
          did.push('reload')
        },
      }),
      client: {
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

  it('says it cannot where there is no face to ask, or no window to start again', () => {
    expect(restartingFrom(wiring(true).wire).standing()).toEqual({ cannot: NO_WINDOW })
    expect(restartingFrom(wiring(false).wire, () => 0).standing()).toEqual({ cannot: NO_WINDOW })
  })

  it('writes the restart down as the device’s, then reloads once, after the answer', async () => {
    vi.useFakeTimers()
    const { wire, did } = wiring(true)
    const half = restartingFrom(wire, () => 0)
    half.restart('00112233445566aa')
    half.restart('00112233445566aa')
    await vi.advanceTimersByTimeAsync(0)
    expect(did).toEqual(['web_did {"device":"00112233445566aa","verb":"restart","state":"done"}'])
    await vi.runAllTimersAsync()
    expect(did.filter((one) => one === 'reload')).toHaveLength(1)
    // Going, nothing is said to stop.
    expect(half.standing()).toEqual({ stops: 0 })
  })
})
