import { DONE_RULES } from './model.ts'
import {
  INPUT_KINDS,
  type InputKind,
  LEAVES_CHECKS,
  type Template,
  type TemplateAgent,
} from './templates.ts'

// Changing a stored workflow by filling a form in, rather than by editing its
// file.
//
// **A list and a form, and never a canvas.** The comparison is in the research
// this came from: a node canvas expresses a DAG natively and costs a layout
// engine, drag, hit testing, zoom and an undo of *geometry*, and positions are
// noise in every diff. An intake template has three to five steps with one
// shape, and a canvas is for a graph you do not already know. So the shape of
// a workflow is a list of steps with an `after:` field each, which is what the
// file has had all along — and a dependency is a tick beside the step it waits
// on, with the reason beside the tick, because **a wait with no reason given
// is the one thing `checkPlan` cannot tell you anything useful about**.
//
// **Pure, and that is what makes a form worth having.** Every edit here is a
// `Template` in and a `Template` out, so the validator the file goes through
// (`templateProblems`) and the one the form goes through are the same
// function, and a form can never accept what publishing would refuse. Nothing
// here reads a file, a clock or the journal; `templates-store.ts` writes.
//
// **It edits a draft and only a draft.** A published version is immutable and
// there is no door here that could change one — not a flag, not an argument:
// the caller hands in a template and gets one back, and the only thing that
// writes a published file is `publishTemplate`.

/** Which part of a template a form is for: the whole thing, or one of its steps. */
export type WorkflowScope = { kind: 'template' } | { kind: 'step'; at: number }

/** One row of the form: what it is called, what it holds, and how it is changed. */
export interface WorkflowField {
  id: string
  label: string
  value: string
  kind: 'text' | 'choice' | 'check'
  options?: readonly string[]
  /** Said under the one the keyboard is on, where the consequence is not in the name. */
  means?: string
  /** Why it cannot be changed here, where it cannot. */
  off?: string
}

/** What a step may leave the project's own checks in, and what each means. */
const LEAVES_MEANS =
  'red where this one is expected to leave the checks failing — a reproducer. Declared rather than guessed from its words, because a workflow whose tester must commit a failing test and whose checks must pass is a deadlock'

/**
 * The form for one scope: every field there is, in the order the keyboard
 * walks them.
 *
 * The template's own fields first and the steps' second, because a template's
 * three named inputs decide what every step can even refer to — a form that
 * asked for a step's project before the project input existed would be a form
 * offering a choice nobody could make.
 */
export function workflowFields(template: Template, scope: WorkflowScope): WorkflowField[] {
  if (scope.kind === 'template') return templateFields(template)
  const step = template.agents[scope.at]
  if (!step) return []
  return stepFields(template, step, scope.at)
}

function inputNames(template: Template, kind: InputKind): string[] {
  return Object.entries(template.inputs)
    .filter(([, input]) => input.kind === kind)
    .map(([name]) => name)
}

function templateFields(template: Template): WorkflowField[] {
  return [
    {
      id: 'title',
      label: 'Title',
      value: template.title,
      kind: 'text',
      means: 'what this template is for, in a line. Publishing refuses a draft with none',
    },
    { id: 'about', label: 'About', value: template.about, kind: 'text' },
    {
      id: 'project_input',
      label: 'Project input',
      value: template.project_input,
      kind: 'choice',
      options: inputNames(template, 'project'),
      means:
        'which input names the repository its steps work in. Every cross-repository mapping is an input the template names, never a literal baked in',
    },
    {
      id: 'said_input',
      label: 'Request input',
      value: template.said_input,
      kind: 'choice',
      options: inputNames(template, 'text'),
      means:
        'which input becomes what each task says it was started with — Tade’s own sentence, never a word of what arrived from outside',
    },
    {
      id: 'name_suffix',
      label: 'Name suffix',
      value: template.name_suffix ?? '',
      kind: 'choice',
      options: ['', ...inputNames(template, 'slug')],
      means:
        'which input is put on the end of every task name. Without one the template can be used once: a task name is never used twice',
    },
  ]
}

