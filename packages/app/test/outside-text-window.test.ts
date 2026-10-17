import { describe, expect, it } from 'vitest'
import { parseDiff } from '../src/diff.ts'
import { highlight } from '../src/highlight.ts'
import {
  focusTask,
  initialState,
  openSchedule,
  type ScheduleView,
  showPlan,
  toggleCheck,
  toggleSection,
  viewActions,
  withProjects,
  withTasks,
  withTerminals,
} from '../src/model.ts'
import { awayPanel } from '../src/panels/away/state.ts'
import { diffPanel } from '../src/panels/diff/state.ts'
import { evaluationsPanel } from '../src/panels/evaluations/state.ts'
import { filePanel } from '../src/panels/file/state.ts'
import { menuPanel } from '../src/panels/menu/state.ts'
import { modelPanel } from '../src/panels/models/state.ts'
import { racePanel } from '../src/panels/race/state.ts'
import { searchPanel } from '../src/panels/search/state.ts'
import { branchPanel } from '../src/panels/small/state.ts'
import { sourceLines, textLines, type ViewedFile } from '../src/viewer.ts'
import { expectOnlyText, hostile, see } from './outside-text.ts'
import { awayFixture } from './screens/scenarios/away.ts'
import { EVALUATION_SCREENS } from './screens/scenarios/evaluations.ts'
import { actions, base, NOW, utcClock } from './screens/scenarios/fixtures.ts'
import { RACE_SCREENS } from './screens/scenarios/races.ts'

// The rest of the window, drawn with outside text in it: the foot, the side's
// git and files, menus, search, models and devices, the queue and the watches,
// the ACTIONS page, a file and a patch, and what was weighed. The shared
// hostile string and the screen check are in `outside-text.ts`.

describe('the window around them', () => {
  it('draws what was pressed, an extension’s figure and a terminal’s name as text at the foot', () => {
    const state = {
      ...withTerminals(base(), [
        { id: 'checkout/terminals/1', project: 'checkout', name: hostile('tests') },
      ]),
      bottom: 'checkout/terminals/1',
      keyboard: 'terminal' as const,
    }
    expectOnlyText(
      see(state, {
        flash: `copied ${hostile('webhooks.ts')}`,
        statuses: [{ extension: 'jev', text: hostile('jev 2/4'), tone: 'quiet', viewable: true }],
        orchestratorAccount: { provider: 'openrouter', problem: hostile('no key') },
        terminal: { screen: '$ ' },
      }),
      'webhooks.ts',
      'jev 2/4',
      'tests',
      'no key',
    )
  })

  it('draws the GIT, CHANGES and FILES rows as the names somebody gave them, as text', () => {
    const side = toggleSection(base(), 'agents')
    expectOnlyText(
      see(side, {
        height: 80,
        where: {
          repo: `~/src/${hostile('repo')}`,
          branch: hostile('fix/branch'),
          base: hostile('main'),
          worktree: hostile('worktree'),
          path: `/Users/me/${hostile('pathpart')}`,
          links: [{ title: hostile('issue 7'), url: 'https://example.invalid/7' }],
        },
        changes: [{ path: `src/${hostile('changed.ts')}`, mark: 'M', added: 1, removed: 1 }],
        files: [
          { path: 'src', name: hostile('srcdir'), depth: 0, folder: true, open: true },
          { path: 'src/x.ts', name: hostile('x.ts'), depth: 1, folder: false, open: false },
        ],
      }),
      'fix/branch',
      'worktree',
      'changed.ts',
      'srcdir',
      'x.ts',
    )
  })

  it('draws a menu, a branch list and a project’s name as text', () => {
    const menu = {
      ...base(),
      panel: menuPanel({ kind: 'file', path: 'src/x.ts', folder: false }, hostile('menutitle')),
    }
    expectOnlyText(
      see(menu, {
        panel: { items: [{ id: 'open', label: hostile('itemlabel'), note: hostile('itemnote') }] },
      }),
      'menutitle',
      'itemlabel',
      'itemnote',
    )
    expectOnlyText(
      see(
        { ...base(), panel: branchPanel() },
        {
          panel: {
            checkout: hostile('main'),
            branches: [{ name: hostile('agentbranch'), current: false, when: '2 days ago' }],
          },
        },
      ),
      'agentbranch',
    )
    expectOnlyText(see({ ...base(), titles: { checkout: hostile('Checkout') } }), 'Checkout')
  })

  it('draws a search row as text, the letters it matched and the line it found included', () => {
    const entries = [
      {
        id: 'task:checkout/stripe-v15',
        kind: 'agent' as const,
        label: hostile('stripe'),
        detail: hostile('in checkout'),
        mark: '●',
        note: hostile('waiting'),
        hits: [0, 1, 2],
      },
      {
        id: 'match:src/x.ts:4',
        kind: 'match' as const,
        label: 'src/x.ts:4',
        mark: '≡',
        preview: `const ${hostile('webhook')} = 1`,
      },
    ]
    expectOnlyText(
      see({ ...base(), panel: searchPanel('webhook') }, { panel: { entries, searching: false } }),
      'stripe',
      'in checkout',
      'webhook',
    )
  })

  it('draws a model offered over the network, and a device at the door, as text', () => {
    const models = [
      {
        id: `openrouter/${hostile('evil-model')}`,
        provider: 'openrouter',
        name: hostile('Evil Model'),
        price: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      },
    ]
    expectOnlyText(
      see(
        { ...base(), panel: modelPanel('orchestrator') },
        {
          panel: {
            models,
            modelsFrom: { harness: 'pi', why: null },
            modelTarget: 'the orchestrator',
            currentModel: hostile('current-model'),
          },
        },
      ),
      'evil-model',
      'Evil Model',
      'current-model',
    )
    const away = awayFixture({
      asking: {
        label: hostile('iPhone'),
        from: hostile('your network'),
        address: '192.168.1.42',
        secondsLeft: 47,
        seconds: 60,
      },
    })
    const devices = away.devices.map((one) => ({ ...one, label: hostile(one.label) }))
    expectOnlyText(
      see({ ...base(), panel: awayPanel() }, { height: 80, panel: { away: { ...away, devices } } }),
      'iPhone',
      'your network',
      'MacBook',
    )
  })
})

