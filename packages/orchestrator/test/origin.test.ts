import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type Arm, LOCAL } from '@tade/core'
import { describe, expect, it } from 'vitest'
import {
  allowMethod,
  allowTool,
  canBeArmed,
  REMOTE_METHODS,
  REMOTE_TOOLS,
  waiting,
  writtenBy,
} from '../src/origin.ts'
import { orchestratorTools } from '../src/tools-extension.ts'

// What a turn's words may reach, over the whole of both tables.
//
// **Both tables are asserted against the real lists**, which is the half of
// this that keeps working after everybody who wrote it has forgotten: a tool
// or a method added without a line is a failure here, and at runtime an
// unnamed one is refused. So the two directions a mistake can go are both
// caught — a capability that silently stopped working, and one that silently
// arrived.

/** A device granted nothing beyond talking. */
function arm(over: Partial<Extract<Arm, { how: 'remote' }>> = {}): Arm {
  return { how: 'remote', device: 'a1b2c3d4e5f60718', projects: null, may: [], ...over }
}

/** The `ToolHost`'s own method names, read out of the file that declares them. */
function methodNames(): string[] {
  const path = fileURLToPath(new URL('../src/tool-host.ts', import.meta.url))
  const source = readFileSync(path, 'utf8')
  // The keys of the one `methods` record, which are quoted `thing/verb` pairs
  // at a known depth. Read rather than exported, because the record is built
  // inside `listen` out of closures over its options — and a second exported
  // list of the same names is the thing this test exists to prevent.
  return [...source.matchAll(/^ {6}'([a-z]+\/[a-z-]+)':/gm)].map((found) => found[1] ?? '')
}

