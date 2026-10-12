import { checkPlan, type PlanBusy, type PlannedAgent } from '@tade/core'
import { describe, expect, it } from 'vitest'
import type { TaskSnapshot } from '../src/model.ts'
import { planBusyOf } from '../src/queue.ts'

// The plan made at 02:33:58Z on 2026-10-11 (PDT), against tade as it stood:
// every task's waits and touches as its task file has them, and what each was
// doing then as the journal says. It came back with 44 "Watch out" lines and
// not one was a collision — 28 named work that had finished, called "waiting
// on you"; 11 named work the agent already waited on through a queued chain;
// 5 named a task a half-made plan had left behind a minute earlier, which the
// plan's names being checked first now never makes.

const queued = (
  name: string,
  after: readonly string[],
  touches: readonly string[] = TOUCHES[name] ?? [],
): TaskSnapshot => ({
  task: `tade/${name}`,
  state: 'queued',
  queued: {
    state: { kind: 'waiting', on: after.map((task) => `tade/${task}`) },
    after: after.map((task) => ({ task: `tade/${task}`, why: '' })),
    prompt: '',
    touches,
    at: null,
  },
  waitsOn: after.map((task) => ({ task: `tade/${task}`, why: '' })),
  touches,
})

const running = (
  name: string,
  after: readonly string[],
  over: Partial<TaskSnapshot> = {},
  touches: readonly string[] = TOUCHES[name] ?? [],
): TaskSnapshot => ({
  task: `tade/${name}`,
  state: 'working',
  ...(after.length > 0
    ? { waitsOn: after.map((task) => ({ task: `tade/${task}`, why: '' })) }
    : {}),
  touches,
  ...over,
})

/** Said it was done, and sits at its prompt: what status calls `blocked`. */
const done = (name: string, after: readonly string[]) =>
  running(name, after, {
    state: 'blocked',
    reason: 'agent idle, waiting for input',
    finished: { by: 'agent', summary: '' },
  })

/** What each said it would touch, verbatim from its task file — junk entries included. */
const TOUCHES: Record<string, readonly string[]> = {
  'journal-index-no-rebuild': [
    'packages/workbench/src/events.ts',
    'packages/workbench/src/event-index.ts',
    'packages/workbench/src/compact.ts',
    'scripts/bench.ts',
  ],
  'open-paints-first': [
    'packages/app/src/live.ts',
    'packages/app/src/app.ts',
    'packages/cli/src/commands/app.ts',
    'packages/cli/src/program.ts',
    'packages/cli/src/telemetry.ts',
    'packages/app/src/highlight.ts',
    'packages/app/src/wire/web.ts',
  ],
  'away-settings-compact-defaults': [
    'packages/app/src/panels/settings',
    'packages/core/src/config.ts',
    'packages/core/src/settings.ts',
    'packages/core/src/reach.ts',
  ],
  'documents-outlive-tasks': [
    'packages/core/src/produces.ts',
    'packages/core/src/home.ts',
    'packages/core/src/compose.ts',
    'packages/workbench/src/tasks.ts',
    'packages/workbench/src/documents.ts',
    'packages/orchestrator/src',
    'packages/cli/src/commands/documents.ts',
    'packages/app/src/wire/agents.ts',
    '.claude/skills',
    'CLAUDE.md/AGENTS.md',
  ],
  'idle-draws-only-on-news': [
    'packages/app/src/wire/files.ts',
    'packages/app/src/live.ts',
    'packages/app/src/work-look.ts',
    'packages/app/src/app.ts',
    'packages/app/src/wire/extensions.ts',
    'packages/app/src/wire/routes.ts',
  ],
  'unknown-not-empty': [
    'packages/app/src/live.ts',
    'packages/app/src/view/sidebar.ts',
    'README pictures/goldens',
  ],
  'figures-hold-still': [
    'packages/app/src/view/foot.ts',
    'packages/app/src/view/top.ts',
    'packages/app/src/view/queue.ts',
    'packages/core/src/runtime.ts',
    'README pictures/goldens',
  ],
  'flash-acknowledgements': [
    'packages/app/src/model.ts',
    'packages/app/src/transcript.ts',
    'packages/app/src/view/foot.ts',
    'packages/app/src/wire/paint.ts',
  ],
  'scrollback-and-history-fold': [
    'packages/drivers/pty/src/index.ts',
    'packages/workbench/src/registry.ts',
    'packages/core/src/config.ts',
    'packages/app/src/live.ts',
  ],
  'spawns-run-detached': [
    'packages/core/src/run.ts',
    'packages/core/src/index.ts',
    'packages/app/src/images.ts',
    'packages/extensions/core/src/host.ts',
    'packages/drivers/tmux/src/index.ts',
    'packages/workbench/src/authored.ts',
    'packages/workbench/src/programs.ts',
    'packages/voice',
    'packages/harnesses/claude/src/adapter.ts',
    'packages/harnesses/codex/src/adapter.ts',
    'packages/status/src/git.ts',
    'packages/status/src/processes.ts',
    'packages/status/src/forges.ts',
    'test/modularity.test.ts',
    'README.md',
  ],
  'clipboard-watched': [
    'packages/app/src/images.ts',
    'packages/app/src/wire/images.ts',
    'packages/app/src/wire/context.ts',
  ],
  'github-token-cached': [
    'packages/status/src/forges.ts',
    'packages/forges/github/src/index.ts',
    'packages/extensions/review/src/forge.ts',
    'packages/extensions/intake/src/github.ts',
  ],
  'git-status-via-status-child': [
    'packages/status/src/git.ts',
    'packages/status/src/status.ts',
    'packages/status/src/forked.ts',
    'packages/app/src/live.ts',
    'packages/app/src/wire/files.ts',
  ],
  'front-agent-stays-still': [
    'packages/app/src/wire/lanes.ts',
    'packages/app/src/wire/keyboard.ts',
    'packages/app/src/wire/mouse.ts',
    'packages/app/src/wire/window.ts',
    'packages/app/src/layout.ts',
    'packages/app/src/model.ts',
    'packages/app/src/app.ts',
  ],
  'intake-settings-by-source': [
    'packages/app/src',
    'packages/core/src/reach.ts',
    'packages/core/src',
  ],
  'settings-orchestrator-model-dropdowns': ['packages/app', 'packages/core/src'],
  'thinking-dropdown-anchored': ['packages/app/src'],
}

