import type { DeskRow } from '../../frame.ts'
import type { PanelInputs } from '../../panels.ts'
import { diffPanel } from '../diff/state.ts'
import { close, type PanelOutcome, stay } from '../outcome.ts'

// The landing desk: every finished piece of work and every open review, in the
// order it is cheapest to trust (`landingDesk` in core), one row each. The
// drawing is beside this in `view.ts`.
//
// Looking at the desk lands nothing. What a row leads to is reading its change
// — the patch reader, where a line is written on and the comments go to Tade or
// to the agent whose change it is — or going to its agent. Merging is a
// person's, on the forge.

export interface LandingPanel {
  kind: 'landing'
  /** The row the keyboard is on. */
  index: number
  /** Lines of the list scrolled past. */
  scroll: number
  /** Whether the list follows the row the keyboard is on: the wheel lets go of it. */
  following: boolean
  /** What the panel last said: why a press did nothing. */
  said: string | null
  busy: false
}

export function landingPanel(): LandingPanel {
  return { kind: 'landing', index: 0, scroll: 0, following: true, said: null, busy: false }
}

/** Rows a page key moves by. */
const PAGE = 6

/**
 * ↑↓ walk the desk; enter reads the change the keyboard is on, as a patch, with
 * every other file it changed a step away; `a` goes to its agent.
 */
export function landingKey(
  panel: LandingPanel,
  key: string | undefined,
  data: string,
  inputs: PanelInputs = {},
): PanelOutcome {
  const desk = inputs.desk ?? []
  const last = Math.max(0, desk.length - 1)
  const at = (index: number) =>
    stay({ ...panel, index: Math.max(0, Math.min(last, index)), following: true, said: null })
  if (key === 'escape') return close
  if (key === 'up') return at(panel.index - 1)
  if (key === 'down') return at(panel.index + 1)
  if (key === 'pageUp') return at(panel.index - PAGE)
  if (key === 'pageDown') return at(panel.index + PAGE)
  if (key === 'home') return at(0)
  if (key === 'end') return at(last)
  if (key === 'enter' || data === 'p') return read(panel, desk[panel.index], inputs)
  if (data === 'a') return toAgent(panel, desk[panel.index])
  return stay(panel)
}

/** A row pressed is chosen; pressed again, it is read. The buttons are the two keys. */
export function landingClick(
  panel: LandingPanel,
  control: string,
  inputs: PanelInputs = {},
): PanelOutcome {
  const desk = inputs.desk ?? []
  if (control === 'close') return close
  if (control === 'patch') return read(panel, desk[panel.index], inputs)
  if (control === 'agent') return toAgent(panel, desk[panel.index])
  if (control.startsWith('row:')) {
    const index = Number(control.slice(4))
    if (!desk[index]) return stay(panel)
    if (index === panel.index) return read(panel, desk[index], inputs)
    return stay({ ...panel, index, following: true, said: null })
  }
  return stay(panel)
}

/**
 * The patch reader on that change, at its first file. A change with nothing to
 * read — nothing looked at yet, or nothing changed — stays, and says which.
 */
function read(panel: LandingPanel, row: DeskRow | undefined, inputs: PanelInputs): PanelOutcome {
  if (!row) return stay(panel)
  const files = inputs.deskFiles?.[row.task]
  if (files === undefined) {
    return stay({ ...panel, said: `what ${nameOf(row)} changed has not been looked at yet` })
  }
  if (files.length === 0) return stay({ ...panel, said: `${nameOf(row)} has nothing to read` })
  return { panel: diffPanel(row.task, files, 0), submit: false }
}

function toAgent(panel: LandingPanel, row: DeskRow | undefined): PanelOutcome {
  return row ? { panel, submit: true, choice: `agent:${row.task}` } : stay(panel)
}

function nameOf(row: DeskRow): string {
  return row.task.split('/')[1] ?? row.task
}
