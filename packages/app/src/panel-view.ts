import type { Hit } from './hits.ts'
import { branchPreview, type NewTaskPanel, type Panel } from './panels.ts'
import type { Skin } from './skin.ts'
import { blank, box, type Drawn, type Pointer, Row } from './ui.ts'

// How each panel looks. The model of what a panel holds and what a key does to
// it is in `panels.ts`; this only draws it, and names each control so a click
// can find its way back there.

export interface PanelContext {
  width: number
  height: number
  skin: Skin
  pointer: Pointer
  /** Wilco's home, as you would type it: where worktrees are made. */
  home: string
  route: { harness: string; model: string | null; provider: string | null } | null
}

export function drawPanel(panel: Panel, ctx: PanelContext): Drawn {
  switch (panel.kind) {
    case 'new-task':
      return newTask(panel, ctx)
  }
}

/** The control that has the keyboard looks the way it would under the pointer. */
function pointerFor(ctx: PanelContext, focused: string | null): Pointer {
  if (ctx.pointer.hover || !focused) return ctx.pointer
  return { ...ctx.pointer, hover: { kind: 'control', id: focused } }
}

function newTask(panel: NewTaskPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = Math.min(76, ctx.width - 4)
  const inner = width - 2
  const pointer = pointerFor(
    ctx,
    panel.field === 'cancel' || panel.field === 'go' ? panel.field : null,
  )
  const row = () => new Row(inner, skin, pointer)
  const rows: { text: string; hits: Hit[] }[] = []

  const projects = row().space().text('Project  ', skin.hint)
  for (const project of panel.projects) {
    projects.tab(project, { kind: 'control', id: `project:${project}` }, project === panel.project)
  }
  if (panel.field === 'project') projects.text('  ← →', skin.hint)
  rows.push(projects.build())
  rows.push(blank(inner))

  rows.push(row().space().text('What needs doing?', skin.you).build())
  rows.push(
    row()
      .space()
      .field(panel.intent, inner - 2, {
        caret: panel.field === 'intent',
        hint: panel.intent === '' && panel.field !== 'intent',
        target: { kind: 'control', id: 'intent' },
      })
      .build(),
  )

  const said = panel.intent.trim()
  const slug = said ? branchPreview(said) : null
  rows.push(
    row()
      .space()
      .text('branch   ', skin.hint)
      .text(slug ?? '—', slug ? (t) => t : skin.hint)
      .build(),
  )
  rows.push(
    row()
      .space()
      .text('worktree ', skin.hint)
      .text(
        slug && panel.project
          ? `${ctx.home}/worktrees/${panel.project}-${slug.slice('wilco/'.length)}`
          : '—',
        skin.hint,
      )
      .build(),
  )
  rows.push(blank(inner))

  const route = ctx.route
  const agent = row().space().text('Agent    ', skin.hint)
  agent.text(route ? `${route.harness} · ${route.model ?? 'its default model'}` : 'pi')
  agent.right((r) => {
    r.check(panel.start, 'start it now', { kind: 'control', id: 'start' }).space()
  })
  rows.push(agent.build())

  rows.push(
    panel.error ? row().space().text(`▲ ${panel.error}`, skin.waiting).build() : blank(inner),
  )

  rows.push(
    row()
      .right((r) =>
        r
          .button('Cancel', { kind: 'control', id: 'cancel' })
          .space()
          .button(
            panel.busy ? 'Starting…' : 'Start task ⏎',
            { kind: 'control', id: 'go' },
            panel.busy ? 'off' : 'primary',
          )
          .space(),
      )
      .build(),
  )

  return box(`New task${panel.project ? ` in ${panel.project}` : ''}`, rows, width, skin, {
    corner: 'esc',
  })
}
