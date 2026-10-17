import type { DomainSeen } from '@tade/core'
import { RecordsAnswerSchema } from '@tade/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Wiring } from '../../src/wire/context.ts'
import { RECORDS_MS, recordsFrom } from '../../src/wire/web-records.ts'

// This machine's public name's records, looked at for an owner on another
// machine (`web-records.ts`): only where it has a public name and a window that
// dials, in the words `tade host domain` says them, one look for asks that
// arrive while it runs, and a look that runs out of time said as that.

afterEach(() => {
  vi.useRealTimers()
})

const NOW = Date.UTC(2026, 9, 17, 12, 0)

/** A look as `lookAtDomain` answers one for a name whose zone is found and whose records are right. */
function seen(name: string): DomainSeen {
  const found = (records: string[]) => ({ found: records, ttl: 300, validated: true })
  return {
    name,
    zone: { apex: 'example.com', servers: ['ns1.dns.example'] },
    own: {
      a: found(['203.0.113.7']),
      aaaa: { none: 'type', ttl: 300, validated: true },
      caa: { none: 'type', ttl: 300, validated: true },
    },
    world: { a: found(['203.0.113.7']), aaaa: { none: 'type', ttl: 300, validated: true } },
    caa: { at: name, answer: { none: 'type', ttl: 300, validated: true } },
    dnssec: { unsigned: true },
    here: { v4: ['203.0.113.7'], v6: [] },
    serving: ['203.0.113.7'],
    certificate: { at: NOW, cannot: 'not asked in a test' },
    account: { cannot: 'no Caddy here' },
  }
}

/** Just what the records half reads of the window: its public name, its look, its clock. */
function wiring(name: string, look: ((name: string) => Promise<DomainSeen>) | null): Wiring {
  return {
    opts: { config: { surfaces: { web: { public: name } } }, domain: look ?? undefined },
    now: () => NOW,
  } as unknown as Wiring
}

describe('this machine’s records, looked at for another machine', () => {
  it('says it has no public name, and asks the world nothing', async () => {
    const look = vi.fn(async (name: string) => seen(name))
    const answer = await recordsFrom(wiring('', look))()
    expect(answer).toMatchObject({ name: null, lines: [], cannot: 'it has no public name' })
    expect(look).not.toHaveBeenCalled()
    expect(RecordsAnswerSchema.safeParse(answer).success).toBe(true)
  })

  it('says a window that does not dial does not look, rather than asking the world', async () => {
    const answer = await recordsFrom(wiring('tade.example.com', null))()
    expect(answer).toMatchObject({
      name: 'tade.example.com',
      head: null,
      cannot: 'its window does not look at DNS',
    })
  })

  it('answers in the words `tade host domain` says, one look for asks that arrive while it runs', async () => {
    let looks = 0
    let finish: () => void = () => {}
    const records = recordsFrom(
      wiring('Tade.Example.com', async (name) => {
        looks++
        await new Promise<void>((done) => {
          finish = done
        })
        return seen(name)
      }),
    )
    const first = records()
    const second = records()
    finish()
    const [one, two] = await Promise.all([first, second])
    expect(looks).toBe(1)
    expect(two).toBe(one)
    expect(one.name).toBe('tade.example.com')
    expect(one.head).toBe(
      'tade.example.com, in the zone example.com, answered for by ns1.dns.example',
    )
    expect(one.lines.map((line) => line.record)).toEqual(['A', 'AAAA', 'DNSSEC', 'CAA'])
    expect(one.lines[0]).toMatchObject({ state: 'right', loud: false })
    expect(one.at).toBe(new Date(NOW).toISOString())
    expect(RecordsAnswerSchema.safeParse(one).success).toBe(true)
    // Asked again once that look is over, it looks again.
    await records()
    expect(looks).toBe(2)
  })

  it('says a look that runs out of time as that, and one that threw as why', async () => {
    vi.useFakeTimers()
    const late = recordsFrom(wiring('tade.example.com', () => new Promise(() => {})))()
    await vi.advanceTimersByTimeAsync(RECORDS_MS)
    expect((await late).cannot).toBe(`its look took longer than ${RECORDS_MS / 1000} s`)
    vi.useRealTimers()
    const threw = await recordsFrom(
      wiring('tade.example.com', async () => {
        throw new Error('no resolver answered')
      }),
    )()
    expect(threw.cannot).toBe('could not look: no resolver answered')
  })
})