// What each was doing at 02:34, as the journal says, and what it waited on.
const at0234: TaskSnapshot[] = [
  done('journal-index-no-rebuild', []),
  running('open-paints-first', ['journal-index-no-rebuild']),
  running('away-settings-compact-defaults', []),
  running('documents-outlive-tasks', []),
  queued('idle-draws-only-on-news', ['open-paints-first']),
  queued('unknown-not-empty', ['idle-draws-only-on-news']),
  queued('figures-hold-still', ['unknown-not-empty']),
  queued('flash-acknowledgements', ['figures-hold-still']),
  queued('scrollback-and-history-fold', ['flash-acknowledgements']),
  queued('spawns-run-detached', [
    'open-paints-first',
    'away-settings-compact-defaults',
    'documents-outlive-tasks',
  ]),
  queued('clipboard-watched', ['spawns-run-detached']),
  queued('github-token-cached', ['spawns-run-detached']),
  queued('git-status-via-status-child', ['scrollback-and-history-fold', 'spawns-run-detached']),
  done('front-agent-stays-still', ['intake-settings-by-source']),
  done('intake-settings-by-source', ['thinking-dropdown-anchored']),
  done('settings-orchestrator-model-dropdowns', ['merge-local-worktrees']),
  done('thinking-dropdown-anchored', ['settings-orchestrator-model-dropdowns']),
]

const agent = (
  name: string,
  after: readonly string[],
  touches: readonly string[],
): PlannedAgent => ({
  name,
  said: name,
  prompt: name,
  after: after.map((one) => ({ agent: one, why: '' })),
  touches: [...touches],
})

const plan = {
  project: 'tade',
  said: 'It’s on you to decide when to schedule them',
  effort: 'tui-snappier',
  agents: [
    agent(
      'foot-remote-status-chip',
      ['tade/flash-acknowledgements', 'tade/away-settings-compact-defaults'],
      [
        'packages/app/src/view/foot.ts',
        'packages/app/src/wire/web.ts',
        'packages/app/src/wire/mouse.ts',
      ],
    ),
    agent(
      'key-echo-unpaced',
      ['tade/scrollback-and-history-fold', 'tade/away-settings-compact-defaults'],
      [
        'packages/app/src/pace.ts',
        'packages/app/src/wire/paint.ts',
        'packages/app/src/app.ts',
        'packages/app/src/wire/lanes.ts',
        'packages/app/src/wire/keyboard.ts',
        'packages/app/scripts/bench.ts',
      ],
    ),
    agent(
      'spinner-even-cadence',
      ['key-echo-unpaced'],
      [
        'packages/app/src/app.ts',
        'packages/app/src/model.ts',
        'packages/app/test/wire/frame.probe.test.ts',
      ],
    ),
    agent(
      'clicks-answer-immediately',
      ['spinner-even-cadence', 'foot-remote-status-chip', 'tade/documents-outlive-tasks'],
      [
        'packages/app/src/model.ts',
        'packages/app/src/ui.ts',
        'packages/app/src/wire/actions.ts',
        'packages/app/src/wire/routes.ts',
        'packages/app/src/wire/agents.ts',
        'packages/app/src/wire/lanes.ts',
        'packages/app/src/wire/mouse.ts',
      ],
    ),
    agent(
      'lane-scroll-held-rows',
      ['clicks-answer-immediately'],
      [
        'packages/app/src/wire/lanes.ts',
        'packages/app/src/wire/mouse.ts',
        'packages/app/src/scroll.ts',
        'packages/drivers/pty/src/index.ts',
      ],
    ),
    agent(
      'hover-redraws-less',
      ['lane-scroll-held-rows'],
      [
        'packages/app/src/view/last-frame.ts',
        'packages/app/src/view.ts',
        'packages/app/src/wire/mouse.ts',
      ],
    ),
    agent(
      'updates-chip-and-reload',
      [
        'hover-redraws-less',
        'tade/clipboard-watched',
        'tade/github-token-cached',
        'tade/git-status-via-status-child',
        'tade/documents-outlive-tasks',
      ],
      [],
    ),
    agent(
      'away-panel-lean-live',
      ['updates-chip-and-reload'],
      ['packages/app/src/panels/away', 'packages/app/src/wire/web.ts', 'packages/app/src/app.ts'],
    ),
  ],
}

