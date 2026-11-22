import { ENV_FILE_SAID, type GridRow, KEYS_AND_AGENTS, type Mark } from '@tade/core'
import type { Hit } from '../../hits.ts'
import type { Look } from '../../skin.ts'
import { Row } from '../../ui.ts'
import { cap, padTo, withFocus, wrapTo } from '../cells.ts'
import type { PanelContext } from '../context.ts'
import { type PanelOutcome, stay } from '../outcome.ts'
import type { SettingsPanel } from './state.ts'

// The Machines page: what each of the person's machines has, item by item — a
// row per sign-in, key, environment key, MCP server, git identity, origin, app
// and public name, a column per machine, each cell `✓` set, `✗` missing, `≠`
// set to a different key, `—` not used there, `?` cannot tell, and the days a
// sign-in has left (`@tade/core`'s `machineGrid`, folded on every draw from
// what each machine last said — never kept).
//
// **And where each key is set here**, under its row — `~/.zshenv:14`, `Tade’s
// environment` — with what is wrong with it: a key `tade serve` never sees
// because only a shell's own file sets it. That is the one press the page
// offers beyond looking again: moving the keys the shell files set into one
// file (`~/.config/tade/env`), shown first as a diff with every value hidden,
// and done only on a second press, with `KEYS_AND_AGENTS` said between.

/** The Machines page's id among the categories. */
export const MACHINES = 'machines'

/** One machine's column, as the page heads it. */
export interface MachineColumn {
  machine: string
  /** When what it said was heard, in this machine's clock; null for now, or never. */
  asOf: number | null
  /** This machine. */
  here: boolean
  /** Why it has nothing to say, where it has not. */
  said: string | null
}

/** What moving the keys would do, shown before the press that does it. */
export interface PlanShown {
  /** The lines that change, values hidden. */
  diff: readonly string[]
  moved: readonly string[]
  left: readonly { name: string; where: string; why: string }[]
}

/** Everything the page draws. */
export interface MachinesShown {
  columns: readonly MachineColumn[]
  rows: readonly GridRow[]
  /** A look here is under way. */
  looking: boolean
  /** The plan shown, before a press moves the keys; null where none is. */
  plan: PlanShown | null
  /** Working the plan out, or moving the keys. */
  busy: boolean
  /** What the last move said, whatever happened. */
  said: string | null
}

/** One press on the page: `machine:<verb>`. */
export interface MachineAction {
  id: string
  label: string
  /** What it says between its two presses. */
  again?: string
}

export const LOOK = 'machine:look'
export const PLAN = 'machine:plan'
export const MOVE = 'machine:move'
export const CANCEL = 'machine:cancel'

/** Everything the keyboard can be on, in drawing order. */
export function machineActions(shown: MachinesShown | null): MachineAction[] {
  if (shown === null) return []
  const actions: MachineAction[] = [{ id: LOOK, label: shown.looking ? 'Looking…' : 'Look again' }]
  if (shown.plan === null) {
    actions.push({
      id: PLAN,
      label: shown.busy ? 'Working it out…' : `Move keys into ${ENV_FILE_SAID}…`,
    })
  } else {
    if (shown.plan.moved.length > 0) {
      actions.push({
        id: MOVE,
        label: shown.busy ? 'Moving…' : 'Move them',
        again: 'Press again to move them',
      })
    }
    actions.push({ id: CANCEL, label: 'Leave them' })
  }
  return actions
}

/** A press: the move is asked twice, because it edits the person's own files. */
export function machineChoice(panel: SettingsPanel, id: string): PanelOutcome {
  if (id === MOVE && panel.confirm !== id)
    return stay({ ...panel, confirm: id, saved: null, error: null })
  return { panel: { ...panel, confirm: null }, submit: true, choice: id }
}

/** How a mark is toned. */
function toneOf(mark: Mark, ctx: PanelContext): (text: string) => string {
  const { skin } = ctx
  if (mark === '✓') return skin.done
  if (mark === '✗') return skin.bad
  if (mark === '≠') return skin.waiting
  return skin.hint
}

/** The width of one machine's cell: a mark, a space, and days. */
const CELL = 8
/** The least a row's label is given. */
const LABEL_LEAST = 14

