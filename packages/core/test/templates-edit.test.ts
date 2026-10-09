import { describe, expect, it } from 'vitest'
import type { Template, TemplateAgent } from '../src/templates.ts'
import { templateProblems } from '../src/templates.ts'
import {
  addWorkflowStep,
  editWorkflow,
  removeWorkflowStep,
  type WorkflowEdit,
  workflowFields,
  workflowPlaces,
} from '../src/templates-edit.ts'

// Writing a stored workflow by filling a form in: a list of steps with an
// `after:` field each, which is what the file has had all along.
//
// Every edit is a `Template` in and a `Template` out, so what the form accepts
// and what publishing refuses are the same function asked twice —
// `templateProblems` — and that is what these tests actually check: not that
// the form is permissive, but that nothing it produces is a shape the
// validator would not have.

const step = (over: Partial<TemplateAgent> = {}): TemplateAgent => ({
  name: 'reproduce',
  prompt: 'Reproduce it, and leave the failing test committed.',
  touches: [],
  after: [],
  reads: [],
  leaves_checks: 'green',
  ...over,
})

const template = (over: Partial<Template> = {}): Template => ({
  template: 'bug',
  version: 1,
  title: 'A bug, reproduced then fixed',
  about: '',
  project_input: 'project',
  said_input: 'request',
  name_suffix: 'slug',
  inputs: {
    project: { kind: 'project', required: true, about: '' },
    request: { kind: 'text', required: true, about: '' },
    slug: { kind: 'slug', required: true, about: '' },
    report: { kind: 'document', required: false, about: '' },
  },
  agents: [
    step(),
    step({ name: 'fix', after: [{ agent: 'reproduce', why: 'no fix before a failure' }] }),
  ],
  ...over,
})

const got = (edit: WorkflowEdit): Template => {
  if ('problem' in edit) throw new Error(edit.problem)
  return edit.template
}
const refused = (edit: WorkflowEdit): string => {
  if (!('problem' in edit)) throw new Error('it was not refused')
  return edit.problem
}

describe('the form a workflow is written in', () => {
  it('offers the template’s three named inputs as choices, not as free text', () => {
    const fields = workflowFields(template(), { kind: 'template' })
    const project = fields.find((one) => one.id === 'project_input')
    expect(project?.kind).toBe('choice')
    // Only the inputs of the right kind: a project input is the only thing
    // that can name a repository, and offering a document would be offering a
    // choice the validator refuses.
    expect(project?.options).toEqual(['project'])
    expect(fields.find((one) => one.id === 'said_input')?.options).toEqual(['request'])
  })

  it('offers a tick per other step, and the reason beside the ticks that are on', () => {
    const fields = workflowFields(template(), { kind: 'step', at: 1 })
    expect(fields.find((one) => one.id === 'after:reproduce')?.value).toBe('true')
    expect(fields.find((one) => one.id === 'why:reproduce')?.value).toBe('no fix before a failure')
    // Nothing offers a step a wait on itself, which is the shortest cycle
    // there is.
    expect(fields.some((one) => one.id === 'after:fix')).toBe(false)
  })

  it('will not edit a prompt of more than a line, and says where it is edited', () => {
    const many = template({ agents: [step({ prompt: 'one\ntwo' })] })
    const field = workflowFields(many, { kind: 'step', at: 0 }).find((one) => one.id === 'prompt')
    expect(field?.off).toContain('edited in the file')
    // And the edit itself is refused through the same answer, so a click that
    // got past the drawing cannot drop the rest of somebody's instructions.
    const panelWould = workflowFields(many, { kind: 'step', at: 0 }).find(
      (one) => one.id === 'prompt',
    )
    expect(panelWould?.value).toBe('one')
  })

  it('will not edit a done rule that differs by workspace', () => {
    const split = template({
      agents: [step({ done: { checkout: 'said', worktree: 'committed' } })],
    })
    const field = workflowFields(split, { kind: 'step', at: 0 }).find((one) => one.id === 'done')
    expect(field?.off).toContain('differs by workspace')
  })
})

