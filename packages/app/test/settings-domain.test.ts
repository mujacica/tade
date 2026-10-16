import { stripTerminalSequences } from '@earendil-works/pi-tui'
import type { DomainLine, DomainSeen } from '@tade/core'
import { describe, expect, it } from 'vitest'
import type { PanelContext } from '../src/panels/context.ts'
import { type DomainView, domainLines, LOOK_AGAIN } from '../src/panels/settings/domain.ts'
import { settingsClick, settingsPanel } from '../src/panels/settings/state.ts'
import { skinFor } from '../src/skin.ts'
import { DomainLook } from '../src/wire/web-domain.ts'

// The records a public name needs, under its row in Settings: drawn whole —
// a record cut to fit is one somebody types in wrong — and looked at when the
// page shows the row and on a press, never on a clock. Through the window it
// is `wire/away-domain.test.ts`.

const NAME = 'tade.example.com'
const DS =
  'example.com. DS 50719 13 2 D602C971A02AF89B7661B99D6DD1B9E2EC876617631D04F633902A42CD4D6BBD'

const ctx = {
  skin: skinFor({}, false),
  pointer: { hover: null, pressed: null },
} as unknown as PanelContext

const text = (view: DomainView, width = 60) =>
  domainLines(view, ctx, width).map((line) => stripTerminalSequences(line.text).trimEnd())

const line = (over: Partial<DomainLine>): DomainLine => ({
  record: 'A',
  state: 'right',
  said: 'A: right',
  add: null,
  remove: [],
  loud: false,
  ...over,
})

describe('the records, drawn', () => {
  it('says it is looking before the first look comes back, with the button', () => {
    const drawn = text({ name: NAME, looking: true, head: null, lines: [] })
    expect(drawn[0]).toMatch(/^ Records +\[ Looking… \]$/)
    expect(drawn[1]).toBe(`   looking at the records for ${NAME} from here`)
    const hit = domainLines({ name: NAME, looking: false, head: null, lines: [] }, ctx, 60)[0]?.hits
    expect(hit?.some((one) => one.target.kind === 'control' && one.target.id === LOOK_AGAIN)).toBe(
      true,
    )
  })

  it('marks each record, and writes what to add and take away out whole', () => {
    const drawn = text({
      name: NAME,
      looking: false,
      head: `${NAME}, in the zone example.com`,
      lines: [
        line({ state: 'missing', loud: true, said: 'A: missing', add: `${NAME}. A 203.0.113.7` }),
        line({ record: 'AAAA', said: 'AAAA: right' }),
        line({
          record: 'DNSSEC',
          state: 'wrong',
          loud: true,
          said: 'DNSSEC: broken',
          add: DS,
          remove: [DS],
        }),
        line({ record: 'CAA', state: 'later', said: 'CAA: after the first certificate' }),
      ],
    })
    expect(drawn[0]).toMatch(/\[ Look again \]$/)
    expect(drawn).toContain(`   ${NAME}, in the zone example.com`)
    expect(drawn).toContain(' ▲ A: missing')
    expect(drawn).toContain(`     add ${NAME}. A 203.0.113.7`)
    expect(drawn).toContain(' ✓ AAAA: right')
    expect(drawn).toContain(' · CAA: after the first certificate')
    // Wider than the page, and every character of it still there.
    const joined = drawn.join('')
    expect(joined.replace(/\s+/g, '')).toContain(`add${DS}`.replace(/\s+/g, ''))
    expect(joined.replace(/\s+/g, '')).toContain(`remove${DS}`.replace(/\s+/g, ''))
  })

  it('is pressed as a look, from the page', () => {
    const outcome = settingsClick(settingsPanel('away'), LOOK_AGAIN, { settings: [] })
    expect(outcome).toMatchObject({ submit: true, choice: LOOK_AGAIN })
  })
})

describe('looking, from the window', () => {
  function looking() {
    const asked: string[] = []
    const answers: ((seen: DomainSeen) => void)[] = []
    let draws = 0
    let dials = true
    const look = new DomainLook({
      look: () =>
        dials
          ? (name) => {
              asked.push(name)
              return new Promise((done) => answers.push(done))
            }
          : null,
      draw: () => {
        draws += 1
      },
    })
    return {
      look,
      asked,
      answer: async (seen: DomainSeen) => {
        answers.shift()?.(seen)
        await new Promise((done) => setTimeout(done, 0))
      },
      draws: () => draws,
      offline: () => {
        dials = false
      },
    }
  }

  const SEEN = { name: NAME, zone: { cannot: 'no answer' } } as unknown as DomainSeen

  it('looks once for each opening of the page, and again on a press', async () => {
    const it = looking()
    it.look.want(NAME)
    it.look.want(NAME)
    expect(it.asked).toEqual([NAME])
    expect(it.look.view(NAME)).toEqual({ name: NAME, looking: true, head: null, lines: [] })
    // A press while one is under way is the one under way.
    it.look.again()
    expect(it.asked).toHaveLength(1)
    await it.answer({
      ...SEEN,
      own: null,
      world: { a: { failed: 'x' }, aaaa: { failed: 'x' } },
      caa: { at: NAME, answer: { failed: 'x' } },
      dnssec: { cannot: 'x' },
      here: { v4: [], v6: [] },
      serving: [],
      certificate: { at: 0, cannot: 'x' },
      account: { cannot: 'x' },
    })
    const view = it.look.view(NAME)
    expect(view?.looking).toBe(false)
    expect(view?.head).toContain('could not be found')
    expect(view?.lines.map((one) => one.record)).toEqual(['A', 'AAAA', 'DNSSEC', 'CAA'])
    expect(it.draws()).toBeGreaterThanOrEqual(2)
    it.look.want(NAME)
    expect(it.asked).toHaveLength(1)
    it.look.again()
    expect(it.asked).toHaveLength(2)
  })

  it('looks again when the page is opened again, and at a new name at once', async () => {
    const it = looking()
    it.look.want(NAME)
    await it.answer(SEEN)
    it.look.forget()
    it.look.want(NAME)
    expect(it.asked).toEqual([NAME, NAME])
    await it.answer(SEEN)
    it.look.want('box.example.com')
    expect(it.asked).toEqual([NAME, NAME, 'box.example.com'])
    expect(it.look.view(NAME)).toBeNull()
    // The answer to a name nobody is looking at any more is not drawn for the new one.
    it.look.forget()
  })

  it('says why where a look threw, rather than looking for ever', async () => {
    let calls = 0
    const look = new DomainLook({
      look: () => async () => {
        calls += 1
        throw new Error('the resolver went away')
      },
      draw: () => {},
    })
    look.want(NAME)
    await new Promise((done) => setTimeout(done, 0))
    expect(calls).toBe(1)
    expect(look.view(NAME)).toEqual({
      name: NAME,
      looking: false,
      head: 'could not look: the resolver went away',
      lines: [],
    })
  })

  it('draws nothing, and asks nothing, where the window may not dial', () => {
    const it = looking()
    it.offline()
    it.look.want(NAME)
    expect(it.asked).toEqual([])
    expect(it.look.view(NAME)).toBeNull()
  })
})
