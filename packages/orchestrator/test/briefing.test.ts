import type { EventType, TadeEvent } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { composeBriefing } from '../src/briefing.ts'

// What a reopened orchestrator is told about the world it was talking about.
//
// The conversation itself comes back with the session; these are the facts
// that would otherwise be a day out of date, folded out of the journal.

const NOW = Date.parse('2026-09-15T13:00:00Z')

let seq = 0
function event(
  type: EventType,
  task: string | null,
  detail: Record<string, unknown> = {},
  minutesAgo = 60,
): TadeEvent {
  seq += 1
  return {
    seq,
    ts: new Date(NOW - minutesAgo * 60_000).toISOString(),
    type,
    urgency: 'notable',
    task,
    lane: null,
    run: null,
    detail,
  }
}

describe('what the orchestrator opens knowing', () => {
  it('says nothing at all when nothing has ever happened', () => {
    // A first window has no past. A section saying so is one nobody reads.
    expect(composeBriefing({ now: NOW, events: [] })).toBeNull()
  })

  it('says when Tade was last open, and that this is a snapshot', () => {
    const said = composeBriefing({
      now: NOW,
      events: [event('tade_closing', null, { pid: 1 }, 180)],
    })
    expect(said).toContain('Tade was last open until 3h ago')
    // The one rule that must survive: what is true now is status's to answer.
    expect(said).toContain('tade_status')
  })

  it('names the agents that were still running, which the window reopens', () => {
    const said = composeBriefing({
      now: NOW,
      events: [
        event('task_created', 'app/refunds', { intent_spoken: 'refunds double-charge' }, 200),
        event('run_started', 'app/refunds', {}, 190),
        event('task_created', 'app/search', {}, 180),
        event('run_started', 'app/search', {}, 170),
        event('run_exited', 'app/search', { code: 0 }, 20),
      ],
    })
    expect(said).toContain('app/refunds, started 3h ago')
    expect(said).not.toContain('app/search, started')
  })

  it('says which work finished and how that was decided', () => {
    const said = composeBriefing({
      now: NOW,
      events: [
        event('task_created', 'app/refunds', {}, 300),
        event('run_started', 'app/refunds', {}, 290),
        event('task_done', 'app/refunds', { by: 'agent', summary: 'fixed the rounding' }, 30),
      ],
    })
    expect(said).toContain('app/refunds: finished 30m ago — its agent said so')
    // And not also listed as an agent still working: it said it had stopped.
    expect(said).not.toContain('app/refunds, started')
  })

  it('leaves out work that is not there any more', () => {
    const said = composeBriefing({
      now: NOW,
      events: [
        event('task_created', 'app/spike', {}, 300),
        event('run_started', 'app/spike', {}, 290),
        event('task_removed', 'app/spike', {}, 10),
      ],
    })
    expect(said).not.toContain('app/spike')
  })

  it('puts a hold back in front of the person, and only while it is unanswered', () => {
    const held = composeBriefing({
      now: NOW,
      events: [
        event('task_created', 'app/migrate', {}, 300),
        event('queue_held', 'app/migrate', { because: 'app/schema failed: the tests broke' }, 40),
      ],
    })
    expect(held).toContain('app/migrate: app/schema failed: the tests broke')

    const answered = composeBriefing({
      now: NOW,
      events: [
        event('task_created', 'app/migrate', {}, 300),
        event('queue_held', 'app/migrate', { because: 'app/schema failed' }, 40),
        event('queue_changed', 'app/migrate', { change: 'start', by: 'you' }, 20),
      ],
    })
    expect(answered).not.toContain('Held, and waiting')
  })

  it("passes the queue's own words through, so the two can never disagree", () => {
    const said = composeBriefing({
      now: NOW,
      events: [event('tade_closing', null, {}, 120)],
      queue: '- app/migrate — after app/schema\n\nSchedules:\n- nightly (Nightly) — every 1d',
    })
    expect(said).toContain('- app/migrate — after app/schema')
    expect(said).toContain('- nightly (Nightly) — every 1d')
  })

  it('brings back the last things they said, word for word', () => {
    const said = composeBriefing({
      now: NOW,
      events: [
        event('said', null, { text: 'start the refunds one' }, 200),
        event('said', null, { text: 'Actually, park it' }, 100),
      ],
      said: 1,
    })
    // Verbatim, capital letter and all: paraphrasing what somebody said is
    // the one thing Tade never does.
    expect(said).toContain('"Actually, park it"')
    expect(said).not.toContain('start the refunds one')
    // And it is not an instruction to answer them again.
    expect(said).toContain('not to answer again')
  })

  it('survives a journal line whose timestamp is nonsense', () => {
    const broken: TadeEvent = { ...event('said', null, { text: 'hello' }), ts: 'not a time' }
    expect(() => composeBriefing({ now: NOW, events: [broken] })).not.toThrow()
  })
})

