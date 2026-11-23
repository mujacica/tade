import { describe, expect, it } from 'vitest'
import { restarter } from '../src/assets/restart.js'
import { shellBars } from '../src/assets/shell-bars.js'
import { GRANTS } from '../src/reach.ts'
import { SCOPES } from '../src/surface.ts'

// The bars the shell raises about the page itself, moved out of `boot.js`
// whole: which stand for which state, in what order, and that the two that
// reload do so only on a press — and the restart bar's press, which the
// person's own phone has and every other device is told who has.

const NONE = { refused: null, restart: false, changed: false, newer: false }
const DOES = { reload: () => {}, update: () => {}, restart: () => {} }

const ASKED = {
  theirs: true,
  stops: 0,
  armed: false,
  busy: false,
  going: false,
  said: null,
  cannot: false,
}

/** The restart bar for one state of its press. */
function restartFor(over: Partial<typeof ASKED>) {
  const [bar] = shellBars({ ...NONE, restart: true, restarting: { ...ASKED, ...over } }, DOES)
  return bar
}

describe('the shell’s own bars', () => {
  it('raises none where nothing is owed', () => {
    expect(shellBars(NONE, DOES)).toEqual([])
  })

  it('stands them in their order: a copy refused, code newer, the page changed, a new version', () => {
    const all = shellBars({ refused: 'insecure', restart: true, changed: true, newer: true }, DOES)
    expect(all.map((one) => one.key)).toEqual(['refused', 'restart', 'changed', 'update'])
  })

  it('says why a copy was refused, by which of the two it was', () => {
    const [insecure] = shellBars({ ...NONE, refused: 'insecure' }, DOES)
    const [browser] = shellBars({ ...NONE, refused: 'browser' }, DOES)
    expect(insecure?.lead).toBe('This address cannot keep a copy of this page.')
    expect(browser?.lead).toBe('This browser will not keep a copy of this page.')
  })

  it('reloads only on a press', () => {
    const [changed] = shellBars({ ...NONE, changed: true }, DOES)
    const [update] = shellBars({ ...NONE, newer: true }, DOES)
    expect(changed?.press?.said).toBe('Reload')
    expect(update?.press?.said).toBe('Reload')
  })
})

describe('the restart bar', () => {
  it('offers a device without full access no press, and says who can restart it', () => {
    const [restart] = shellBars({ ...NONE, restart: true }, DOES)
    expect(restart?.press).toBeUndefined()
    expect(restart?.under).toContain('from a device with full access')
    expect(restartFor({ theirs: false })?.press).toBeUndefined()
  })

  it('offers the person’s own phone the restart itself', () => {
    const bar = restartFor({})
    expect(bar?.press?.said).toBe('Restart Tade')
    expect(bar?.press?.does).toBe(DOES.restart)
  })

  it('names the lanes that would stop before the press that stops them', () => {
    const bar = restartFor({ armed: true, stops: 2 })
    expect(bar?.key).toBe('restart-armed')
    expect(bar?.lead).toBe('Restarting stops 2 lanes running inside Tade.')
    expect(bar?.press?.said).toBe('Restart anyway')
    expect(restartFor({ armed: true, stops: 1 })?.lead).toContain('1 lane running')
  })

  it('takes its press away while asking and once Tade is going, each as a bar of its own', () => {
    const busy = restartFor({ busy: true })
    const going = restartFor({ going: true })
    expect(busy?.press).toBeUndefined()
    expect(going?.press).toBeUndefined()
    expect(going?.lead).toBe('Tade is starting again.')
    expect(new Set(['restart', busy?.key, going?.key]).size).toBe(3)
  })

  it('says what the machine said, and offers again only where pressing again could work', () => {
    const refused = restartFor({ said: 'Tade isn’t answering · Try again' })
    expect(refused?.under).toBe('Tade isn’t answering · Try again')
    expect(refused?.press?.said).toBe('Try again')
    const cannot = restartFor({ said: 'no window here', cannot: true })
    expect(cannot?.under).toBe('no window here')
    expect(cannot?.press).toBeUndefined()
  })
})

describe('the restart press', () => {
  // Every scope and grant: the person's own device, as `fullAccessOf` reads it.
  const FULL = { scopes: [...SCOPES], reads: [...GRANTS] }

  /** A press against answers in order, recording what was sent. */
  function pressing(answers: { status: number; body: unknown }[], you: unknown = FULL) {
    const sent: unknown[] = []
    let painted = 0
    const one = restarter(
      {
        ask: async (_method, path, body) => {
          sent.push({ path, body })
          return answers.shift() ?? { status: 0, body: null }
        },
        session: () => you,
      },
      () => {
        painted += 1
      },
    )
    return { one, sent, painted: () => painted }
  }

  const settle = () => new Promise((done) => setTimeout(done, 0))

  it('sends nought first, then the number the machine answered, and is going once it says so', async () => {
    const { one, sent } = pressing([
      { status: 200, body: { restarting: false, stops: 2, said: null } },
      { status: 200, body: { restarting: true, stops: 2, said: null } },
    ])
    one.press()
    await settle()
    expect(one.standing()).toMatchObject({ theirs: true, armed: true, stops: 2, going: false })
    one.press()
    await settle()
    expect(sent).toEqual([
      { path: '/api/restart', body: { stops: 0 } },
      { path: '/api/restart', body: { stops: 2 } },
    ])
    expect(one.going()).toBe(true)
    // Going, a press asks nothing more; back, it starts from nothing.
    one.press()
    await settle()
    expect(sent).toHaveLength(2)
    one.back()
    expect(one.standing()).toMatchObject({ armed: false, stops: 0, going: false, said: null })
  })

  it('keeps what the machine said where it cannot, and a trouble where nothing answered', async () => {
    const cannot = pressing([
      { status: 200, body: { restarting: false, stops: null, said: 'no window' } },
    ])
    cannot.one.press()
    await settle()
    expect(cannot.one.standing()).toMatchObject({ said: 'no window', cannot: true })
    const down = pressing([{ status: 0, body: null }])
    down.one.press()
    await settle()
    expect(down.one.standing().said).not.toBeNull()
    expect(down.one.standing().cannot).toBe(false)
  })

  it('reads whether this device may ask off its own session', () => {
    expect(pressing([], { scopes: ['read'], reads: [] }).one.standing().theirs).toBe(false)
  })
})