describe('work that waits and work that watches', () => {
  const queued = () =>
    withTasks(withProjects(initialState(), ['checkout']), [
      { task: 'checkout/fix-charge', state: 'failed', reason: hostile('testsfailed') },
      {
        task: 'checkout/add-refunds',
        state: 'queued',
        by: 'orchestrator',
        queued: {
          state: { kind: 'held', on: 'checkout/fix-charge', because: hostile('heldbecause') },
          after: [{ task: 'checkout/fix-charge', why: hostile('waitwhy') }],
          prompt: `Add refunds. ${hostile('toldtext')}`,
          touches: ['src/refunds.ts'],
          at: null,
        },
      },
    ])

  it('draws the queue, a piece of it opened and the plan as text', () => {
    const fold = { folded: ['changes', 'files', 'notes', 'where'] }
    const opened = { ...focusTask(queued(), 'checkout/add-refunds'), ...fold }
    expectOnlyText(
      see(opened, { screen: '', height: 50, clock: utcClock }),
      'heldbecause',
      'waitwhy',
      'toldtext',
    )
    const plan = { ...showPlan(queued()), project: 'checkout', ...fold }
    expectOnlyText(see(plan, { screen: '', height: 50, clock: utcClock }), 'waitwhy')
  })

  it('draws what a watch found and why it could not look as text', () => {
    const watch: ScheduleView = {
      id: 'new-sentry-errors',
      name: hostile('Sentry errors'),
      project: 'checkout',
      said: '',
      kind: 'watch',
      does: 'looks with sentry.new-errors, and starts work on what it finds',
      prompt: hostile('fixwhatitfinds'),
      when: 'every hour',
      once: false,
      next: [NOW + 3_600_000],
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
            at: NOW - 60_000,
            found: 0,
            fresh: 0,
            left: 0,
            problem: hostile('ratelimited'),
            trouble: null,
            until: null,
            said: null,
          },
        ],
        findings: [
          {
            at: NOW - 60_000,
            key: '4413',
            title: hostile('CHECKOUT-3F'),
            task: null,
            told: null,
            problem: hostile('badgateway'),
          },
        ],
      },
    }
    const side = { ...base(), folded: ['changes', 'files', 'notes', 'where'] }
    expectOnlyText(
      see(side, { schedules: [watch], clock: utcClock }),
      'Sentry errors',
      'ratelimited',
    )
    const open = {
      ...openSchedule(withTasks(withProjects(initialState(), ['checkout']), []), watch.id),
      project: 'checkout',
    }
    expectOnlyText(
      see(open, { screen: '', height: 50, schedules: [watch], clock: utcClock }),
      'Sentry errors',
      'fixwhatitfinds',
      'CHECKOUT-3F',
      'badgateway',
      'ratelimited',
    )
  })
})

