import { visibleWidth } from '@earendil-works/pi-tui'
import type { Setting } from '@tade/core'
import { type Hit, sameTarget, type Target } from '../../hits.ts'
import { checkTalkKey, keyCaps, TALK_SUGGESTIONS } from '../../keys.ts'
import { box, type Drawn, keysWidth, Row } from '../../ui.ts'
import { cap, wrapTo } from '../cells.ts'
import type { PanelContext } from '../context.ts'
import {
  ACCOUNTS,
  choicesFor,
  matchingChoices,
  type SettingsPanel,
  UPDATES,
  usesDropdown,
} from './state.ts'

// What one setting's control looks like, and the two things that open out of
// it: the list a dropdown drops, and the panel that waits for a key to be
// pressed. The page around them is in `view.ts`.

/**
 * What an option is called where its own word is not a sentence — by the
 * setting it belongs to, because the same word means two things: `hold` is
 * how you talk, and it is also what a red check does to a push.
 */
const CHOICE_LABELS: Record<string, Record<string, string>> = {
  'surfaces.voice.talk.mode': {
    hold: 'Hold to talk',
    toggle: 'Press to start, press to stop',
  },
}

/** A choice shown as radios rather than a list. */
export function spellsOut(setting: Setting): boolean {
  return setting.type.kind === 'choice' && !usesDropdown(setting)
}

export function optionsOf(setting: Setting): { value: string; label: string; on: boolean }[] {
  if (setting.type.kind !== 'choice') return []
  const value = setting.value || setting.fallback
  return setting.type.options.map((option) => ({
    value: option,
    label: CHOICE_LABELS[setting.path]?.[option] ?? option,
    on: value === option,
  }))
}

/** Whether a setting's control fits on the line beside its name. */
export function fitsInline(setting: Setting, room: number): boolean {
  // What a setting that opens a list puts on the line is a field, cut to the
  // room it has — never the options, which are in the list. Measuring those
  // sent a setting under its own name for having wordy options it was not
  // going to draw, and left one column of controls with two in it.
  if (usesDropdown(setting)) return room >= 8
  const options = optionsOf(setting)
  if (options.length === 0) return true
  const width = options.reduce((sum, option) => sum + 2 + visibleWidth(option.label), 0)
  return width + 3 * (options.length - 1) <= room
}

/**
 * The control beside a setting, drawn for its kind and for the columns it has.
 *
 * Everything here is sized from `room` rather than from a number that was true
 * on the terminal it was written on: a control that runs past the panel edge
 * is the same bug as a name that runs into its control.
 */
