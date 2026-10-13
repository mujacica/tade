import {
  addWorkflowStep,
  editWorkflow,
  type Persona,
  publishTemplate,
  readDraft,
  readPersonas,
  readPublished,
  readTemplates,
  removeWorkflowStep,
  type Template,
  templateProblems,
  type WorkflowField,
  type WorkflowScope,
  workflowFields,
  workflowPlaces,
  writeDraft,
} from '@tade/core'
import type { Frame, WorkflowView } from '../frame.ts'
import type { WorkflowPanel, WorkflowRow } from '../panels/workflow/state.ts'
import { type Wiring, why } from './context.ts'

// Writing a stored workflow, from the window.
//
// **An object the intake subject owns, not a subject of its own** — the shape
// `wire/rows.ts` already has, and for its reason: a second entry in `app.ts`
// for something that only ever answers about templates would be wiring with
// nothing of its own to wire, and the inbox and the workflows its grants stamp
// from are one surface area.
//
// **Everything it changes is a draft, and the draft on disk is the truth.**
// There is no in-memory template being edited: a press is applied through
// core's pure `editWorkflow` to the draft that was just read, written back,
// and read again. That is more I/O than holding one would be, and it is the
// reason the form and the file can never be two different templates — which is
// the failure a form over a file has, and it is not a cheap one to debug.
//
// **Publishing is a person's, here, and nothing else can reach it.** The
// orchestrator has no tool that publishes, writes or rejects a template;
// `publishTemplate` is called from this file and from the CLI, both of which
// are somebody at this machine.

export class Workflows {
  private readonly wire: Wiring
  /**
   * The template as last read, and which one it is. `snapshot` is why it
   * cannot be edited when it is a published version rather than a draft —
   * every one Tade ships, and one somebody published and has no draft of.
   */
  private read: { name: string; template: Template; snapshot: string | null } | null = null
  /** Every template there is, as last listed, for the rows down the left. */
  private listed: WorkflowRow[] = []
  private published: Record<string, readonly number[]> = {}
  private problem: string | null = null
  /**
   * The personas there are — Tade's own and yours — as `publishTemplate`
   * reads them, read with each template so a draw never waits on a file.
   */
  private personas: ReadonlyMap<string, Persona> = new Map()

  constructor(wire: Wiring) {
    this.wire = wire
  }

  /** What the open page needs to draw. */
  panel(): Frame['panel'] {
    const panel = this.wire.state.panel
    if (panel?.kind !== 'workflow') return {}
    return { workflow: this.view(panel) }
  }

  /** What the page's keys need: the fields it is walking, and the rows of its list. */
  inputs(): {
    workflowFields?: readonly WorkflowField[]
    workflowRows?: readonly WorkflowRow[]
  } {
    const panel = this.wire.state.panel
    if (panel?.kind !== 'workflow') return {}
    const view = this.view(panel)
    return { workflowFields: view?.fields ?? [], workflowRows: this.listed }
  }

  private view(panel: WorkflowPanel): WorkflowView | null {
    const read = this.read
    if (!read || read.name !== panel.template) {
      return {
        rows: this.listed.map((one) => ({ ...one, label: labelOf(one), note: '' })),
        title: panel.template || 'Workflows',
        says: '',
        fields: [],
        places: [],
        problems: [],
        warnings: [],
        published: [],
        problem: this.problem ?? (panel.template ? null : 'choose a template on the left'),
      }
    }
    const scope: WorkflowScope =
      panel.row < 0 ? { kind: 'template' } : { kind: 'step', at: panel.row }
    // Against the personas publishing would read: checked against none, every
    // step naming `implementer` was refused for a persona every home has.
    const checked = templateProblems(read.template, { personas: this.personas })
    const fields = workflowFields(read.template, scope)
    return {
      rows: this.listed.map((one) => ({
        ...one,
        label: labelOf(one, read.template),
        note: one.step < 0 && one.template === read.name ? read.template.title : '',
      })),
      title:
        panel.row < 0
          ? `${read.template.template} — the template`
          : `${read.template.template} › ${read.template.agents[panel.row]?.name ?? 'step'}`,
      says: `v${read.template.version} ${read.snapshot === null ? 'draft' : read.snapshot === SHIPPED ? 'built in' : 'published'}`,
      fields: read.snapshot ? fields.map((one) => ({ ...one, off: read.snapshot ?? '' })) : fields,
      places: workflowPlaces(read.template),
      problems: checked.problems,
      warnings: checked.warnings,
      published: this.published[read.name] ?? [],
      problem: this.problem,
    }
  }