const context = (busy: readonly PlanBusy[]) => ({
  workspace: () => 'checkout' as const,
  tasks: new Set(at0234.map((task) => task.task)),
  busy,
  // The packages this plan's touches are in, as tade has them: none of its
  // agents names a whole one.
  packages: () => ['', 'packages/app', 'packages/drivers/pty'],
})

const warningsWith = (busy: readonly PlanBusy[]) => {
  const check = checkPlan(plan, context(busy))
  if (!check.ok) throw new Error(check.problems.join('; '))
  return check.warnings
}

/** How many pairs a line stands for: its own, and the ones it counts. */
const pairsIn = (line: string) =>
  1 +
  Number(
    /; (\d+) more of this plan's agents/.exec(line)?.[1] ??
      (/ runs into .* too$/.test(line) ? 1 : 0),
  )

describe('what a plan is warned about', () => {
  it('is nothing at all for the plan made at 02:34, which came back with 44 warnings', () => {
    expect(warningsWith(planBusyOf(at0234, ['tade']))).toEqual([])
  })

  it('was 39 of those 44 with finished work in and the walk stopping at the plan’s edge', () => {
    // What the window used to hand over: every working, queued or blocked task,
    // finished or not, and none of their waits.
    const before = at0234
      .filter((task) => ['working', 'queued', 'blocked'].includes(task.state))
      .map((task) => ({
        task: task.task,
        said: task.queued ? 'queued' : task.state === 'working' ? 'working' : 'waiting on you',
        touches: task.queued ? task.queued.touches : (task.touches ?? []),
      }))
    const lines = warningsWith(before)
    expect(lines.reduce((sum, line) => sum + pairsIn(line), 0)).toBe(39)
    // One line for each task run into, not one for each pair.
    expect(lines).toHaveLength(8)
    expect(lines.join('\n')).toContain(
      'foot-remote-status-chip and tade/intake-settings-by-source, which is waiting on you, both change packages/app/src (tade/intake-settings-by-source said it touches all of it), in one checkout; 6 more of this plan',
    )
  })

  it('says the one real collision left once, however many agents run into it', () => {
    // The task a half-made plan left behind, waiting on what foot-remote-status-chip
    // waits on and changing the same three files: that one is real.
    const orphan = queued(
      'bottom-bar-jev-and-remote',
      ['flash-acknowledgements', 'away-settings-compact-defaults'],
      [
        'packages/app/src/view/foot.ts',
        'packages/app/src/wire/web.ts',
        'packages/app/src/wire/mouse.ts',
      ],
    )
    expect(warningsWith(planBusyOf([...at0234, orphan], ['tade']))).toEqual([
      "foot-remote-status-chip and tade/bottom-bar-jev-and-remote, which is queued, both change packages/app/src/view/foot.ts, packages/app/src/wire/web.ts and packages/app/src/wire/mouse.ts, in one checkout; 4 more of this plan's agents run into tade/bottom-bar-jev-and-remote too: clicks-answer-immediately, lane-scroll-held-rows, hover-redraws-less and away-panel-lean-live",
    ])
  })
})

describe('the work a plan is checked against', () => {
  const blocked = (over: Partial<TaskSnapshot>): TaskSnapshot => ({
    task: 'tade/asked',
    state: 'blocked',
    touches: ['src/a.ts'],
    ...over,
  })

  it('leaves out what has finished, unless its agent is running again', () => {
    const finished = { by: 'agent', summary: 'did it' }
    expect(planBusyOf([blocked({ finished })], ['tade'])).toEqual([])
    expect(planBusyOf([blocked({ finished, state: 'working' })], ['tade'])).toEqual([
      { task: 'tade/asked', said: 'working', touches: ['src/a.ts'], after: [] },
    ])
  })

  it('says waiting on you only for what is: an approval, or a stop that was not a finish', () => {
    expect(planBusyOf([blocked({ waiting: true })], ['tade'])[0]?.said).toBe(
      'waiting on your approval',
    )
    expect(planBusyOf([blocked({})], ['tade'])[0]?.said).toBe('waiting on you')
    // Stopped, parked, merged: not in anybody's way.
    expect(
      planBusyOf([blocked({ state: 'review' }), blocked({ state: 'parked' })], ['tade']),
    ).toEqual([])
  })

  it('keeps what touches nothing, for its waits, and only the projects the plan reaches', () => {
    const chain = queued('link', ['first'], [])
    expect(planBusyOf([chain, { ...chain, task: 'elsewhere/link' }], ['tade'])).toEqual([
      { task: 'tade/link', said: 'queued', touches: [], after: ['tade/first'] },
    ])
  })
})
