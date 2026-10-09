import { describe, expect, it } from 'vitest'
import { ConfigSchema } from '../src/config.ts'
import { type Persona, parsePersona } from '../src/personas.ts'
import { checkPlan } from '../src/plan.ts'
import { fillTemplate, type Template } from '../src/templates.ts'
import { BUILT_IN_PERSONAS } from '../src/templates-builtin.ts'
import { dryRunOf, dryRunSays, type LimitFacts } from '../src/templates-dry-run.ts'
import { parseTemplate } from '../src/templates-store.ts'

// The dry run as the pure function it is, which is the only way to test its
// three claims: that it writes nothing, that it says what it could not see
// rather than reporting it as nought, and that it says what a template does not
// grant. The first is the load-bearing one and is tested by construction —
// there is nothing here to write with.

const personas = (): Map<string, Persona> => {
  const out = new Map<string, Persona>()
  for (const [name, text] of Object.entries(BUILT_IN_PERSONAS)) {
    const read = parsePersona(name, text)
    if (read.ok) out.set(name, read.persona)
  }
  return out
}

const DRAFT = `template: mine
version: 2
title: Fix a reported bug
project_input: project
said_input: summary
name_suffix: ticket
inputs:
  project: { kind: project }
  ticket: { kind: slug }
  summary: { kind: text }
agents:
  - name: fix
    persona: implementer
    prompt: Fix it.
  - name: read
    persona: reviewer
    after: [{ agent: fix, why: a change is read by somebody who did not write it }]
`

const template = (): Template => {
  const read = parseTemplate('mine', DRAFT)
  if (!read.ok) throw new Error(read.problems.join('; '))
  return read.template
}

const config = (over: Record<string, unknown> = {}) =>
  ConfigSchema.parse({
    agents: { workspace: 'worktree' },
    projects: { shop: { root: '/repo/shop' } },
    ...over,
  })

const dry = (
  over: {
    limits?: Partial<LimitFacts>
    inputs?: Record<string, string>
    config?: ReturnType<typeof config>
  } = {},
) => {
  const cfg = over.config ?? config()
  const one = template()
  const fill = fillTemplate(one, {
    inputs: over.inputs ?? { project: 'shop', ticket: '318', summary: 'it breaks' },
    projects: Object.keys(cfg.projects),
    workspace: () => 'worktree',
    home: '/home/.tade',
    provenance: { template: 'mine', version: 2, hash: 'sha256:abcdefabcdef', builtIn: false },
    personas: personas(),
  })
  return dryRunOf({
    provenance: { template: 'mine', version: 2, hash: 'sha256:abcdefabcdef', builtIn: false },
    template: one,
    fill,
    check: fill.ok ? checkPlan(fill.plan, { workspace: () => 'worktree', tasks: new Set() }) : null,
    config: cfg,
    personas: personas(),
    limits: { budget: [], plans: null, unread: [], ...over.limits },
  })
}

describe('a dry run', () => {
  it('is one row per task, in the order they would be made, with the persona each came from', () => {
    const run = dry()
    expect(run.problems).toEqual([])
    expect(run.tasks).toEqual([
      expect.objectContaining({
        task: 'shop/fix-318',
        persona: 'implementer',
        workspace: 'worktree',
        done: 'committed',
        produces: null,
        after: [],
        leavesChecksRed: false,
      }),
      expect.objectContaining({
        task: 'shop/read-318',
        persona: 'reviewer',
        done: 'said',
        produces: 'review.md',
        after: [{ task: 'shop/fix-318', why: 'a change is read by somebody who did not write it' }],
      }),
    ])
  })

  it('says what it grants, which is nothing, and where each thing it does not is decided', () => {
    const said = dry().permissions.join('\n')
    expect(said).toContain('grants nothing')
    expect(said).toContain('never what it is allowed')
    expect(said).toContain('approvals.mode: bypass')
    expect(said).toContain('shop: agents work in a worktree each')
    expect(said).toContain('Nothing Tade runs pushes anything itself')
  })

  it('says that agents ask, and which never do, when the policy is on', () => {
    const said = dry({
      config: config({ approvals: { mode: 'policy', auto_allow: ['Read', 'Grep'] } }),
    }).permissions.join('\n')
    expect(said).toContain('approvals.mode: policy')
    expect(said).toContain('Read and Grep never asking')
  })

  // The honest half. Three different answers, and the one that matters is that
  // none of them is nought.
  it('says a plan window it could not read as "cannot tell", never as room', () => {
    expect(dry({ limits: { plans: null } }).limits.join('\n')).toContain(
      'Plan windows: cannot tell from here',
    )
  })

  it('says there are no plan windows when there are none, which is a different answer', () => {
    const said = dry({ limits: { plans: [] } }).limits.join('\n')
    expect(said).toContain('every sign-in here is billed rather than on a plan')
    expect(said).not.toContain('cannot tell')
  })

  it('says where each sign-in stands when something could read it', () => {
    expect(dry({ limits: { plans: ['claude-code: 5h 78% used'] } }).limits.join('\n')).toContain(
      'Plan window: claude-code: 5h 78% used',
    )
  })

  it('puts what it could not read first, above everything it is less sure of', () => {
    const said = dry({
      limits: { unread: ['Could not read the journal (EACCES), so spend is unknown.'] },
    }).limits
    expect(said[0]).toContain('Could not read the journal')
    // And it never says a budget is clear in the same breath.
    expect(said.join('\n')).not.toContain('inside its budget')
  })

  it('says what a project has spent, and that nothing holds a start where no budget is set', () => {
    expect(dry().limits.join('\n')).toContain('no daily budget is set')
    expect(
      dry({
        limits: { budget: [{ project: 'shop', said: '$7.90 of $8.00 today — near its budget' }] },
      }).limits.join('\n'),
    ).toContain('$7.90 of $8.00 today — near its budget')
  })

  it('guesses nothing about what it would cost, because nothing can know that', () => {
    const said = dry().limits.join('\n')
    expect(said).toContain('not knowable before it runs')
    expect(said).not.toMatch(/would cost \$/)
  })

  it('reads as the rows, then what it grants, then the bounds — and ends saying nothing happened', () => {
    const lines = dryRunSays(dry())
    expect(lines[0]).toBe('mine@2 (sha256:abcdefabcdef) — Fix a reported bug')
    expect(lines).toContain('What this grants:')
    expect(lines).toContain('What bounds it:')
    expect(lines.at(-1)).toBe('Nothing was made, and nothing was started.')
    expect(lines.join('\n')).toContain('after shop/fix-318 — a change is read by')
  })

  it('still says nothing happened when nothing would have, and says why instead of the rows', () => {
    const run = dry({ inputs: { project: 'shop', ticket: '318' } })
    expect(run.tasks).toEqual([])
    const lines = dryRunSays(run)
    expect(lines).toContain('Nothing would be made:')
    expect(lines.join('\n')).toMatch(/summary is not filled in/)
    expect(lines.at(-1)).toBe('Nothing was made, and nothing was started.')
    // No rows, and no permissions section to read as though it had worked.
    expect(lines.join('\n')).not.toContain('What this grants:')
  })

  it('says a draft is a draft, so nothing reads as having a published version behind it', () => {
    const run = dryRunOf({
      provenance: { template: 'mine', version: 2, hash: null, builtIn: false },
      template: template(),
      fill: { ok: false, problems: ['nothing filled in'] },
      check: null,
      config: config(),
      personas: personas(),
      limits: { budget: [], plans: null, unread: [] },
    })
    expect(dryRunSays(run)[0]).toContain('mine@2 (unpublished draft)')
  })
})
