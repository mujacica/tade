import { describe, expect, it } from 'vitest'
import {
  behindIn,
  endedIn,
  failureLines,
  mayOffer,
  type Outcome,
  outcomeSays,
  stepsNamed,
  typedFor,
} from '../src/updates.ts'
import { lookWith, program } from './updates-fixture.ts'

// Moving what Tade runs forward, as pure functions: which steps there are,
// the line typed for one, and reading how it ended out of what a terminal
// printed. What it costs to run one is `wire/updates.test.ts`'s.

describe('what can move forward', () => {
  it('is what the last check said is behind and has a command, Tade first', () => {
    const look = lookWith({
      tadeNewer: true,
      programs: [
        program('gh', { title: 'GitHub CLI', behind: true }),
        program('tmux'),
        program('claude', { behind: true, run: null }),
      ],
    })
    const steps = behindIn(look)
    expect(steps.map((step) => step.about)).toEqual(['tade', 'gh'])
    expect(steps[1]).toMatchObject({
      title: 'GitHub CLI',
      command: 'brew upgrade gh',
      from: '1.0.0',
      to: '1.1.0',
    })
  })

  it('is nothing before anybody asked what is current', () => {
    // Behind is a claim about what is current, and nobody asked.
    expect(behindIn(lookWith({ asked: false, tadeNewer: true }))).toEqual([])
    expect(behindIn(null)).toEqual([])
  })

  it('takes what somebody named, by command, title or tade, behind or not', () => {
    const look = lookWith({
      programs: [program('gh', { title: 'GitHub CLI' }), program('tmux', { behind: true })],
    })
    expect(stepsNamed(look, ['GitHub CLI']).map((step) => step.about)).toEqual(['gh'])
    expect(stepsNamed(look, ['TADE', 'tmux']).map((step) => step.about)).toEqual(['tade', 'tmux'])
    // Nothing named is everything behind.
    expect(stepsNamed(look, []).map((step) => step.about)).toEqual(['tmux'])
    // A name with no command behind it is not a step: Tade types only what it knows.
    expect(stepsNamed(lookWith({ tadeRun: null }), ['tade'])).toEqual([])
    expect(stepsNamed(look, ['nothing-here'])).toEqual([])
  })
})

describe('the line typed, and how it ended', () => {
  it('types the command exactly as the page drew it, then how it ended', () => {
    const typed = typedFor('brew upgrade gh', 'ab12')
    expect(typed.startsWith('brew upgrade gh && ')).toBe(true)
  })

  it('never reads the line the shell echoed back as its ending', () => {
    // The word that comes out is never a word that went in: a terminal echoing
    // what was typed must not be read as having finished.
    const typed = typedFor('brew upgrade gh', 'ab12')
    expect(endedIn(`$ ${typed}\r\n`, 'ab12')).toBeNull()
    expect(endedIn(`$ ${typed}\r\n==> Upgrading gh\r\ntade-update-ab12-ok\r\n`, 'ab12')).toBe('ok')
    expect(endedIn(`$ ${typed}\r\nError: no\r\ntade-update-ab12-failed\r\n`, 'ab12')).toBe('failed')
  })

  it('reads only its own ending, never an earlier run’s', () => {
    expect(endedIn('tade-update-9999-ok\n', 'ab12')).toBeNull()
  })

  it('says the last lines a failure printed, without the line typed or older output', () => {
    const typed = typedFor('brew upgrade gh', 'ab12')
    const screen = [
      'an earlier command’s output',
      `$ ${typed.slice(0, 40)}`,
      typed.slice(40),
      '==> Upgrading gh',
      '',
      'Error: gh 2.41 is already installed',
      'tade-update-ab12-failed',
      '$',
    ].join('\n')
    expect(failureLines(screen, 'ab12')).toEqual([
      '==> Upgrading gh',
      'Error: gh 2.41 is already installed',
    ])
    expect(failureLines(screen, 'ab12', 1)).toEqual(['Error: gh 2.41 is already installed'])
  })
})

describe('what a run says', () => {
  const step = (about: string, title: string, to: string | null = null) => ({
    about,
    title,
    command: `update ${about}`,
    from: null,
    to,
  })
  const outcome = (over: Partial<Outcome> & Pick<Outcome, 'step'>): Outcome => ({
    ended: 'ok',
    lines: [],
    ...over,
  })

  it('says what moved, and where a program moved to', () => {
    const said = outcomeSays(
      [
        outcome({ step: step('tade', 'Tade') }),
        outcome({ step: step('gh', 'GitHub CLI', '2.41') }),
      ],
      'the updates terminal',
    )
    expect(said).toBe('Updated Tade, GitHub CLI to 2.41.')
  })

  it('says a failure with its command, the last of what it printed, and where the rest is', () => {
    const said = outcomeSays(
      [outcome({ step: step('gh', 'GitHub CLI'), ended: 'failed', lines: ['Error: locked'] })],
      'the updates terminal',
    )
    expect(said).toContain('GitHub CLI (`update gh`) failed: Error: locked.')
    expect(said).toContain('The whole of what it printed is in the updates terminal.')
  })

  it('says a closed terminal and a run that outlasted the wait as what they are', () => {
    expect(
      outcomeSays([outcome({ step: step('gh', 'gh'), ended: 'closed' })], 'the updates terminal'),
    ).toContain('the terminal it ran in was closed before it finished')
    expect(
      outcomeSays([outcome({ step: step('gh', 'gh'), ended: 'waited' })], 'the updates terminal'),
    ).toContain('still running when Tade stopped waiting — the updates terminal has it')
  })
})

describe('offering the reload on a panel of its own', () => {
  it('never over a panel somebody has open, nor while somebody is typing', () => {
    const now = 100_000
    expect(mayOffer({ panel: null, lastInputAt: null }, now)).toBe(true)
    expect(mayOffer({ panel: { kind: 'keys' } as never, lastInputAt: null }, now)).toBe(false)
    expect(mayOffer({ panel: null, lastInputAt: now - 1_000 }, now)).toBe(false)
    expect(mayOffer({ panel: null, lastInputAt: now - 60_000 }, now)).toBe(true)
  })
})
