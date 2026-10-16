import { type RacerFacts, racesIn } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { raceClick, raceKey, racePanel } from '../src/panels/race/state.ts'

// What a key or a click does to the race panel: walking entrants and races,
// reading a change, and a pick that is asked, said yes to, or let go — and
// never offered for a race somebody already decided.

const racer = (task: string, race = 'dark'): RacerFacts => ({
  task: `app/${task}`,
  race,
  project: 'app',
  said: 'add a dark mode',
  harness: 'pi',
  model: null,
  created: '2026-10-16T09:00:00.000Z',
  state: 'review',
  finished: true,
  checks: 'pass',
  failed: [],
  findings: { open: 0, answered: 0, confirmed: 0, dismissed: 0 },
  strayed: false,
  size: { commits: 1, added: 1, removed: 0 },
  usd: null,
})

const races = racesIn([racer('dark-1'), racer('dark-2'), racer('blue-1', 'blue')])

describe('the race panel', () => {
  it('walks the entrants and the races, and reads a change once it has been looked at', () => {
    const down = raceKey(racePanel(), 'down', '', { races })
    expect(down.panel).toMatchObject({ kind: 'race', index: 1 })
    const next = raceKey(racePanel(), 'right', '', { races })
    expect(next.panel).toMatchObject({ race: 1, index: 0 })
    const unread = raceKey(racePanel(), 'enter', '', { races })
    expect(unread.panel).toMatchObject({ said: 'what dark-1 changed has not been looked at yet' })
    const read = raceKey(racePanel(), 'enter', '', {
      races,
      raceFiles: { 'app/dark-1': ['theme.ts'] },
    })
    expect(read.panel?.kind).toBe('diff')
    expect(raceKey(racePanel(), undefined, 'a', { races })).toMatchObject({
      submit: true,
      choice: 'agent:app/dark-1',
    })
  })

  it('asks before it picks, and picks only on yes', () => {
    const asked = raceKey(racePanel(), undefined, 'p', { races })
    expect(asked.panel).toMatchObject({ confirming: 'app/dark-1' })
    expect(asked.submit).toBeFalsy()
    const panel = asked.panel as ReturnType<typeof racePanel>
    expect(raceKey(panel, 'escape', '', { races }).panel).toMatchObject({ confirming: null })
    expect(raceKey(panel, 'enter', '', { races })).toMatchObject({
      submit: true,
      choice: 'pick:app/dark-1',
    })
    expect(raceClick(panel, 'confirm', { races })).toMatchObject({ choice: 'pick:app/dark-1' })
  })

  it('offers no pick of a race already decided, and says whose it was', () => {
    const decided = racesIn(
      [racer('dark-1'), racer('dark-2')],
      new Map([
        [
          'app/dark',
          {
            race: 'dark',
            project: 'app',
            task: 'app/dark-2',
            by: 'you',
            why: '',
            at: '2026-10-16T10:00:00.000Z',
            closed: ['app/dark-1'],
          },
        ],
      ]),
    )
    const asked = raceClick(racePanel(), 'pick', { races: decided })
    expect(asked.panel).toMatchObject({
      confirming: null,
      said: 'dark was decided already: dark-2 was picked',
    })
  })
})