describe('changing one', () => {
  it('rewires every wait when a step is renamed', () => {
    const next = got(editWorkflow(template(), { kind: 'step', at: 0 }, 'name', 'repro'))
    expect(next.agents[1]?.after).toEqual([{ agent: 'repro', why: 'no fix before a failure' }])
    // A rename that left the waits behind would make a plan that waits on a
    // step that does not exist — which `checkPlan` refuses, after the file was
    // already written.
    expect(templateProblems(next, { personas: new Map() }).problems).toEqual([])
  })

  it('refuses a name that is not a name, and one that is already taken', () => {
    expect(
      refused(editWorkflow(template(), { kind: 'step', at: 0 }, 'name', 'Repro It')),
    ).toContain('not a step name')
    expect(refused(editWorkflow(template(), { kind: 'step', at: 0 }, 'name', 'fix'))).toContain(
      'already a step called fix',
    )
  })

  it('ticks a dependency on and off, and keeps the reason while it is on', () => {
    const on = got(editWorkflow(template(), { kind: 'step', at: 0 }, 'after:fix', ''))
    expect(on.agents[0]?.after).toEqual([{ agent: 'fix', why: '' }])
    const why = got(editWorkflow(on, { kind: 'step', at: 0 }, 'why:fix', 'it reads the fix'))
    expect(why.agents[0]?.after).toEqual([{ agent: 'fix', why: 'it reads the fix' }])
    const off = got(editWorkflow(why, { kind: 'step', at: 0 }, 'after:fix', ''))
    expect(off.agents[0]?.after).toEqual([])
  })

  it('lets the form make a cycle, and the validator is what refuses it', () => {
    // A form that refused every intermediate state would be a form you could
    // not get from one valid shape to another in. What it may never do is
    // *publish* one, and that is `templateProblems`.
    const cycle = got(editWorkflow(template(), { kind: 'step', at: 0 }, 'after:fix', ''))
    expect(templateProblems(cycle, { personas: new Map() }).problems.join(' ')).toContain(
      'waits on',
    )
    expect(workflowPlaces(cycle).every((one) => one.circular)).toBe(true)
  })

  it('refuses a done rule that is not one', () => {
    expect(refused(editWorkflow(template(), { kind: 'step', at: 0 }, 'done', 'maybe'))).toContain(
      'not a done rule',
    )
  })

  it('unsets rather than writing an empty string', () => {
    const none = got(editWorkflow(template(), { kind: 'step', at: 0 }, 'persona', '  '))
    expect(none.agents[0]).not.toHaveProperty('persona')
    const noSuffix = got(editWorkflow(template(), { kind: 'template' }, 'name_suffix', ''))
    expect(noSuffix).not.toHaveProperty('name_suffix')
  })

  it('adds a step under a name nothing else has', () => {
    const one = got(addWorkflowStep(template(), 'fix'))
    expect(one.agents.map((each) => each.name)).toEqual(['reproduce', 'fix', 'fix-2'])
  })

  it('takes every wait on a step away with the step, and will not take the last one', () => {
    const one = got(removeWorkflowStep(template(), 0))
    expect(one.agents.map((each) => each.name)).toEqual(['fix'])
    expect(one.agents[0]?.after).toEqual([])
    expect(refused(removeWorkflowStep(one, 0))).toContain('only one')
  })
})

describe('the preview', () => {
  it('puts each step in the column its longest chain gives it', () => {
    const three = template({
      agents: [
        step({ name: 'a' }),
        step({ name: 'b', after: [{ agent: 'a', why: 'x' }] }),
        step({
          name: 'c',
          after: [
            { agent: 'a', why: 'x' },
            { agent: 'b', why: 'y' },
          ],
        }),
      ],
    })
    // Not the shortest: `c` waits on `a` as well as `b`, and drawing it beside
    // `b` would say the two can run side by side, which is the one thing the
    // columns must never say wrongly.
    expect(workflowPlaces(three).map((one) => one.depth)).toEqual([0, 1, 2])
    expect(workflowPlaces(three).map((one) => one.parent)).toEqual([-1, 0, 1])
  })

  it('names the steps in a cycle rather than giving them a depth that reads as an order', () => {
    const loop = template({
      agents: [
        step({ name: 'a', after: [{ agent: 'b', why: 'x' }] }),
        step({ name: 'b', after: [{ agent: 'a', why: 'y' }] }),
      ],
    })
    expect(workflowPlaces(loop).map((one) => one.circular)).toEqual([true, true])
  })

  it('carries every wait’s reason, including the ones nobody gave', () => {
    const places = workflowPlaces(
      got(editWorkflow(template(), { kind: 'step', at: 0 }, 'after:fix', '')),
    )
    expect(places[0]?.why).toEqual([{ on: 'fix', why: '' }])
  })
})
