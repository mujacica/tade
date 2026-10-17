import { describe, expect, it } from 'vitest'
import {
  type ChangedLine,
  copiedHosts,
  loopbackWrite,
  publicWrite,
  withoutCopies,
} from '../src/index.ts'

// The public name written alone, the trusted hostnames written only for a
// Caddy in front of the loopback listener, and which trusted hostnames the
// journal says Tade copied there — so that only those are ever taken back.

const NAME = 'tade.example.com'
const OLD = 'old.example.com'
const TAILNET = 'studio.ts.net'
const AT = Date.UTC(2026, 9, 16, 21)

const PUBLIC = 'surfaces.web.public'
const TRUSTED = 'surfaces.web.trusted_hosts'

/** A `config_changed` line, `ms` after `AT`. */
function changed(seq: number, ms: number, detail: Record<string, unknown>): ChangedLine {
  return { seq, ts: new Date(AT + ms).toISOString(), detail: { by: 'window', ...detail } }
}

/** What Settings wrote for a typed public name until 2026-10-17: the name, then its copy, one seq and no time apart. */
function copied(seq: number, ms: number, name: string, was: readonly string[]): ChangedLine[] {
  return [
    changed(seq, ms, { path: PUBLIC, was: '', now: name }),
    changed(seq + 1, ms, {
      path: TRUSTED,
      was: was.join(' '),
      now: [...was, name.toLowerCase()].join(' '),
    }),
  ]
}

describe('the public name, written', () => {
  it('is written alone, and never added to the trusted hostnames', () => {
    expect(publicWrite({ public: '', trusted_hosts: [TAILNET] }, 'Tade.Example.com.', [])).toEqual({
      public: NAME,
      trusted_hosts: [TAILNET],
      taken: [],
    })
  })

  it('is nothing to write where it already is the name', () => {
    expect(publicWrite({ public: 'TADE.example.com', trusted_hosts: [] }, NAME, [])).toBeNull()
    expect(publicWrite({ public: '', trusted_hosts: [] }, '', [])).toBeNull()
  })

  it('takes back what Tade copied, changed or cleared, and keeps what it did not', () => {
    const web = { public: OLD, trusted_hosts: [TAILNET, 'Old.Example.com'] }
    expect(publicWrite(web, NAME, [OLD])).toEqual({
      public: NAME,
      trusted_hosts: [TAILNET],
      taken: ['Old.Example.com'],
    })
    expect(publicWrite(web, '', [OLD])).toEqual({
      public: '',
      trusted_hosts: [TAILNET],
      taken: ['Old.Example.com'],
    })
    // Nothing the journal says Tade copied: nothing taken.
    expect(publicWrite(web, NAME, [])?.trusted_hosts).toEqual([TAILNET, 'Old.Example.com'])
  })

  it('takes back nothing that is not there', () => {
    expect(withoutCopies([TAILNET], [OLD])).toEqual({ trusted_hosts: [TAILNET], taken: [] })
  })
})

describe('the trusted hostnames, for a Caddy in front of the loopback listener', () => {
  it('has the name added to what was there, and never twice', () => {
    expect(loopbackWrite({ public: '', trusted_hosts: [TAILNET] }, 'Tade.Example.com')).toEqual([
      TAILNET,
      NAME,
    ])
    expect(loopbackWrite({ public: '', trusted_hosts: ['TADE.example.com'] }, NAME)).toBeNull()
  })
})

describe('what the journal says Tade copied into the trusted hostnames', () => {
  it("finds Settings' copy of a typed public name", () => {
    expect(copiedHosts(copied(10, 0, 'Old.Example.com', [TAILNET]))).toEqual([OLD])
  })

  it('reads the lines in the order they were written, whatever order they came in', () => {
    expect(copiedHosts(copied(10, 0, OLD, [TAILNET]).reverse())).toEqual([OLD])
  })

  it('never calls a name somebody put there a copy', () => {
    // Typed in on its own, with no public name written before it.
    expect(
      copiedHosts([changed(4, 0, { path: TRUSTED, was: TAILNET, now: `${TAILNET} ${OLD}` })]),
    ).toEqual([])
    const [wrote, copy] = copied(10, 0, OLD, [TAILNET])
    if (wrote === undefined || copy === undefined) throw new Error('two lines')
    // Typed a second later: another press.
    expect(copiedHosts([wrote, { ...copy, ts: new Date(AT + 1_500).toISOString() }])).toEqual([])
    // Something written between the two.
    expect(copiedHosts([wrote, { ...copy, seq: 12 }])).toEqual([])
    // By another hand.
    expect(
      copiedHosts([wrote, { ...copy, detail: { ...copy.detail, by: 'orchestrator' } }]),
    ).toEqual([])
    // A different name from the one the public name was written as.
    expect(
      copiedHosts([
        wrote,
        { ...copy, detail: { ...copy.detail, now: `${TAILNET} other.example.com` } },
      ]),
    ).toEqual([])
  })

  it('is theirs once somebody takes a copy away and puts the name back themselves', () => {
    const lines = [
      ...copied(10, 0, OLD, [TAILNET]),
      changed(20, 60_000, { path: TRUSTED, was: `${TAILNET} ${OLD}`, now: TAILNET }),
      changed(30, 120_000, { path: TRUSTED, was: TAILNET, now: `${TAILNET}, ${OLD}` }),
    ]
    expect(copiedHosts(lines)).toEqual([])
  })

  it('ends a copy once it is taken away, or once a later line shows it gone', () => {
    const taken = changed(12, 0, { path: TRUSTED, was: `${TAILNET} ${OLD}`, now: TAILNET })
    expect(copiedHosts([...copied(10, 0, OLD, [TAILNET]), taken])).toEqual([])
    // Gone by some way the journal did not see, such as the file edited by hand.
    const later = changed(20, 60_000, { path: TRUSTED, was: TAILNET, now: `${TAILNET} b.ts.net` })
    expect(copiedHosts([...copied(10, 0, OLD, [TAILNET]), later])).toEqual([])
  })

  it('keeps a copy through a later change that leaves it where it was', () => {
    const kept = changed(20, 60_000, {
      path: TRUSTED,
      was: `${TAILNET} ${OLD}`,
      now: `${TAILNET} ${OLD} b.ts.net`,
    })
    expect(copiedHosts([...copied(10, 0, OLD, [TAILNET]), kept])).toEqual([OLD])
  })

  it('never takes the line that took a copy back for a copy', () => {
    const lines = [
      ...copied(10, 0, OLD, [TAILNET]),
      changed(20, 60_000, { path: PUBLIC, was: OLD, now: NAME }),
      changed(21, 60_000, { path: TRUSTED, was: `${TAILNET} ${OLD}`, now: TAILNET }),
    ]
    expect(copiedHosts(lines)).toEqual([])
  })

  it('reads past a line it cannot read', () => {
    expect(copiedHosts([{ seq: 3, ts: 'never' }, ...copied(10, 0, OLD, [])])).toEqual([OLD])
  })
})