export function control(
  row: Row,
  setting: Setting,
  panel: SettingsPanel,
  ctx: PanelContext,
  room: number,
): void {
  const { skin } = ctx
  const type = setting.type
  const value = setting.value
  const lit = (target: Target, tone: (text: string) => string) =>
    sameTarget(row.pointer.hover, target) ? skin.link : tone
  switch (type.kind) {
    case 'key': {
      const target = { kind: 'control' as const, id: `capture:${setting.path}` }
      const caps = keyCaps(value || setting.fallback)
      const width = keysWidth(caps)
      // The keys themselves are the control; the button is what says so, and
      // is only there where it fits beside them.
      row.keys(caps, target)
      if (room - width >= 14) row.space(3).button('Change…', target)
      return
    }
    case 'flag':
      row.toggle((value || setting.fallback) === 'true', {
        kind: 'control',
        id: `toggle:${setting.path}`,
      })
      return
    case 'number': {
      if (panel.editing?.path === setting.path) {
        row.field(panel.editing.text, Math.max(6, Math.min(10, room)), {
          caret: true,
          target: { kind: 'control', id: `edit:${setting.path}` },
        })
        return
      }
      const shown = { kind: 'control' as const, id: `edit:${setting.path}` }
      row
        .icon('‹', { kind: 'control', id: `step:${setting.path}=-1` }, 'signal')
        .text(` ${value || setting.fallback} `, lit(shown, value ? skin.you : skin.hint), shown)
        .icon('›', { kind: 'control', id: `step:${setting.path}=1` }, 'signal')
      if (type.unit && room - row.used >= visibleWidth(type.unit) + 2)
        row.space(2).text(type.unit, skin.hint)
      return
    }
    case 'hours': {
      const target = { kind: 'control' as const, id: `edit:${setting.path}` }
      if (panel.editing?.path === setting.path) {
        row.field(panel.editing.text, Math.max(8, Math.min(16, room)), { caret: true, target })
        if (room - 16 >= 18) row.space(2).text('like 22:00-07:00', skin.hint)
        return
      }
      const [from, to] = value.split('-')
      if (!value || !from || !to) {
        row.field('none', Math.max(6, Math.min(9, room)), { hint: true, target })
        return
      }
      const each = Math.max(5, Math.min(9, Math.floor((room - 4) / 2)))
      row
        .field(from, each, { target })
        .space()
        .text('to', skin.hint)
        .space()
        .field(to, each, { target })
      return
    }
    case 'text': {
      const target = { kind: 'control' as const, id: `edit:${setting.path}` }
      const width = fieldWidth(room)
      // A key is drawn like every other value. Bullets here meant seventy
      // pasted characters could not be read back and checked against the
      // console that issued them, which is what they were for.
      if (panel.editing?.path === setting.path) {
        row.field(panel.editing.text, width, { caret: true, target })
      } else {
        row.field(value || setting.fallback, width, { hint: !value, target })
      }
      return
    }
    case 'model':
    case 'choice':
      if (usesDropdown(setting)) {
        const shown =
          type.kind === 'choice'
            ? (type.about?.[value || setting.fallback]?.label ?? (value || setting.fallback))
            : value || setting.fallback
        row.field(shown, Math.max(8, Math.min(40, room)), {
          arrow: true,
          hint: !value,
          target: { kind: 'control', id: `drop:${setting.path}` },
        })
        return
      }
      optionsOf(setting).forEach((option, i) => {
        if (i > 0) row.space(3)
        row.radio(option.on, option.label, {
          kind: 'control',
          id: `set:${setting.path}=${option.value}`,
        })
      })
      return
  }
}

/**
 * How wide a text setting's field is, out of the room its row leaves it.
 * Forty at the widest, because a field that runs the whole width of a wide
 * terminal stops reading as a field.
 */
export function fieldWidth(room: number): number {
  return Math.max(8, Math.min(40, room))
}

/**
 * A text setting's value in full, where the field drawing it is too narrow to
 * hold it — and null where it fits, or where it is a credential.
 *
 * A Sentry DSN is seventy characters and the field is forty at its widest, so
 * the field shows the end of it and the beginning is behind an ellipsis: the
 * public key, which is the half a typo hides in. A value you cannot read is a
 * value you cannot check, and this is a page of options and values, so what
 * goes under the setting you are on is the value itself rather than a
 * sentence about it — the sentence is still what the search box matches on
 * and still what `tade config` prints.
 *
 * A credential is one of them. It is a long string in a narrow field, which
 * is exactly the case this was written for: an API key that cannot be read
 * back in full is one that cannot be checked for the character that is wrong.
 */
export function valueTooWide(setting: Setting, panel: SettingsPanel, room: number): string | null {
  if (setting.type.kind !== 'text') return null
  const text = panel.editing?.path === setting.path ? panel.editing.text : setting.value
  if (text === '') return null
  // The caret takes a cell of the field while you are typing in it.
  const held = fieldWidth(room) - 2 - (panel.editing?.path === setting.path ? 1 : 0)
  return visibleWidth(text) > held ? text : null
}

/** The control the keyboard would operate, so it looks the part. */
export function controlOf(setting: Setting): string | null {
  switch (setting.type.kind) {
    case 'key':
      return `capture:${setting.path}`
    case 'flag':
      return `toggle:${setting.path}`
    case 'text':
    case 'hours':
      return `edit:${setting.path}`
    default:
      return usesDropdown(setting) ? `drop:${setting.path}` : null
  }
}

