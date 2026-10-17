import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema, type EventFilter, type TadeEvent } from '@tade/core'
import { ExtensionHost } from '@tade/extensions-core'
import { MachineAnswerSchema } from '@tade/web'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import type { ScheduleView } from '../../src/model.ts'
import type { Wiring } from '../../src/wire/context.ts'
import {
  documentFrom,
  documentsHere,
  machineFrom,
  scheduleHere,
  toolFrom,
} from '../../src/wire/web-machine.ts'

// This machine's half of what another machine of the person's reads about it
// (`web-machine.ts`): out of what the window holds and four reads with
// deadlines — the config's warnings, the journal's, its documents, and the
// Updates check's kept answer — and never a path, a document nobody's journal
// names, or a tool that does anything but read.

const AT = Date.parse('2026-10-17T12:00:00.000Z')

/** A journal line, as the log hands one back. */
function line(type: string, detail: Record<string, unknown>, task: string | null = null) {
  return {
    seq: 1,
    ts: new Date(AT).toISOString(),
    type,
    urgency: 'routine',
    task,
    lane: null,
    run: null,
    detail,
  } as TadeEvent
}

/** The window as these halves reach it: its home, its config, its journal and its extensions. */
function wired(over: {
  home: string
  events?: TadeEvent[]
  extensions?: ExtensionHost
  config?: string
}) {
  writeFileSync(join(over.home, 'config.yaml'), over.config ?? '')
  const appended: unknown[] = []
  const wire = {
    now: () => AT,
    live: null,
    opts: {
      home: over.home,
      config: ConfigSchema.parse({}),
      extensions: over.extensions,
      client: {
        schedules: () => [],
        log: {
          read: async (filter: EventFilter) =>
            (over.events ?? []).filter(
              (one) => filter.types === undefined || filter.types.includes(one.type as never),
            ),
          append: async (input: unknown) => {
            appended.push(input)
          },
        },
      },
    },
  } as unknown as Wiring
  return { wire, appended }
}

const QUIET = { public: () => null, problem: () => null }