function stepFields(template: Template, step: TemplateAgent, at: number): WorkflowField[] {
  const others = template.agents.filter((_, i) => i !== at)
  const multiline = step.prompt.includes('\n')
  const fields: WorkflowField[] = [
    {
      id: 'name',
      label: 'Name',
      value: step.name,
      kind: 'text',
      means: 'lowercase, digits and dashes: it becomes the tail of a task name',
    },
    {
      id: 'persona',
      label: 'Persona',
      value: step.persona ?? '',
      kind: 'text',
      means:
        'the start defaults its agent is given. A persona says what an agent is told and never what it is allowed',
    },
    {
      id: 'prompt',
      label: 'Told',
      value: multiline ? (step.prompt.split('\n')[0] ?? '') : step.prompt,
      kind: 'text',
      // A governing instruction is prose, and a one-line field is where prose
      // goes to die: a field that quietly dropped every line after the first
      // would be a form that edited an agent's instructions by deleting them.
      ...(multiline
        ? { off: 'it is more than a line: the words an agent is given are edited in the file' }
        : {
            means:
              'what its agent is told, verbatim. Nothing is substituted into it — an input, a path or a request body goes in the task’s context file',
          }),
    },
    {
      id: 'done',
      label: 'Finished when',
      value: typeof step.done === 'string' ? step.done : '',
      kind: 'choice',
      options: ['', ...DONE_RULES],
      ...(typeof step.done === 'object'
        ? { off: 'its rule differs by workspace: that is edited in the file' }
        : {
            means:
              'committed cannot be the rule in a shared checkout, and `checkPlan` refuses a plan that asks for it there',
          }),
    },
    { id: 'produces', label: 'Produces', value: step.produces ?? '', kind: 'text' },
    {
      id: 'touches',
      label: 'Touches',
      value: step.touches.join(' '),
      kind: 'text',
      means: 'the paths it is expected to change: what a collision with other work is read from',
    },
    {
      id: 'reads',
      label: 'Reads',
      value: step.reads.join(' '),
      kind: 'text',
      means: 'steps whose produced document this one is handed the path of',
    },
    {
      id: 'leaves_checks',
      label: 'Leaves checks',
      value: step.leaves_checks,
      kind: 'choice',
      options: [...LEAVES_CHECKS],
      means: LEAVES_MEANS,
    },
  ]
  // The dependencies: a tick per other step, and the reason beside each tick
  // that is on. A wait with no reason is a wait nobody can answer later, so
  // the reason is a field of its own rather than something to fill in after.
  for (const other of others) {
    const dep = step.after.find((one) => one.agent === other.name)
    fields.push({
      id: `after:${other.name}`,
      label: `After ${other.name}`,
      value: dep ? 'true' : 'false',
      kind: 'check',
    })
    if (dep) {
      fields.push({
        id: `why:${other.name}`,
        label: `  why it waits`,
        value: dep.why,
        kind: 'text',
        means: 'the reason this one cannot start until that one has finished',
      })
    }
  }
  return fields
}

/** What an edit came to: the template as it now is, or why it was refused. */
export type WorkflowEdit = { ok: true; template: Template } | { problem: string }

/**
 * One field, changed.
 *
 * Refusals here are only ever about what a *field* can hold — an unknown done
 * rule, a step name that is not a name. Whether the template as a whole holds
 * together is `templateProblems`', asked of the result, because a form that
 * refused every intermediate state would be a form you could not get from one
 * valid shape to another in.
 */