describe('what it opens knowing with several repositories', () => {
  it('says how big the world is, before anything about what is in it', () => {
    const said = composeBriefing({
      now: NOW,
      events: [event('tade_closing', null, { pid: 1 }, 180)],
      projects: ['getsentry', 'sentry', 'sentry-cli'],
    })
    expect(said).toContain('3 projects are open: getsentry, sentry, sentry-cli.')
  })

  it('says nothing about the size of a world with one project in it', () => {
    const said = composeBriefing({
      now: NOW,
      events: [event('tade_closing', null, { pid: 1 }, 180)],
      projects: ['app'],
    })
    expect(said).not.toContain('projects are open')
  })

  it('caps per project and counts what it left out, rather than losing a repo in silence', () => {
    // A flat cap across projects is one repository's worth of lines and four
    // repositories' silence, which reads as "nothing is happening there".
    const events: TadeEvent[] = [event('tade_closing', null, { pid: 1 }, 600)]
    for (const project of ['sentry', 'relay']) {
      for (let n = 0; n < 5; n++) {
        events.push(event('state_change', `${project}/task-${n}`, { state: 'working' }, 60 - n))
      }
    }
    const said = composeBriefing({ now: NOW, events, projects: ['sentry', 'relay'] }) ?? ''
    for (const project of ['sentry', 'relay']) {
      expect(said.split('\n').filter((line) => line.startsWith(`- ${project}/`))).toHaveLength(3)
      expect(said).toContain(`- ${project}: 2 more not listed`)
    }
  })

  it('says an effort once, instead of the task lines it is made of', () => {
    const events = [
      event('tade_closing', null, { pid: 1 }, 600),
      event('state_change', 'sentry/oauth-scopes', { state: 'working' }, 30),
      event('state_change', 'sentry-cli/oauth-scopes', { state: 'working' }, 29),
    ]
    const said =
      composeBriefing({
        now: NOW,
        events,
        projects: ['sentry', 'sentry-cli'],
        efforts: [
          {
            name: 'oauth-scopes',
            projects: ['sentry', 'sentry-cli'],
            tasks: [
              {
                task: 'sentry/oauth-scopes',
                project: 'sentry',
                state: 'merged' as const,
                finished: true,
              },
              {
                task: 'sentry-cli/oauth-scopes',
                project: 'sentry-cli',
                state: 'working' as const,
                finished: false,
              },
            ],
            finished: 1,
            unfinished: [
              {
                task: 'sentry-cli/oauth-scopes',
                project: 'sentry-cli',
                state: 'working' as const,
                finished: false,
              },
            ],
          },
        ],
      }) ?? ''
    expect(said).toContain(
      '- oauth-scopes (sentry, sentry-cli): 1 of 2 finished — sentry-cli/oauth-scopes working',
    )
    // And its tasks are not then listed again underneath: a briefing that says
    // the same thing twice is one that gets skimmed.
    expect(said).not.toContain('- sentry/oauth-scopes:')
    expect(said).not.toContain('- sentry-cli/oauth-scopes:')
  })
})