  /** Open the page, and read what there is while it is up. */
  async open(name = ''): Promise<void> {
    this.read = null
    this.problem = null
    this.wire.put({ ...this.wire.state, panel: { ...workflowPanelOf(name), busy: true } })
    this.wire.draw()
    await this.list()
    const first = name || this.listed.find((one) => one.step < 0)?.template || ''
    if (first) await this.load(first, -1)
    else this.settle(null)
  }

  /** Every template there is, as rows: each one, and the chosen one's steps under it. */
  private async list(): Promise<void> {
    const home = this.wire.opts.client.home
    try {
      const { templates } = await readTemplates(home)
      const rows: WorkflowRow[] = []
      for (const one of templates) {
        rows.push({ id: `template:${one.name}`, template: one.name, step: -1 })
        this.published = { ...this.published, [one.name]: one.versions }
      }
      this.listed = rows
    } catch (err) {
      this.problem = why(err)
    }
  }

  /** The draft of one template, read, with its steps put into the list under it. */
  private async load(name: string, row: number): Promise<void> {
    const home = this.wire.opts.client.home
    this.personas = (await readPersonas(home)).personas
    const draft = await readDraft(home, name)
    // **No draft is the ordinary state of every template Tade ships**, and of
    // one somebody only published: the page shows that version, read only,
    // rather than an error naming a file under `templates/drafts` that was
    // never going to be there. A draft that is there and will not read is
    // still said as a problem, never hidden behind the published version.
    const published = 'missing' in draft ? await readPublished(home, name) : null
    if (published && !('problem' in published)) {
      this.read = {
        name,
        template: published.template,
        snapshot: published.builtIn ? SHIPPED : PUBLISHED,
      }
      this.problem = null
      this.steps(name, published.template.agents.length)
      this.settle(name, row)
      return
    }
    if ('problem' in draft) {
      this.read = null
      // A draft that will not read, or a name with nothing under it at all.
      this.problem = draft.problem
      this.steps(name, 0)
      this.settle(name, row)
      return
    }
    this.read = { name, template: draft.template, snapshot: null }
    this.problem = null
    this.steps(name, draft.template.agents.length)
    this.settle(name, row)
  }

  /** The chosen template's steps, as rows under its own. */
  private steps(name: string, count: number): void {
    const rows: WorkflowRow[] = []
    for (const one of this.listed) {
      if (one.step >= 0) continue
      rows.push(one)
      if (one.template !== name) continue
      for (let at = 0; at < count; at++)
        rows.push({ id: `${name}:${at}`, template: name, step: at })
    }
    this.listed = rows
  }

  /** The page is no longer busy: it has what it asked for, or the reason it has not. */
  private settle(name: string | null, row = -1): void {
    const panel = this.wire.state.panel
    if (panel?.kind !== 'workflow') return
    this.wire.put({
      ...this.wire.state,
      panel: {
        ...panel,
        busy: false,
        ...(name === null ? {} : { template: name, row }),
        ...(this.problem ? { problem: this.problem } : { problem: null }),
      },
    })
    this.wire.draw()
  }