export function editWorkflow(
  template: Template,
  scope: WorkflowScope,
  id: string,
  value: string,
): WorkflowEdit {
  const text = value.trim()
  if (scope.kind === 'template') {
    if (id === 'title') return { ok: true, template: { ...template, title: value } }
    if (id === 'about') return { ok: true, template: { ...template, about: value } }
    if (id === 'project_input') return { ok: true, template: { ...template, project_input: text } }
    if (id === 'said_input') return { ok: true, template: { ...template, said_input: text } }
    if (id === 'name_suffix') {
      const { name_suffix: _was, ...rest } = template
      return { ok: true, template: text ? { ...rest, name_suffix: text } : rest }
    }
    return { problem: `${id} is not a field of this template` }
  }
  const step = template.agents[scope.at]
  if (!step) return { problem: `there is no step ${scope.at + 1}` }
  const put = (one: TemplateAgent): WorkflowEdit => ({
    ok: true,
    template: {
      ...template,
      agents: template.agents.map((each, i) => (i === scope.at ? one : each)),
    },
  })
  if (id === 'name') {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(text)) {
      return { problem: `"${value}" is not a step name: lowercase letters, digits, - . _` }
    }
    if (template.agents.some((each, i) => i !== scope.at && each.name === text)) {
      return { problem: `there is already a step called ${text}` }
    }
    // Every wait that named the old name names the new one: renaming a step
    // and leaving the waits behind is how a form makes a cycle out of a graph
    // that had none.
    const renamed = template.agents.map((each, i) =>
      i === scope.at
        ? { ...each, name: text }
        : {
            ...each,
            after: each.after.map((dep) =>
              dep.agent === step.name ? { ...dep, agent: text } : dep,
            ),
            reads: each.reads.map((name) => (name === step.name ? text : name)),
          },
    )
    return { ok: true, template: { ...template, agents: renamed } }
  }
  if (id === 'prompt') return put({ ...step, prompt: value })
  if (id === 'persona') {
    const { persona: _was, ...rest } = step
    return put(text ? { ...rest, persona: text } : rest)
  }
  if (id === 'produces') {
    const { produces: _was, ...rest } = step
    return put(text ? { ...rest, produces: text } : rest)
  }
  if (id === 'touches') return put({ ...step, touches: words(value) })
  if (id === 'reads') return put({ ...step, reads: words(value) })
  if (id === 'done') {
    if (text === '') {
      const { done: _was, ...rest } = step
      return put(rest)
    }
    if (!DONE_RULES.includes(text as never)) {
      return { problem: `${text} is not a done rule: ${DONE_RULES.join(', ')}` }
    }
    return put({ ...step, done: text as TemplateAgent['done'] })
  }
  if (id === 'leaves_checks') {
    if (!LEAVES_CHECKS.includes(text as never)) {
      return { problem: `${text} is not one of ${LEAVES_CHECKS.join(', ')}` }
    }
    return put({ ...step, leaves_checks: text as TemplateAgent['leaves_checks'] })
  }
  if (id.startsWith('after:')) {
    const on = id.slice('after:'.length)
    if (!template.agents.some((each) => each.name === on)) {
      return { problem: `there is no step called ${on}` }
    }
    const has = step.after.some((dep) => dep.agent === on)
    return put({
      ...step,
      after: has
        ? step.after.filter((dep) => dep.agent !== on)
        : [...step.after, { agent: on, why: '' }],
    })
  }
  if (id.startsWith('why:')) {
    const on = id.slice('why:'.length)
    return put({
      ...step,
      after: step.after.map((dep) => (dep.agent === on ? { ...dep, why: value } : dep)),
    })
  }
  return { problem: `${id} is not a field of a step` }
}

function words(value: string): string[] {
  return value
    .split(/\s+/)
    .map((one) => one.trim())
    .filter(Boolean)
}

/** A step added at the end, named so that nothing is ever named twice. */
export function addWorkflowStep(template: Template, name = 'step'): WorkflowEdit {
  const taken = new Set(template.agents.map((one) => one.name))
  let called = name
  for (let n = 2; taken.has(called); n++) called = `${name}-${n}`
  const step: TemplateAgent = {
    name: called,
    prompt: '',
    touches: [],
    after: [],
    reads: [],
    leaves_checks: 'green',
  }
  return { ok: true, template: { ...template, agents: [...template.agents, step] } }
}

