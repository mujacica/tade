import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigSchema, composePrompt } from '@tade/core'
import { describe, expect, it } from 'vitest'
import tadeTools from '../src/tools-extension.ts'

// What the orchestrator sees before it decides anything: the tools it has and
// the prompt it was given.
//
// Both are recorded here and compared on every run, because a change to either
// changes what the model does, and that is the kind of change that otherwise
// shows up three days later as "it has been weird lately". A diff in review is
// the whole point — run with TADE_UPDATE_GOLDEN=1 to accept one deliberately.

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), 'golden')

function compare(name: string, actual: string): void {
  const path = join(GOLDEN, name)
  if (process.env.TADE_UPDATE_GOLDEN === '1') {
    mkdirSync(GOLDEN, { recursive: true })
    writeFileSync(path, actual)
    return
  }
  let expected: string
  try {
    expected = readFileSync(path, 'utf8')
  } catch {
    throw new Error(`no golden file at ${path} — run with TADE_UPDATE_GOLDEN=1 to record it`)
  }
  expect(actual).toBe(expected)
}

/** The tool surface, as the model is handed it. */
function toolSurface() {
  const tools: Array<{ name: string; description: string; parameters: unknown }> = []
  const saved = process.env.TADE_EXTENSION_TOOLS
  delete process.env.TADE_EXTENSION_TOOLS
  try {
    tadeTools({
      registerTool: (tool: { name: string; description: string; parameters: unknown }) => {
        tools.push({ name: tool.name, description: tool.description, parameters: tool.parameters })
      },
    } as never)
  } finally {
    if (saved !== undefined) process.env.TADE_EXTENSION_TOOLS = saved
  }
  return tools.sort((a, b) => a.name.localeCompare(b.name))
}

describe('the tools the orchestrator has', () => {
  it('is exactly this set', () => {
    // Adding or removing a verb changes what Tade can be asked to do.
    expect(toolSurface().map((t) => t.name)).toEqual([
      'tade_agent_harness',
      'tade_agent_model',
      'tade_agent_rename',
      'tade_agent_thinking',
      'tade_approvals',
      'tade_approve',
      'tade_chat_list',
      'tade_chat_open',
      'tade_deny',
      'tade_done',
      'tade_limits',
      'tade_logs',
      'tade_notes',
      'tade_orchestrator_model',
      'tade_park',
      'tade_plan',
      'tade_project_close',
      'tade_project_configure',
      'tade_project_open',
      'tade_project_rename',
      'tade_project_reorder',
      'tade_propose_skill',
      'tade_queue',
      'tade_queue_change',
      'tade_remember',
      'tade_resume',
      'tade_run_cleanup',
      'tade_run_list',
      'tade_run_start',
      'tade_run_stop',
      'tade_schedule',
      'tade_setting_change',
      'tade_settings',
      'tade_status',
      'tade_steer',
      'tade_task_create',
      'tade_terminal_close',
      'tade_terminal_list',
      'tade_terminal_open',
      'tade_terminal_read',
      'tade_terminal_rename',
      'tade_terminal_run',
      'tade_terminal_search',
      'tade_updates',
      'tade_watch_change',
      'tade_watches',
      'tade_write_extension',
    ])
  })

  it('has not changed without somebody saying so', () => {
    compare('tools.json', `${JSON.stringify(toolSurface(), null, 2)}\n`)
  })

  it('tells the model what each one is for, not just what it is called', () => {
    for (const tool of toolSurface()) {
      // A one-word description is how a model ends up calling the wrong tool.
      expect(tool.description.length, tool.name).toBeGreaterThan(40)
    }
  })

  it('says in its own description when it is gated on the person’s own words', () => {
    // The gate itself is in the window, and what a model reads while it is
    // choosing is the description: `tade_project_close` said it only in the
    // parameter, which is a refusal and a wasted turn away from where the
    // model needed it.
    for (const tool of toolSurface()) {
      const properties = (
        tool.parameters as { properties: Record<string, { description?: string }> }
      ).properties
      const said = properties.said?.description ?? ''
      if (!said.includes('Tade checks it against what they actually said')) continue
      expect(tool.description, tool.name).toContain('in their own words')
    }
  })

  it('refuses to accept arguments it does not know', () => {
    for (const tool of toolSurface()) {
      expect((tool.parameters as { additionalProperties: boolean }).additionalProperties).toBe(
        false,
      )
    }
  })
})

describe('the prompt the orchestrator is given', () => {
  const config = ConfigSchema.parse({
    projects: {
      checkout: { root: '/src/checkout', brief: 'Payments. Stripe, Postgres, Node.' },
      search: { root: '/src/search' },
    },
  })

  it('has not changed without somebody saying so', () => {
    const prompt = composePrompt({
      config,
      notes: [
        { text: 'we pin major versions', scope: null, by: 'voice', at: '2026-09-10T10:00:00.000Z' },
        {
          text: 'the staging key rotates on the 1st',
          scope: 'checkout',
          by: 'cli',
          at: '2026-09-11T10:00:00.000Z',
        },
      ],
    })
    compare('prompt.txt', `${prompt}\n`)
  })
})
