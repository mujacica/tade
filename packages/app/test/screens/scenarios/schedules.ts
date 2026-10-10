import {
  initialState,
  openSchedule,
  type ScheduleView,
  withProjects,
  withTasks,
} from '../../../src/model.ts'
import { frame, type Scenario, showing, utcClock, utcDate } from './fixtures.ts'
import { queueSchedules, queueTasks } from './queue.ts'

// Schedules and watches: a rule, and what to do each time it comes due.

/** A watch Sentry offers, turned on: what it found at its last look, and each look. */
const sentryWatch: ScheduleView = {
  id: 'new-sentry-errors',
  name: 'New Sentry errors',
  project: 'checkout',
  said: '',
  kind: 'watch',
  does: 'looks with sentry.new-errors, and starts work on what it finds',
  prompt: '',
  when: 'every hour',
  once: false,
  next: [
    Date.parse('2026-09-14T10:00:00Z'),
    Date.parse('2026-09-14T11:00:00Z'),
    Date.parse('2026-09-14T12:00:00Z'),
  ],
  paused: false,
  by: 'extension:sentry',
  missed: 'once',
  runs: [],
  watch: {
    id: 'sentry.new-errors',
    turnedOnBy: 'you',
    found: 'agent',
    most: 2,
    looks: [
      {
        at: Date.parse('2026-09-14T09:00:00Z'),
        found: 3,
        fresh: 3,
        left: 1,
        problem: null,
        trouble: null,
        until: null,
        said: null,
      },
      {
        at: Date.parse('2026-09-14T08:00:00Z'),
        found: 1,
        fresh: 0,
        left: 0,
        problem: null,
        trouble: null,
        until: null,
        said: null,
      },
      {
        at: Date.parse('2026-09-14T07:00:00Z'),
        found: 0,
        fresh: 0,
        left: 0,
        problem: 'Sentry is rate limiting these requests (429): try again in a minute',
        trouble: null,
        until: null,
        said: null,
      },
    ],
    findings: [
      {
        at: Date.parse('2026-09-14T09:00:00Z'),
        key: '4413',
        title: 'CHECKOUT-3F: Error: card_declined is not handled',
        task: null,
        told: null,
        problem: 'Sentry answered 502: Bad Gateway',
      },
      {
        at: Date.parse('2026-09-14T09:00:00Z'),
        key: '4412',
        title: "CHECKOUT-3E: TypeError: Cannot read properties of undefined (reading 'amount')",
        task: 'checkout/fix-checkout-3e',
        told: null,
        problem: null,
      },
      {
        at: Date.parse('2026-09-13T16:00:00Z'),
        key: '4398',
        title: 'CHECKOUT-3A: RangeError: Invalid currency code',
        task: 'checkout/fix-checkout-3a',
        told: null,
        problem: null,
      },
    ],
  },
}

export const SCHEDULE_SCREENS: Scenario[] = [
  {
    name: 'a-schedule',
    about:
      'A schedule open where an agent’s screen would be: when it runs and what it does, what its agent is told, its next runs, what happens to runs Tade was closed for, who made it, and each time it ran.',
    state: {
      ...openSchedule(
        withTasks(withProjects(initialState(), ['checkout']), queueTasks),
        'deps-weekly',
      ),
      project: 'checkout',
      folded: ['changes', 'files', 'notes', 'where'],
      ...showing('checkout', { scope: 'next' }),
    },
    frame: frame({
      screen: '',
      height: 44,
      clock: utcClock,
      date: utcDate,
      schedules: queueSchedules,
    }),
  },
  {
    name: 'a-watch',
    about:
      'A watch Sentry offers, turned on and open: how often it looks and what it starts, how many one look acts on, who turned it on, what it found and what became of each, and how each look went.',
    state: {
      ...openSchedule(
        withTasks(withProjects(initialState(), ['checkout']), [
          ...queueTasks,
          {
            task: 'checkout/fix-checkout-3e',
            state: 'working',
            lane: 'checkout/fix-checkout-3e/agent',
            by: 'schedule:new-sentry-errors',
          },
        ]),
        'new-sentry-errors',
      ),
      project: 'checkout',
      folded: ['changes', 'files', 'notes', 'where'],
      ...showing('checkout', { scope: 'next' }),
    },
    frame: frame({
      screen: '',
      height: 44,
      clock: utcClock,
      date: utcDate,
      schedules: [...queueSchedules, sentryWatch],
    }),
  },
]