describe('what a remote turn may reach', () => {
  it('names every one of Tade’s own tools, and no tool that does not exist', () => {
    // **Tade's own, which is not the same as every tool the orchestrator has.**
    // `orchestratorTools` also registers whatever an *extension* shipped, by
    // the name that extension chose — so the list is read with none of those
    // in the environment, and the ones that would have been there are refused
    // by name at runtime (below) rather than being in a table Tade cannot
    // write ahead of time.
    const listed = process.env.TADE_EXTENSION_TOOLS
    delete process.env.TADE_EXTENSION_TOOLS
    try {
      const tools = orchestratorTools().map((tool) => tool.name)
      expect(Object.keys(REMOTE_TOOLS).sort()).toEqual([...tools].sort())
    } finally {
      if (listed !== undefined) process.env.TADE_EXTENSION_TOOLS = listed
    }
  })

  it('refuses an extension’s tool, whose name Tade did not choose', () => {
    // An extension is code somebody turned on, with tools named by whoever
    // wrote it: a credential, a forge, a deploy. None of them is in the table
    // and none of them can be, so the default has to be no.
    for (const tool of ['sentry_issue', 'review_open', 'deps_update', 'checks_run']) {
      expect(allowTool(tool, arm({ may: ['answer', 'steer'] })).ok).toBe(false)
    }
  })

  it('names every one of the host’s methods, and no method that does not exist', () => {
    const methods = methodNames()
    expect(methods.length).toBeGreaterThan(20)
    expect(Object.keys(REMOTE_METHODS).sort()).toEqual([...methods].sort())
  })

  it('refuses a tool it has never heard of, which is every tool of the harness’s own', () => {
    // The names that reach the gate are whatever the harness registered: pi's
    // own `bash`, `write` and `edit` never touch Tade's code at all. Allowing
    // by default would make every one of them reachable from a phone.
    for (const tool of ['bash', 'write', 'edit', 'read', 'powershell', 'tade_future_tool']) {
      const said = allowTool(tool, arm())
      expect(said.ok).toBe(false)
      if (!said.ok) expect(said.said).toContain('needs the person at the machine')
    }
  })

  it('asks nothing of a local turn, which is what keeps the window unchanged', () => {
    for (const tool of ['bash', 'tade_setting_change', 'tade_run_start', 'anything']) {
      expect(allowTool(tool, LOCAL)).toEqual({ ok: true })
    }
    expect(allowMethod('config/change', { path: 'checks.before' }, LOCAL)).toEqual({ ok: true })
  })

  it('refuses a setting change however the request is worded', () => {
    // The whole point of the tables: `namedBy` reads the last forty lines the
    // *person* said, so a remote turn asking for a setting they happened to
    // name last week would be authorised by their line — and `open`-tier
    // settings need no words at all. Neither matters here, because there is no
    // path from a remote arm to the door.
    for (const may of [[], ['answer'], ['steer'], ['answer', 'steer']] as const) {
      const said = allowMethod('config/change', { path: 'checks.before' }, arm({ may }))
      expect(said.ok).toBe(false)
    }
    expect(allowTool('tade_setting_change', arm({ may: ['answer', 'steer'] })).ok).toBe(false)
    expect(allowTool('tade_settings', arm({ may: ['answer', 'steer'] })).ok).toBe(false)
  })

  it('refuses everything that executes, grants, publishes or reads wider', () => {
    const everything = arm({ may: ['answer', 'steer'] })
    for (const tool of [
      'tade_run_start',
      'tade_terminal_run',
      'tade_write_extension',
      'tade_task_create',
      'tade_template_use',
      'tade_project_open',
      'tade_watch_change',
      'tade_orchestrator_model',
      'tade_done',
      'tade_run_stop',
      'tade_logs',
      'tade_notes',
      'tade_terminal_read',
    ]) {
      expect(allowTool(tool, everything).ok).toBe(false)
    }
    for (const method of [
      'worker/start',
      'terminal/run',
      'lane/write',
      'extension/call',
      'config/settings',
      'intake/list',
      'task/create',
      'task/done',
      'events/read',
      'queue/schedule',
    ]) {
      expect(allowMethod(method, {}, everything).ok).toBe(false)
    }
  })

  it('lets a granted tier through, and only the tier it was granted', () => {
    expect(allowTool('tade_status', arm()).ok).toBe(true)
    expect(allowTool('tade_approve', arm({ may: ['answer'] })).ok).toBe(true)
    expect(allowTool('tade_approve', arm({ may: ['steer'] })).ok).toBe(false)
    expect(allowTool('tade_steer', arm({ may: ['steer'] })).ok).toBe(true)
    expect(allowTool('tade_steer', arm({ may: ['answer'] })).ok).toBe(false)
    const refused = allowTool('tade_park', arm({ may: ['answer'] }))
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.said).toContain('granted steer at the machine')
  })

  it('refuses a project this device was not granted, whatever it was granted to do', () => {
    const narrow = arm({ may: ['steer'], projects: ['sentry'] })
    expect(allowMethod('worker/steer', { task: 'sentry/flake' }, narrow).ok).toBe(true)
    const out = allowMethod('worker/steer', { task: 'payments/refunds' }, narrow)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.said).toContain('was not granted payments')
    // A note about everything is a note a device may write: it is the same
    // note its own `note` verb writes, with the same `by`.
    expect(allowMethod('memory/remember', { scope: null }, narrow).ok).toBe(true)
    expect(allowMethod('memory/remember', { scope: 'sentry/flake' }, narrow).ok).toBe(true)
    expect(allowMethod('memory/remember', { scope: 'payments' }, narrow).ok).toBe(false)
  })

  it('refuses a task that names no project at all', () => {
    // A `task` with no `/` in it names no project, and `armSees` answers no to
    // the empty string: a bare name must never be read as *every project*.
    const said = allowMethod('task/park', { task: 'orphan' }, arm({ may: ['steer'] }))
    expect(said.ok).toBe(false)
  })

  it('writes a remote note down as the device, never as the orchestrator', () => {
    expect(writtenBy(arm(), 'orchestrator')).toBe('device a1b2c3d4e5f60718')
    expect(writtenBy(LOCAL, 'orchestrator')).toBe('orchestrator')
    expect(writtenBy(LOCAL, '')).toBe('tade')
  })

  it('shows a waiting approval’s name and never the command it is holding', () => {
    const held = [
      {
        run: 'sentry/flake/agent',
        task: 'sentry/flake',
        requestId: 'perm_1',
        tool: 'bash',
        summary: 'bash: rm -rf /Users/testperson/work/sentry/node_modules',
        tier: 'hard',
        rule: 'force',
        reason: 'deletes a folder',
        at: 1,
      },
      {
        run: 'payments/refunds/agent',
        task: 'payments/refunds',
        requestId: 'perm_2',
        tool: 'write',
        summary: 'write /Users/testperson/work/payments/src/x.ts',
        tier: 'soft',
        rule: 'file',
        reason: 'writes a file',
        at: 2,
      },
    ]
    const shown = waiting(held, arm({ may: ['answer'], projects: ['sentry'] }))
    expect(shown).toEqual([
      { run: 'sentry/flake/agent', task: 'sentry/flake', request: 'perm_1', tool: 'bash', at: 1 },
    ])
    const words = JSON.stringify(shown)
    expect(words).not.toContain('rm -rf')
    expect(words).not.toContain('/Users/')
    expect(words).not.toContain('summary')
    // A local turn sees the same fields and every project: the narrowing is
    // about the arm, not about hiding things from the person at the keyboard.
    expect(waiting(held, LOCAL)).toHaveLength(2)
  })
})

describe('a harness that cannot be narrowed', () => {
  const why = { permissionGate: 'cannot hold a call', nativeExtensions: 'has no place for those' }

  it('is refused, and the refusal is the harness’s own words', () => {
    const noGate = canBeArmed({ permissionGate: false, nativeExtensions: true, why })
    expect(noGate.ok).toBe(false)
    if (!noGate.ok) expect(noGate.why).toBe('cannot hold a call')
    const noOwnTools = canBeArmed({ permissionGate: true, nativeExtensions: false, why })
    expect(noOwnTools.ok).toBe(false)
    if (!noOwnTools.ok) expect(noOwnTools.why).toBe('has no place for those')
  })

  it('says something even where the harness declared no sentence', () => {
    const said = canBeArmed({ permissionGate: false, nativeExtensions: false, why: {} })
    expect(said.ok).toBe(false)
    if (!said.ok) expect(said.why).not.toBe('')
  })

  it('is allowed only when both are declared', () => {
    expect(canBeArmed({ permissionGate: true, nativeExtensions: true, why: {} })).toEqual({
      ok: true,
    })
  })
})