describe('what this machine is, as its window answers it', () => {
  it('says its version and its own problems — the config’s, an extension’s, the away view’s, the journal’s — with no path', async () => {
    const home = tmp('tade-machine-')
    const extensions = await ExtensionHost.load({
      builtin: [
        {
          name: 'weather',
          title: 'Weather',
          description: 'Whether it is raining.',
          ready: () => 'weather needs a key',
        },
      ],
      config: { extensions: {}, projects: {} },
      home,
      env: {},
    })
    const { wire } = wired({
      home,
      extensions,
      config: 'checks:\n  from_ci: run\n',
      events: [line('warning', { message: `git could not read ${home}/projects/app: locked` })],
    })
    const answer = await machineFrom(wire, {
      public: () => ({ name: 'tade.example.com', up: false, health: [] }),
      problem: () => 'nothing could listen on port 7654',
    })()
    expect(MachineAnswerSchema.safeParse(answer).success).toBe(true)
    expect(answer.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(answer.public).toEqual({ name: 'tade.example.com', up: false, health: [] })
    expect(answer.problems.map((one) => one.from)).toEqual([
      'config',
      'extension',
      'away',
      'journal',
    ])
    expect(answer.problems[0]?.said).toContain('checks.from_ci is ignored')
    expect(answer.problems[1]?.said).toBe('Weather needs setting up: weather needs a key')
    expect(answer.problems[3]?.at).toBe(new Date(AT).toISOString())
    expect(answer.problems[3]?.said).not.toContain(home)
  })

  it('names each document by its file, newest first, and never says where it is kept', () => {
    const older = {
      task: 'app/plan',
      path: '/home/me/.tade/projects/app/documents/app/plan/PLAN.md',
      at: '2026-10-16T00:00:00.000Z',
      bytes: 10,
      state: 'written' as const,
      triaged: null,
    }
    const newer = {
      ...older,
      task: 'app/notes',
      path: '/x/NOTES.md',
      at: '2026-10-17T00:00:00.000Z',
    }
    const here = documentsHere([older, newer] as never)
    expect(here.map((one) => [one.task, one.name, one.project])).toEqual([
      ['app/notes', 'NOTES.md', 'app'],
      ['app/plan', 'PLAN.md', 'app'],
    ])
    expect(JSON.stringify(here)).not.toContain('/home/me')
  })

  it('tells a watch’s looks and what they found, its next run as a moment, and the machine it was left to', () => {
    const view = {
      id: 'new-sentry-errors',
      name: 'New Sentry errors',
      project: 'app',
      kind: 'watch',
      when: 'every hour',
      paused: false,
      next: [AT + 3_600_000],
      watch: {
        id: 'sentry.new-errors',
        looks: [
          {
            at: AT,
            found: 0,
            fresh: 0,
            left: 0,
            problem: null,
            trouble: null,
            until: null,
            said: 'x',
            on: 'vps',
          },
        ],
        findings: [
          { at: AT, key: 'APP-1', title: 'TypeError', task: 'app/fix', told: null, problem: null },
        ],
      },
    } as unknown as ScheduleView
    expect(scheduleHere(view)).toEqual({
      id: 'new-sentry-errors',
      name: 'New Sentry errors',
      project: 'app',
      kind: 'watch',
      when: 'every hour',
      paused: false,
      next: new Date(AT + 3_600_000).toISOString(),
      watch: {
        id: 'sentry.new-errors',
        looks: [
          {
            at: new Date(AT).toISOString(),
            found: 0,
            fresh: 0,
            left: 0,
            problem: null,
            said: 'x',
            on: 'vps',
          },
        ],
        found: [
          { at: new Date(AT).toISOString(), key: 'APP-1', title: 'TypeError', task: 'app/fix' },
        ],
      },
    })
    expect(scheduleHere({ ...view, next: [], watch: undefined } as ScheduleView)).toMatchObject({
      next: null,
      watch: null,
    })
  })

  it('reads a document only where its journal says the task wrote one by that name', async () => {
    const home = tmp('tade-machine-')
    const dir = join(home, 'projects', 'app', 'documents', 'app', 'plan')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'PLAN.md'), '# The plan\n')
    writeFileSync(join(dir, 'SECRET.md'), 'not a document anybody produced')
    const { wire } = wired({
      home,
      events: [line('document_ready', { produces: join(dir, 'PLAN.md') }, 'app/plan')],
    })
    const read = documentFrom(wire)
    expect(await read({ task: 'app/plan', name: 'PLAN.md' })).toEqual({
      at: new Date(AT).toISOString(),
      text: '# The plan\n',
      bytes: 11,
    })
    expect(await read({ task: 'app/plan', name: 'SECRET.md' })).toBeNull()
    expect(await read({ task: 'app/other', name: 'PLAN.md' })).toBeNull()
  })

  it('runs only a tool that says it reads, writes the call down with who asked, and hands back a throw as its words', async () => {
    const home = tmp('tade-machine-')
    const ran: string[] = []
    const extensions = await ExtensionHost.load({
      builtin: [
        {
          name: 'weather',
          title: 'Weather',
          description: 'Whether it is raining.',
          tools: [
            {
              name: 'weather_now',
              description: 'Whether it is raining now, where you are.',
              parameters: { type: 'object', properties: {} },
              for: ['orchestrator'],
              reads: true,
              run: async () => {
                ran.push('now')
                return { text: 'raining' }
              },
            },
            {
              name: 'weather_broken',
              description: 'A look that cannot be had, to see what it says.',
              parameters: { type: 'object', properties: {} },
              for: ['orchestrator'],
              reads: true,
              run: async () => {
                throw new Error('no forecast key')
              },
            },
            {
              name: 'weather_change',
              description: 'Make it stop raining, which changes something.',
              parameters: { type: 'object', properties: {} },
              for: ['orchestrator'],
              run: async () => {
                ran.push('change')
                return { text: 'sunny' }
              },
            },
          ],
        },
      ],
      config: { extensions: {}, projects: {} },
      home,
      env: {},
    })
    const { wire, appended } = wired({ home, extensions })
    const tool = toolFrom(wire)
    expect(await tool({ tool: 'weather_now', input: {} }, 'abc123')).toEqual({
      text: 'raining',
      failed: false,
    })
    expect(appended).toEqual([
      { type: 'tool_call', detail: { tool: 'weather_now', caller: 'device abc123' } },
    ])
    expect(await tool({ tool: 'weather_broken', input: {} }, 'abc123')).toMatchObject({
      failed: true,
    })
    expect(await tool({ tool: 'weather_change', input: {} }, 'abc123')).toBeNull()
    expect(await tool({ tool: 'nothing_here', input: {} }, 'abc123')).toBeNull()
    expect(ran).toEqual(['now'])
  })

  it('answers a quiet machine with nothing to say rather than with a throw', async () => {
    const { wire } = wired({ home: tmp('tade-machine-') })
    const answer = await machineFrom(wire, QUIET)()
    expect(answer).toMatchObject({ public: null, problems: [], schedules: [], documents: [] })
  })
})
