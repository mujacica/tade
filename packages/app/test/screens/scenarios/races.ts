import { type RacerFacts, racesIn, wonFrom } from '@tade/core'
import { racePanel } from '../../../src/panels/race/state.ts'
import { base, frame, NOW, type Scenario } from './fixtures.ts'

// A race, compared: three agents given one request side by side, each on its
// own harness or model, placed by core's own order (`racesIn`) rather than
// figures somebody typed into a frame — and the same race once it is decided.

const MINUTE = 60_000
const racer = (task: string, over: Partial<RacerFacts>): RacerFacts => ({
  task: `checkout/${task}`,
  race: 'dark-mode',
  project: 'checkout',
  said: 'add a dark mode to the receipt page',
  harness: 'pi',
  model: null,
  created: new Date(NOW - 90 * MINUTE).toISOString(),
  state: 'review',
  finished: true,
  checks: 'pass',
  failed: [],
  findings: { open: 0, answered: 0, confirmed: 0, dismissed: 0 },
  strayed: false,
  size: { commits: 2, added: 84, removed: 12 },
  usd: 0.62,
  ...over,
})

const entrants: RacerFacts[] = [
  racer('dark-mode-1', {
    harness: 'claude-code',
    model: 'claude-sonnet-5',
    size: { commits: 3, added: 140, removed: 31 },
    usd: 1.18,
  }),
  racer('dark-mode-2', {
    harness: 'codex',
    model: 'gpt-5-codex',
    checks: 'fail',
    failed: ['tests'],
    findings: { open: 1, answered: 0, confirmed: 0, dismissed: 0 },
    usd: 0.74,
  }),
  racer('dark-mode-3', {
    strayed: true,
    size: { commits: 1, added: 61, removed: 4 },
    usd: null,
  }),
]

const open = racesIn(entrants)
const decided = racesIn(
  entrants,
  wonFrom([
    {
      seq: 1,
      ts: new Date(NOW - 5 * MINUTE).toISOString(),
      type: 'race_won',
      task: 'checkout/dark-mode-1',
      lane: null,
      run: null,
      urgency: 'notable',
      detail: {
        race: 'dark-mode',
        project: 'checkout',
        by: 'you',
        why: 'picked in the window',
        closed: ['checkout/dark-mode-2', 'checkout/dark-mode-3'],
      },
    },
  ]),
)

export const RACE_SCREENS: Scenario[] = [
  {
    name: 'a-race-compared',
    about:
      'Three agents given one request, each on its own harness or model, in the order the facts ' +
      'put them — checks, whether the judge said one strayed from what was asked, findings, size — ' +
      'with what each cost and the race so far. Nobody has picked, and it says so.',
    state: { ...base(), panel: racePanel() },
    frame: frame({ races: open }),
  },
  {
    name: 'a-race-asking-before-it-picks',
    about:
      'Picking is a press said yes to, because it stops the others: what it does is said where it ' +
      'is pressed, and every branch is kept.',
    state: { ...base(), panel: { ...racePanel(), confirming: 'checkout/dark-mode-1' } },
    frame: frame({ races: open }),
  },
  {
    name: 'a-race-decided',
    about:
      'The same race once somebody picked: the one kept, who picked it and why, and the others ' +
      'closed with their branches kept.',
    state: { ...base(), panel: racePanel() },
    frame: frame({ races: decided }),
  },
  {
    name: 'no-race',
    about: 'No race going: the panel says how to start one rather than drawing an empty box.',
    state: { ...base(), panel: racePanel() },
    frame: frame({ races: [] }),
  },
]