/**
 * One step removed, and every wait on it removed with it.
 *
 * The last one cannot go: a template with no steps makes nothing, and the
 * schema refuses it — so it is refused here, where somebody can read why,
 * rather than at the save.
 */
export function removeWorkflowStep(template: Template, at: number): WorkflowEdit {
  const step = template.agents[at]
  if (!step) return { problem: `there is no step ${at + 1}` }
  if (template.agents.length === 1) {
    return { problem: 'a template with no steps makes nothing: this is the only one' }
  }
  const kept = template.agents
    .filter((_, i) => i !== at)
    .map((each) => ({
      ...each,
      after: each.after.filter((dep) => dep.agent !== step.name),
      reads: each.reads.filter((name) => name !== step.name),
    }))
  return { ok: true, template: { ...template, agents: kept } }
}

/** One step in the preview: where it sits in the resolved tree, and what it waits on. */
export interface WorkflowPlace {
  at: number
  name: string
  /** Its column in the resolved tree: how far down the longest chain into it. */
  depth: number
  /** The index of the step it hangs off, or -1 where it hangs off nothing. */
  parent: number
  /** Why it waits, as whoever wrote the wait said. */
  why: readonly { on: string; why: string }[]
  /** True where it is in a cycle, which is why no depth could be worked out. */
  circular: boolean
}

/**
 * The resolved order, as a tree: the preview, and the same layout the queue is
 * drawn in down the side.
 *
 * **The columns are the whole of what the picture says**, so a step's column
 * is the longest chain into it and never a shorter one — work that can run
 * side by side lines up under work that can run side by side. A cycle has no
 * such number, so it is *named* rather than drawn at some depth that would
 * read as an order: `templateProblems` is what refuses it, and this says which
 * steps it is about.
 */
export function workflowPlaces(template: Template): WorkflowPlace[] {
  const index = new Map(template.agents.map((one, i) => [one.name, i]))
  const waits = template.agents.map((one) =>
    one.after.map((dep) => index.get(dep.agent)).filter((at): at is number => at !== undefined),
  )
  // Whether each step can reach itself, which is what being in a cycle *is*.
  // Asked of every step rather than noticed while walking: a walk marks the
  // step where it found the back edge and not the others on the loop, so half
  // a cycle would be drawn at a depth that reads as an order.
  const circular = template.agents.map((_, from) => {
    const seen = new Set<number>()
    const todo = [...(waits[from] ?? [])]
    while (todo.length > 0) {
      const at = todo.pop() as number
      if (at === from) return true
      if (seen.has(at)) continue
      seen.add(at)
      todo.push(...(waits[at] ?? []))
    }
    return false
  })
  const depth = new Array<number>(template.agents.length).fill(-1)
  const deepest = (at: number): number => {
    const known = depth[at] ?? -1
    if (known >= 0) return known
    // A step on a cycle has no depth, and one that waits on such a step is
    // measured from it as though it were a root: the cycle is named, and
    // nothing downstream of it is drawn as further along than it is.
    if (circular[at]) return 0
    depth[at] = 0
    let most = 0
    for (const up of waits[at] ?? []) most = Math.max(most, (circular[up] ? 0 : deepest(up)) + 1)
    depth[at] = most
    return most
  }
  return template.agents.map((one, at) => {
    const place = circular[at] ? 0 : deepest(at)
    // Its parent is the wait that put it in its column: the deepest of them,
    // so the line the tree draws into it comes from the thing it is actually
    // behind rather than from whichever wait was written first.
    let parent = -1
    let parentDepth = -1
    for (const up of waits[at] ?? []) {
      const of = circular[up] ? 0 : deepest(up)
      if (of > parentDepth) {
        parentDepth = of
        parent = up
      }
    }
    return {
      at,
      name: one.name,
      depth: place,
      parent,
      why: one.after.map((dep) => ({ on: dep.agent, why: dep.why })),
      circular: circular[at] === true,
    }
  })
}

/** Every input kind a form may offer, in the order a form offers them. */
export const WORKFLOW_INPUT_KINDS = INPUT_KINDS
