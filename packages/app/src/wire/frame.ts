import type { Frame } from '../frame.ts'
import type { MenuItem } from '../panels/menu/state.ts'
import type { Panel, PanelInputs } from '../panels.ts'
import { menuOf, type Subject } from './context.ts'

// The frame, folded out of the subjects that own each piece of it.
//
// What the window draws used to be one 122-line method reaching into twenty
// fields of one class, with the panel's own facts and the panel's own inputs
// as two more beside it. Every feature added a line to all three, in a file
// that knew about everything. Here the window asks each subject what it has to
// say and lays the answers over each other: adding a field to the frame is a
// change to the one subject that owns it, and this file never changes.
//
// The order of the list is the order of the fold, so two subjects answering
// for the same field would have the later one win. That is a bug rather than a
// feature: a field belongs to exactly one subject, and the only deliberate
// overlap is `panel`, where the Settings page genuinely is drawn out of four
// of them — what it says, the accounts, the models and whether this terminal
// reports key releases.

/**
 * Everything the drawing needs, from the subjects and from the window itself.
 *
 * `width`, `height` and `skin` are the window's own: how big the terminal is
 * and how it is coloured is not a subject's to answer.
 */
export function frameOf(
  subjects: readonly Subject[],
  base: Pick<Frame, 'width' | 'height' | 'skin'>,
  open: Panel | null,
): Frame {
  // `screen` is the one field the frame requires that a subject owns, and the
  // lanes subject fills it in. Empty is what a window with no lane in front of
  // you has, which is also what it had before anything was ever captured.
  let frame: Frame = { ...base, screen: '' }
  let panel: NonNullable<Frame['panel']> = {}
  for (const subject of subjects) {
    if (subject.facts) frame = { ...frame, ...subject.facts(base.width) }
    if (subject.panel) panel = { ...panel, ...subject.panel(base.width) }
  }
  // A menu's items belong to no one subject: they are the menus fold, which
  // is why they are put in here rather than by whoever owns that menu.
  if (open?.kind === 'menu') panel = { ...panel, items: menuItemsOf(subjects, open) }
  return { ...frame, panel }
}

/** What a panel needs to answer a key or a click, from whoever holds each piece. */
export function panelInputsOf(subjects: readonly Subject[], open: Panel | null): PanelInputs {
  let inputs: PanelInputs = {}
  for (const subject of subjects) {
    if (subject.inputs) inputs = { ...inputs, ...subject.inputs() }
  }
  // A menu's items belong to no one subject, here for the same reason as in
  // the frame: moving through one is moving through the menus fold.
  return open?.kind === 'menu' ? { ...inputs, items: menuItemsOf(subjects, open) } : inputs
}

/**
 * The items of an open menu, from what is true of its subject now.
 *
 * Never remembered: a menu drawn from what was true when it was opened offers
 * to stop an agent that has already stopped.
 */
export function menuItemsOf(
  subjects: readonly Subject[],
  panel: Panel | null,
): readonly MenuItem[] {
  if (panel?.kind !== 'menu') return []
  return menuOf(subjects, panel.subject.kind)?.items(panel.subject) ?? []
}