describe('what a project, git and its checks said', () => {
  it('draws the ACTIONS page as text: commits, checks, what they ran and printed', () => {
    const view = actions()
    const shown = {
      ...view,
      branch: hostile('tade/branch'),
      base: hostile('main'),
      mine: view.mine.map((one) => ({ ...one, subject: hostile('subjectline') })),
      others: view.others.map((one) => ({ ...one, task: hostile('their/task') })),
      unread: [hostile('unreadstep')],
      checks: view.checks.map((check) => ({
        ...check,
        id: hostile(check.id),
        run: hostile('pnpm test'),
        summary: hostile('summarised'),
        places: [{ path: `src/${hostile('failing.ts')}`, at: '4', note: hostile('expected') }],
        tail: [hostile('printedline')],
        needs: [hostile('build')],
      })),
    }
    const task = 'checkout/stripe-v15'
    const page = toggleSection(viewActions(base(), task), 'not-run-here', true)
    const state = shown.checks.reduce((was, check) => toggleCheck(was, task, check.id), page)
    expectOnlyText(
      see(state, { actions: shown, height: 120 }),
      'tade/branch',
      'subjectline',
      'pnpm test',
      'failing.ts',
      'printedline',
    )
  })

  it('draws a file, its inline changes and a patch as text, a tab still two columns', () => {
    const file: ViewedFile = {
      path: `/Users/me/src/checkout/${hostile('evil.ts')}`,
      size: 100,
      binary: false,
      truncated: false,
      language: 'typescript',
      mtimeMs: 0,
      error: null,
      text: `const a = 1 // ${hostile('comment')}\n\tindented ${hostile('more')}\n`,
    }
    const viewing = {
      file,
      source: sourceLines(file, true),
      text: textLines(file),
      formatted: null,
      inline: null,
    }
    expectOnlyText(
      see(
        { ...base(), panel: filePanel(file.path, 1) },
        { panel: { homeDir: '/Users/me', viewing } },
      ),
      'evil.ts',
      'comment',
      '│   indented',
    )
    // Coloured, the only escapes left are the colours put there.
    const coloured = highlight(file.text, 'typescript').join('\n')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: colour codes are what it steps past.
    expect(coloured.replace(/\x1b\[[0-9;]*m/g, '')).not.toContain('\x1b')
    const patch = [
      `diff --git a/src/x.ts b/src/x.ts`,
      '--- a/src/x.ts',
      '+++ b/src/x.ts',
      `@@ -1,2 +1,2 @@ ${hostile('hunkhead')}`,
      ` kept ${hostile('context')}`,
      `-gone ${hostile('removed')}`,
      `+came ${hostile('added')}`,
      '',
    ].join('\n')
    expectOnlyText(
      see(
        { ...base(), panel: diffPanel('checkout/stripe-v15', [hostile('x.ts')], 0) },
        { panel: { diff: parseDiff(patch) } },
      ),
      'hunkhead',
      'context',
      'removed',
      'added',
    )
  })
})

describe('what was weighed', () => {
  it('draws a race and a replay as text', () => {
    const raced = RACE_SCREENS[0]?.frame.races ?? []
    const races = raced.map((race) => ({
      ...race,
      name: hostile('dark-mode'),
      said: hostile('asked for'),
    }))
    expect(races.length).toBeGreaterThan(0)
    expectOnlyText(see({ ...base(), panel: racePanel() }, { races }), 'dark-mode', 'asked for')
    const replayed = EVALUATION_SCREENS.find((one) => one.name === 'evaluations-replays')
    const replays = replayed?.frame.replays
    expect(replays?.replays.length).toBeGreaterThan(0)
    const failing = {
      ...replays,
      judges: replays?.judges ?? null,
      replays: (replays?.replays ?? []).map((one) => ({
        ...one,
        entrants: one.entrants.map((entrant) => ({
          ...entrant,
          outcome: 'failed' as const,
          why: hostile('casefailed'),
        })),
      })),
    }
    expectOnlyText(
      see(
        { ...base(), panel: evaluationsPanel('replays') },
        { evaluations: replayed?.frame.evaluations, replays: failing, height: 80 },
      ),
      'casefailed',
    )
  })
})