export function drawMachines(
  panel: SettingsPanel,
  ctx: PanelContext,
  form: number,
  body: { text: string; hits: Hit[] }[],
  keepInView: (from: number, to: number) => void,
): void {
  const { skin } = ctx
  const shown = ctx.inventories ?? null
  const actions = machineActions(shown)
  const focused = panel.focus === 'form' ? (actions[panel.row]?.id ?? null) : null
  const keys = withFocus(ctx.pointer, focused)
  const say = (text: string, tone = skin.hint, indent = 3, lines = 3) => {
    for (const line of wrapTo(text, Math.max(1, form - indent - 1), lines)) {
      body.push(new Row(form, skin).space(indent).text(line, tone).build())
    }
  }
  const buttons = (ids: readonly string[], look: Look = 'rest') => {
    const mine = actions.filter((one) => ids.includes(one.id))
    if (mine.length === 0) return
    const row = new Row(form, skin, keys).space(3)
    for (const one of mine) {
      const label = panel.confirm === one.id ? (one.again ?? one.label) : one.label
      row
        .button(
          cap(label, Math.max(1, form - row.used - 5)),
          { kind: 'control', id: one.id },
          one.id === MOVE ? 'danger' : look,
        )
        .space()
    }
    if (focused !== null && ids.includes(focused)) keepInView(body.length, body.length)
    body.push(row.build())
  }
  if (shown === null) {
    say('Looking at what this machine has…')
    return
  }
  say(
    'What each of your machines has, by name: ✓ set, ✗ missing, ≠ a different key, — not used there, ? cannot tell. Values never leave the machine they are on; keys are compared by digest.',
    skin.hint,
    1,
    4,
  )
  buttons([LOOK])

  // The heading: a column per machine, as of when each last said.
  const columns = shown.columns
  const room = Math.max(1, Math.floor((form - 3 - LABEL_LEAST) / CELL))
  const drawn = columns.slice(0, room)
  const label = Math.max(LABEL_LEAST, form - 3 - drawn.length * CELL - 1)
  const head = new Row(form, skin).space(3).text(padTo('', label), skin.label)
  for (const one of drawn)
    head.text(padTo(cap(one.machine, CELL - 1), CELL), one.here ? skin.you : skin.label)
  body.push(head.build())
  for (const one of drawn) {
    const asOf = one.said ?? (one.asOf === null ? null : `as of ${ctx.date(one.asOf)}`)
    if (asOf) say(`${one.machine}: ${asOf}`, skin.hint, 3, 2)
  }
  if (columns.length > drawn.length) {
    say(
      `${columns.length - drawn.length} more machine(s) than this width shows: widen the window`,
      skin.hint,
      3,
      1,
    )
  }

  let kind: string | null = null
  for (const row of shown.rows) {
    if (row.kind !== kind) {
      kind = row.kind
      body.push(
        new Row(form, skin)
          .space(1)
          .text(cap(KIND_TITLE[row.kind] ?? row.kind, form - 2), skin.label)
          .build(),
      )
    }
    const line = new Row(form, skin)
      .space(3)
      .text(padTo(cap(row.label, label - 1), label), (s) => s)
    row.cells.slice(0, drawn.length).forEach((cell) => {
      const days = cell.days === null ? '' : ` ${cell.days}d`
      line.text(padTo(`${cell.mark}${days}`, CELL), toneOf(cell.mark, ctx))
    })
    body.push(line.build())
    // Where it is set here, and what is wrong with it: this machine's column.
    const here = row.cells[drawn.findIndex((one) => one.here)]
    if (here && here.where.length > 0) say(here.where.join(' · '), skin.hint, 5, 2)
    if (here?.said) say(here.said, here.mark === '✓' ? skin.hint : skin.waiting, 5, 3)
  }
  if (shown.rows.length === 0) say('Nothing to compare yet.', skin.hint, 3, 1)

  // Moving the keys into one file, on two presses.
  body.push(new Row(form, skin).build())
  body.push(
    new Row(form, skin)
      .space(1)
      .text(cap(`Keys in one file`, form - 2), skin.label)
      .build(),
  )
  say(
    `Your shell’s files can keep their keys in ${ENV_FILE_SAID} instead: one file your login shell and \`tade serve\` both read, which you keep in step between machines yourself (chezmoi with age, op inject, Syncthing, a private dotfiles repository with sops or git-crypt). Shown first as a diff with every value hidden; each file is copied beside itself, a fresh login shell is asked before and after, and anything different puts every file back byte for byte.`,
    skin.hint,
    3,
    Number.POSITIVE_INFINITY,
  )
  if (shown.plan !== null) {
    const plan = shown.plan
    for (const line of plan.diff) {
      body.push(
        new Row(form, skin)
          .space(3)
          .text(
            cap(line, form - 4),
            line.includes(' - ') ? skin.bad : line.includes(' + ') ? skin.done : skin.label,
          )
          .build(),
      )
    }
    for (const one of plan.left)
      say(`left: ${one.name} at ${one.where} — ${one.why}`, skin.waiting, 3, 2)
    if (plan.moved.length === 0) say('Nothing can be moved as it is.', skin.hint, 3, 1)
    if (panel.confirm === MOVE) say(KEYS_AND_AGENTS, skin.hint, 3, Number.POSITIVE_INFINITY)
    buttons([MOVE, CANCEL])
  } else buttons([PLAN])
  if (shown.said) say(shown.said, skin.hint, 3, 4)
}

const KIND_TITLE: Readonly<Record<string, string>> = {
  'sign-in': 'Sign-ins',
  secret: 'Keys',
  env: 'Environment keys',
  mcp: 'MCP servers',
  git: 'Git',
  origin: 'Origin, with this machine’s credentials',
  app: 'Per-machine apps',
  public: 'Public name',
}
