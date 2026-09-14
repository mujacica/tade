import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigSchema, composePrompt } from '@wilco/core'
import { describe, expect, it } from 'vitest'
import wilcoTools from '../src/tools-extension.ts'

// What the orchestrator sees before it decides anything: the tools it has and
// the prompt it was given.
//
// Both are recorded here and compared on every run, because a change to either
// changes what the model does, and that is the kind of change that otherwise
// shows up three days later as "it has been weird lately". A diff in review is
// the whole point — run with WILCO_UPDATE_GOLDEN=1 to accept one deliberately.

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), 'golden')

function compare(name: string, actual: string): void {
  const path = join(GOLDEN, name)
  if (process.env.WILCO_UPDATE_GOLDEN === '1') {
    mkdirSync(GOLDEN, { recursive: true })
    writeFileSync(path, actual)
    return
  }
  let expected: string
  try {
    expected = readFileSync(path, 'utf8')
  } catch {
    throw new Error(`no golden file at ${path} — run with WILCO_UPDATE_GOLDEN=1 to record it`)
  }
  expect(actual).toBe(expected)
}

/** The tool surface, as the model is handed it. */
function toolSurface() {
  const tools: Array<{ name: string; description: string; parameters: unknown }> = []
  const saved = process.env.WILCO_EXTENSION_TOOLS
  delete process.env.WILCO_EXTENSION_TOOLS
  try {
    wilcoTools({
      registerTool: (tool: { name: string; description: string; parameters: unknown }) => {
        tools.push({ name: tool.name, description: tool.description, parameters: tool.parameters })
      },
    } as never)
  } finally {
    if (saved !== undefined) process.env.WILCO_EXTENSION_TOOLS = saved
  }
  return tools.sort((a, b) => a.name.localeCompare(b.name))
}

describe('the tools the orchestrator has', () => {
  it('is exactly this set', () => {
    // Adding or removing a verb changes what Wilco can be asked to do.
    expect(toolSurface().map((t) => t.name)).toEqual([
      'wilco_agent_harness',
      'wilco_agent_model',
      'wilco_agent_rename',
      'wilco_agent_thinking',
      'wilco_approvals',
      'wilco_approve',
      'wilco_deny',
      'wilco_done',
      'wilco_logs',
      'wilco_orchestrator_model',
      'wilco_park',
      'wilco_plan',
      'wilco_propose_extension',
      'wilco_propose_skill',
      'wilco_queue',
      'wilco_queue_change',
      'wilco_remember',
      'wilco_resume',
      'wilco_run_cleanup',
      'wilco_run_list',
      'wilco_run_start',
      'wilco_run_stop',
      'wilco_schedule',
      'wilco_status',
      'wilco_steer',
      'wilco_task_create',
      'wilco_terminal_close',
      'wilco_terminal_list',
      'wilco_terminal_open',
      'wilco_terminal_read',
      'wilco_terminal_rename',
      'wilco_terminal_run',
      'wilco_terminal_search',
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