/** A badge beside a category, when something there is worth a look. */
export function badgeFor(id: string, ctx: PanelContext): ((row: Row) => void) | null {
  const { skin } = ctx
  if (id === 'approvals') {
    const mode = ctx.settings.find((g) => g.id === 'approvals')?.settings[0]?.value
    return mode ? (row) => row.text(mode, skin.hint) : null
  }
  if (id === 'projects') {
    const count = ctx.settings.find((g) => g.id === 'budgets')?.settings.length ?? 0
    return count > 0 ? (row) => row.badge(count) : null
  }
  if (id === 'budgets' && ctx.budgetWarnings > 0)
    return (row) => row.text(`● ${ctx.budgetWarnings}`, skin.waiting)
  const signedIn = ctx.accounts.filter((one) => one.status.signedIn).length
  if (id === ACCOUNTS && signedIn > 0) return (row) => row.text(`● ${signedIn}`, skin.done)
  if (id === UPDATES && ctx.updates) {
    // Only what was actually asked about counts: a program nobody could ask
    // after is not a program that is up to date, and neither is it one behind.
    const behind =
      ctx.updates.programs.filter((one) => one.behind).length + (ctx.updates.tade.newer ? 1 : 0)
    if (behind > 0) return (row) => row.text(`● ${behind}`, skin.waiting)
  }
  return null
}

/** A setting's list, opened under it: grouped, narrowed by typing, the current one ticked. */
export function settingsDropdown(
  panel: SettingsPanel,
  setting: Setting,
  ctx: PanelContext,
  width = 46,
): Drawn {
  const { skin } = ctx
  const inner = width - 2
  const pointer = ctx.pointer
  const query = panel.dropdown?.query ?? ''
  const found = matchingChoices(choicesFor(setting, ctx.choices), query)
  const rows: { text: string; hits: Hit[] }[] = [
    new Row(inner, skin)
      .space()
      .field(query, inner - 2, { caret: true })
      .build(),
  ]
  let group = ''
  found.slice(0, 12).forEach((choice, index) => {
    if (
      choice.group !== group &&
      (setting.type.kind === 'model' || (setting.type.kind === 'choice' && setting.type.about))
    ) {
      group = choice.group
      // What a group needs is said once, at its heading: every option under it shares it.
      const note = choice.note
      const heading = new Row(inner, skin)
        .space()
        .text(cap(group.toUpperCase(), inner - 2), skin.label)
      if (note) heading.right((r) => r.text(note, skin.hint).space())
      rows.push(heading.build())
    }
    const on = index === (panel.dropdown?.index ?? 0)
    const target = { kind: 'control' as const, id: `choose:${choice.value}` }
    const pointed = sameTarget(pointer.hover, target)
    const r = new Row(inner, skin, pointer)
      .marker(on)
      .space()
      .text(cap(choice.label, inner - 4), on ? skin.you : pointed ? skin.link : (t: string) => t)
    r.right((right) => {
      right
        .text(choice.value === (setting.value || setting.fallback) ? '✓' : ' ', skin.done)
        .space()
    })
    const built = r.build()
    rows.push({
      text: on ? skin.selected(built.text) : pointed ? skin.hovered(built.text) : built.text,
      hits: [{ row: 0, from: 0, to: inner - 1, target }],
    })
  })
  if (found.length === 0)
    rows.push(new Row(inner, skin).space().text('Nothing matches that.', skin.hint).build())
  return box('', rows, width, skin, { corner: '▴' })
}