  /** One of the page's presses, carried out. */
  async from(panel: WorkflowPanel, choice: string): Promise<void> {
    try {
      const read = this.read
      // A published version is not edited or published again from here, and
      // the reason is the one its fields already say.
      if (read?.name === panel.template && read.snapshot) {
        return this.said(panel, null, read.snapshot)
      }
      if (choice === 'publish') return await this.publish(panel)
      if (!read || read.name !== panel.template) return this.settle(panel.template, panel.row)
      const scope: WorkflowScope =
        panel.row < 0 ? { kind: 'template' } : { kind: 'step', at: panel.row }
      const edit =
        choice === 'add'
          ? addWorkflowStep(read.template)
          : choice === 'remove'
            ? removeWorkflowStep(read.template, panel.row)
            : choice.startsWith('press:')
              ? this.pressed(read.template, scope, choice.slice('press:'.length))
              : panel.typing
                ? editWorkflow(read.template, scope, panel.typing.id, panel.typing.value)
                : { ok: true as const, template: read.template }
      if ('problem' in edit) {
        this.said(panel, null, edit.problem)
        return
      }
      const written = await writeDraft(this.wire.opts.client.home, edit.template)
      if ('problem' in written) {
        this.said(panel, null, written.problem)
        return
      }
      this.read = { name: edit.template.template, template: edit.template, snapshot: null }
      // Removing the last step moves the form to the one before it; adding one
      // moves to what was added, because that is what somebody pressed + for.
      const row =
        choice === 'add'
          ? edit.template.agents.length - 1
          : choice === 'remove'
            ? Math.min(panel.row, edit.template.agents.length - 1)
            : panel.row
      this.steps(edit.template.template, edit.template.agents.length)
      this.said({ ...panel, row }, `saved ${written.path}`, null)
    } catch (err) {
      this.said(panel, null, why(err))
    }
  }

  /** A tick or a choice: the next value of that field, applied. */
  private pressed(template: Template, scope: WorkflowScope, id: string) {
    const field = workflowFields(template, scope).find((one) => one.id === id)
    if (!field) return { problem: `${id} is not a field of this` }
    if (field.off) return { problem: field.off }
    if (field.kind === 'check') return editWorkflow(template, scope, id, '')
    const options = field.options ?? []
    const at = options.indexOf(field.value)
    const next = options[(at + 1) % Math.max(1, options.length)] ?? ''
    return editWorkflow(template, scope, id, next)
  }

  /**
   * Publish the draft: a snapshot at its version, and a published version
   * never changes.
   *
   * It goes through `publishTemplate`, which is the same door `tade templates
   * publish` goes through — so the validation, the immutability and the
   * personas folded in are one implementation, and the page cannot publish
   * something the command would refuse.
   */
  private async publish(panel: WorkflowPanel): Promise<void> {
    const home = this.wire.opts.client.home
    const { personas } = await readPersonas(home)
    const result = await publishTemplate({ home, name: panel.template, personas })
    if (result.kind === 'refused') {
      this.said(panel, null, result.problems.join('; '))
      return
    }
    await this.list()
    this.steps(panel.template, this.read?.template.agents.length ?? 0)
    this.said(
      panel,
      result.kind === 'unchanged'
        ? `${panel.template}@${result.version} is already published, unchanged`
        : `published ${panel.template}@${result.version} (${result.hash})`,
      null,
    )
  }

  /** What the page says it did, or why it could not. */
  private said(panel: WorkflowPanel, what: string | null, problem: string | null): void {
    const open = this.wire.state.panel
    if (open?.kind !== 'workflow') return
    this.wire.put({
      ...this.wire.state,
      panel: { ...open, ...panel, busy: false, typing: null, said: what, problem },
    })
    this.wire.draw()
  }

  /** A row of the list clicked: load that template, or move to that step. */
  async choose(panel: WorkflowPanel): Promise<void> {
    if (this.read?.name === panel.template) return this.settle(panel.template, panel.row)
    await this.load(panel.template, panel.row)
  }
}

// Why a published version cannot be edited here, said on every field of it.
const SHIPPED =
  "Tade ships this one and its bytes are in Tade's own source: give yours another name"
const PUBLISHED =
  'a published version never changes: write a draft at the next version to change it'

/** A row's own words: a template by its name, a step by its own. */
function labelOf(row: WorkflowRow, template?: Template): string {
  if (row.step < 0) return row.template
  return template?.agents[row.step]?.name ?? `step ${row.step + 1}`
}

function workflowPanelOf(name: string): WorkflowPanel {
  return {
    kind: 'workflow',
    template: name,
    row: -1,
    index: 0,
    typing: null,
    scroll: 0,
    listScroll: 0,
    following: true,
    busy: false,
    said: null,
    problem: null,
    asking: null,
  }
}