/** Press the keys you want to hold to talk. */
export function capture(panel: SettingsPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  // As wide as it was drawn, and never wider than the terminal it opens over.
  const width = Math.min(62, Math.max(30, ctx.width - 8))
  const inner = width - 2
  const pressed = panel.capture?.key ?? null
  const setting = ctx.settings
    .flatMap((group) => group.settings)
    .find((one) => one.path === panel.capture?.path)
  const talking = panel.capture?.path === 'surfaces.voice.talk.key'
  const printable = setting?.type.kind === 'key' && setting.type.printable === true
  const check = pressed ? checkTalkKey(pressed, printable) : null
  const row = () => new Row(inner, skin, ctx.pointer)
  const rows: { text: string; hits: Hit[] }[] = [
    { text: ' '.repeat(inner), hits: [] },
    row()
      .right((r) =>
        r
          .text(
            cap(
              talking
                ? 'Press the keys you want to hold to talk.'
                : `Press the keys for ${setting?.title ?? 'this'}.`,
              inner - 9,
            ),
            skin.you,
          )
          .space(8),
      )
      .build(),
    { text: ' '.repeat(inner), hits: [] },
  ]
  const caps = row()
  if (pressed) {
    const width = keysWidth(keyCaps(pressed))
    caps.space(Math.max(1, Math.floor((inner - width) / 2))).keys(keyCaps(pressed))
  } else {
    caps.space(Math.floor((inner - 13) / 2)).text('waiting for a key', skin.hint)
  }
  rows.push(caps.build())
  rows.push({ text: ' '.repeat(inner), hits: [] })
  if (check && !check.ok) {
    for (const line of wrapTo(`▲ ${check.reason}`, inner - 2, 2))
      rows.push(row().space().text(line, skin.bad).build())
  } else if (check?.ok && check.warning) {
    const [first, ...rest] = check.warning.split('. ')
    rows.push(
      row()
        .space()
        .text(cap(`▲ ${first}.`, inner - 2), skin.waiting)
        .build(),
    )
    if (rest.length > 0)
      for (const line of wrapTo(rest.join('. '), inner - 4, 2))
        rows.push(row().space(3).text(line, skin.hint).build())
  } else if (check?.ok) {
    rows.push(
      row()
        .space()
        .text(cap('✓ Nothing in pi or your shell uses this.', inner - 2), skin.done)
        .build(),
    )
  } else {
    rows.push({ text: ' '.repeat(inner), hits: [] })
  }
  rows.push({ text: ' '.repeat(inner), hits: [] })
  const suggested = row().space().text('Suggested: ', skin.hint)
  // Each suggestion is a click that picks it, at the columns the row itself
  // put it in — walking them a second time by hand is how the two answers
  // come to disagree the next time the caps change shape.
  const hits: Hit[] = []
  TALK_SUGGESTIONS.forEach((key, i) => {
    if (i > 0) suggested.space()
    const from = suggested.used
    suggested.keys(keyCaps(key))
    // Only the ones that were drawn: a hit past the edge of the box is a
    // click on a key cap nobody can see.
    if (suggested.used <= inner)
      hits.push({
        row: 0,
        from,
        to: suggested.used - 1,
        target: { kind: 'control', id: `capture-suggest:${key}` },
      })
  })
  rows.push({ text: suggested.build().text, hits })
  for (const line of wrapTo('Not a key that types a character.', inner - 2, 2))
    rows.push(row().space().text(line, skin.hint).build())
  rows.push({ text: ' '.repeat(inner), hits: [] })
  const usable = check?.ok === true
  rows.push(
    row()
      .right((r) =>
        r
          .button(usable ? 'Try another' : 'Cancel', { kind: 'control', id: 'capture-cancel' })
          .space()
          .button(
            usable && pressed
              ? check.warning
                ? `Use ${pressed} anyway`
                : `Use ${pressed}`
              : 'Use it',
            { kind: 'control', id: 'capture-use' },
            usable ? (check.warning ? 'attention' : 'primary') : 'off',
          )
          .space(),
      )
      .build(),
  )
  return box(talking ? 'Push to talk' : (setting?.title ?? 'Key'), rows, width, skin, {
    corner: 'esc',
  })
}
