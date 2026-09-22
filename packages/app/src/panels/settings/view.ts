import { visibleWidth } from '@earendil-works/pi-tui'
import { HARNESS_CHOICES, type Setting } from '@tade/core'
import { type Hit, sameTarget, type Target } from '../../hits.ts'
import { blank, box, NO_POINTER, type Pointer, Row } from '../../ui.ts'
import { cap, fitTo, padTo, sideWidth, withFocus, wrapTo } from '../cells.ts'
import type { PanelContext, PanelDrawing } from '../context.ts'
import {
  badgeFor,
  capture,
  control,
  controlOf,
  fitsInline,
  optionsOf,
  settingsDropdown,
  spellsOut,
} from './control.ts'
import { ACCOUNTS, accountActions, type SettingsPanel, UPDATES, visibleSettings } from './state.ts'
import { drawUpdates } from './updates.ts'

// How the Settings panel is laid out: the categories down the side, the group
// you are on beside them, and every setting as a name and a control. What one
// control looks like is in `control.ts`, and the Updates page in `updates.ts`.

/** Columns kept blank between a setting's name and its control, at every width. */
const GAP = 2

/**
 * How a group's rows are laid out: what the name gets, what is left for the
 * control, and whether the two fit on one line at all.
 *
 * One layout for the whole group rather than one per row, because a column of
 * controls that each start somewhere else is the thing this panel was rebuilt
 * to stop. The name column is the longest name there is, and never more than
 * half of what there is, so a long name gives up columns rather than the
 * control it belongs to — and what is still too long is cut with an ellipsis,
 * which is what says a word was cut.
 */
export interface FormLayout {
  /** Columns the name gets, before the gap. */
  label: number
  /** Columns the control has, after the gap. */
  control: number
  /** What is said beside anything that waits for a restart; null where there is no room. */
  restart: string | null
  /** Columns that note takes, which a setting that does not wait may use. */
  note: number
  /** The control sits under its name, indented, rather than beside it. */
  stacked: boolean
}

export function formLayout(form: number, rows: readonly Setting[]): FormLayout {
  const waits = rows.some((setting) => !setting.live)
  // Said in words where they fit, and as the mark alone where they do not:
  // that a setting waits for a restart is not something to leave out.
  const restart = !waits ? null : form >= 56 ? '↻ on restart' : form >= 22 ? '↻' : null
  const note = restart ? visibleWidth(restart) + 3 : 0
  const longest = Math.max(0, ...rows.map((setting) => visibleWidth(setting.title)))
  const most = Math.max(8, Math.floor((form - 1 - GAP - note) / 2))
  const label = Math.max(8, Math.min(longest, most))
  const control = form - 1 - label - GAP - note
  if (control >= 16) return { label, control, restart, note, stacked: false }
  // Too narrow for two columns: the name takes the line and the control the
  // next one, which is the one shape that cannot overlap at any width.
  return {
    label: Math.max(4, form - 3 - (restart ? visibleWidth(restart) + 1 : 0)),
    control: Math.max(4, form - 4),
    restart,
    note: 0,
    stacked: true,
  }
}

/** What a control may use: its column, and the note's columns where it has no note. */
function roomFor(layout: FormLayout, setting: Setting): number {
  return layout.control + (setting.live ? layout.note : 0)
}

/** Whether the pointer is on this setting: its row, or any control of it. */
function onSetting(hover: Target | null, path: string): boolean {
  if (hover?.kind !== 'control') return false
  const arg = hover.id.split(':').slice(1).join(':')
  return arg === path || arg.startsWith(`${path}=`)
}

/** The first line of a list to show, so the one you are on is always in it. */
function scrolledTo(lines: number, room: number, from: number, to: number): number {
  if (lines <= room || room <= 0) return 0
  const most = lines - room
  const offset = to >= room ? Math.min(to - room + 1, most) : 0
  return Math.max(0, Math.min(from < offset ? from : offset, most))
}

export function settings(panel: SettingsPanel, ctx: PanelContext): PanelDrawing {
  const { skin } = ctx
  const width = Math.min(104, Math.max(32, ctx.width - 6))
  const height = Math.max(14, Math.min(28, ctx.height - 4))
  const inner = width - 2
  const side = sideWidth(inner)
  const form = inner - side - 1
  const pointer = ctx.pointer
  const plain = (text: string) => text

  // ── the side: search, then categories ──
  const aside: { text: string; hits: Hit[] }[] = []
  const searching = panel.search === '' && panel.focus !== 'search'
  aside.push(
    new Row(side, skin, pointer)
      .space()
      .field(searching ? 'search settings' : panel.search, side - 2, {
        caret: panel.focus === 'search',
        // The field says what it is for until you use it.
        hint: searching,
        target: { kind: 'control', id: 'search' },
      })
      .build(),
  )
  aside.push(blank(side))
  const categories = [
    ...ctx.settings.map((group) => ({ id: group.id, title: group.title })),
    { id: ACCOUNTS, title: 'Accounts' },
    { id: UPDATES, title: 'Updates' },
  ]
  for (const category of categories) {
    const on = panel.search === '' && panel.category === category.id
    const target = { kind: 'control' as const, id: `category:${category.id}` }
    const pointed = sameTarget(pointer.hover, target)
    const row = new Row(side, skin, pointer)
      .marker(on, target)
      .space()
      .text(cap(category.title, side - 3), on ? skin.you : pointed ? skin.link : plain, target)
    row.right((r) => {
      const badge = badgeFor(category.id, ctx)
      if (badge) badge(r)
      r.space()
    })
    const built = row.build()
    aside.push({
      text: on ? skin.selected(built.text) : pointed ? skin.hovered(built.text) : built.text,
      hits: [{ row: 0, from: 0, to: side - 1, target }],
    })
  }

  // ── the head of the form: the heading, and then the settings ──
  const group = ctx.settings.find((g) => g.id === panel.category)
  const title = panel.search
    ? `Matching “${panel.search}”`
    : panel.category === ACCOUNTS
      ? 'Accounts'
      : panel.category === UPDATES
        ? 'Updates'
        : (group?.title ?? '')
  const head: { text: string; hits: Hit[] }[] = [
    new Row(form, skin)
      .space()
      .text(cap(title, form - 2), skin.brand)
      .build(),
  ]
  // A heading and then the settings. What a group is about is still written
  // down — `about` is half of what the search box matches on, and `tade
  // config` reads it — but three lines of prose over every page, saying what
  // the heading and the controls under it already say, is the paragraph this
  // panel was asked to stop drawing.
  head.push(blank(form))

  // ── the form ──
  const rows =
    panel.category === ACCOUNTS && !panel.search ? [] : visibleSettings(panel, ctx.settings)
  const layout = formLayout(form, rows)
  const body: { text: string; hits: Hit[] }[] = []
  /** Where the focused setting's lines begin and end, so it is kept in view. */
  let focusFrom = 0
  let focusTo = 0
  /** Where a dropdown would open: the line under its control, and its column. */
  let anchor: { line: number; col: number } | null = null

  if (panel.category === ACCOUNTS && !panel.search) {
    const actions = accountActions(ctx.accounts)
    const focused = panel.focus === 'form' ? (actions[panel.row]?.id ?? null) : null
    const named = Math.min(22, Math.max(6, form - 30))
    /** The last line that was a row of buttons, so two never end up touching. */
    let lastButtons = -2
    // Buttons for one account, or for its harness when `account` is undefined,
    // laid out on as many rows as they need — with a blank line between two
    // rows of them, wherever they come from. A button is a label on its own
    // painted ground, so two rows with nothing between are one block of
    // colour: the gap is the same column that separates them sideways, going
    // down instead.
    const buttons = (harness: string, account: string | null | undefined) => {
      const mine = actions.filter(
        (action) =>
          action.harness === harness &&
          (account === undefined ? action.account === undefined : action.account === account),
      )
      if (mine.length === 0) return
      let row = new Row(form, skin, withFocus(pointer, focused)).space(3)
      let holds: string[] = []
      const put = () => {
        if (lastButtons === body.length - 1) body.push(blank(form))
        // Where the focused button ended up, read after the gap rather than
        // before it: a line counted before one is inserted is the line above.
        if (focused !== null && holds.includes(focused)) {
          focusFrom = body.length
          focusTo = body.length
        }
        body.push(row.build())
        lastButtons = body.length - 1
        holds = []
      }
      for (const action of mine) {
        const label = panel.confirm === action.id ? 'Press again to remove' : action.label
        const width = visibleWidth(label) + 3
        if (row.used + width > form - 1 && row.used > 3) {
          put()
          row = new Row(form, skin, withFocus(pointer, focused)).space(3)
        }
        holds.push(action.id)
        row.button(
          label,
          { kind: 'control', id: action.id },
          action.danger ? 'danger' : account === undefined ? 'add' : undefined,
        )
        row.space()
      }
      put()
    }
    const harnesses = [...new Set(ctx.accounts.map((one) => one.harness))]
    for (const harness of harnesses) {
      const title = HARNESS_CHOICES.find((one) => one.id === harness)?.title ?? harness
      body.push(
        new Row(form, skin)
          .space()
          .text(cap(title, form - 2), skin.brand)
          .build(),
      )
      const mine = ctx.accounts.filter((one) => one.harness === harness)
      for (const one of mine) {
        const status = one.status.signedIn
          ? [
              one.kind === 'api-key'
                ? '● paid with an API key'
                : `● ${one.status.who ?? 'signed in'}${one.status.plan ? ` · ${one.status.plan}` : ''}`,
              one.limits?.fiveHour ? `${Math.round(one.limits.fiveHour.used)}% of 5h` : null,
              one.agents > 0 ? `${one.agents} agent${one.agents === 1 ? '' : 's'}` : null,
            ]
              .filter(Boolean)
              .join(' · ')
          : `○ ${one.status.problem ?? 'not signed in'}`
        body.push(
          new Row(form, skin)
            .space()
            .text(one.forNewAgents ? '▸ ' : '  ', skin.you)
            .text(padTo(cap(one.name ?? 'its own sign-in', named), named))
            .text(cap(status, form - named - 5), one.status.signedIn ? skin.done : skin.hint)
            .build(),
        )
        buttons(harness, one.name)
      }
      buttons(harness, undefined)
      const why = mine.find((one) => !one.canAdd)?.why
      if (why) {
        for (const line of wrapTo(`${title} ${why}.`, form - 4, 2)) {
          body.push(new Row(form, skin).space(3).text(line, skin.hint).build())
        }
      }
      body.push(blank(form))
    }
    if (ctx.accounts.length === 0)
      body.push(
        new Row(form, skin)
          .space()
          .text(cap('Asking each harness…', form - 2), skin.hint)
          .build(),
      )
  } else if (panel.category === UPDATES && !panel.search) {
    drawUpdates(panel, ctx, form, body, (from, to) => {
      focusFrom = from
      focusTo = to
    })
  } else if (rows.length === 0) {
    body.push(
      new Row(form, skin)
        .space()
        .text(cap('Nothing here matches.', form - 2), skin.hint)
        .build(),
    )
  }

  rows.forEach((setting, at) => {
    const focused = panel.focus === 'form' && at === panel.row
    // The focused row's control is drawn as though pointed at, so the keyboard
    // and the pointer say the same thing — the row's own light comes from the
    // real pointer, never from this.
    const keys = focused ? withFocus(pointer, controlOf(setting)) : pointer
    const rowTarget = { kind: 'control' as const, id: `row:${setting.path}` }
    const pointed = onSetting(pointer.hover, setting.path)
    const band = focused ? skin.selected : pointed ? skin.hovered : null
    const lines: { text: string; hits: Hit[] }[] = []
    const restart = !setting.live && layout.restart ? layout.restart : null

    // Clicking anywhere along a setting's line puts the keyboard on it, laid
    // under its controls so a click still presses what it is on.
    const wholeRow = (built: { text: string; hits: Hit[] }) => ({
      text: built.text,
      hits: [{ row: 0, from: 0, to: form - 1, target: rowTarget }, ...built.hits],
    })
    /**
     * A line of the setting you are on, begun the way the first one is: the
     * marker, then the indent it would have had.
     *
     * A setting is as many lines as it needs — its radios, the sentence under
     * it, the meter beside the microphone — and the band that marks it covers
     * all of them, so the bar down its left has to as well. Marking only the
     * first line left a band that stopped a third of the way down the row it
     * was marking, which reads as a drawing that went wrong rather than as one
     * row picked out. The column is taken whether or not the setting is the
     * one you are on, so nothing moves sideways as the keyboard walks down.
     */
    const beneath = (indent: number, pointerOf: Pointer = keys) =>
      new Row(form, skin, pointerOf).marker(focused).space(indent - 1)
    // A short list of options is radios, and where they would not fit beside
    // the name they go under it, one to a line, rather than off the edge.
    const room = layout.stacked ? layout.control : roomFor(layout, setting)
    const beside = !layout.stacked && fitsInline(setting, room)

    const line = new Row(form, skin, keys)
    line.marker(focused, rowTarget)
    line.text(padTo(setting.title, layout.label), focused || pointed ? skin.you : plain, rowTarget)
    let controlCol = line.used + GAP
    if (beside) {
      line.space(GAP)
      controlCol = line.used
      control(line, setting, panel, ctx, room)
    }
    if (restart) line.right((r) => r.text(restart, skin.hint).space())
    lines.push(wholeRow(line.build()))
    if (!beside) {
      if (spellsOut(setting)) {
        for (const option of optionsOf(setting)) {
          lines.push(
            beneath(3)
              .radio(option.on, cap(option.label, form - 6), {
                kind: 'control',
                id: `set:${setting.path}=${option.value}`,
              })
              .build(),
          )
        }
      } else {
        const stacked = beneath(3)
        controlCol = stacked.used
        control(stacked, setting, panel, ctx, Math.max(4, form - 4))
        lines.push(stacked.build())
      }
    }
    if (setting.path === 'surfaces.voice.mic.device') {
      // Trying it is the only way to know the terminal may use it.
      const indent = layout.stacked ? 3 : 1 + layout.label + GAP
      const meter = beneath(indent, pointer)
      const cells = Math.max(4, Math.min(14, form - indent - 12))
      const heard = ctx.levels.slice(-cells)
      const bars = '▁▂▃▄▅▆▇█'
      meter.text(
        heard.map((level) => bars[Math.max(0, Math.min(7, Math.round(level * 7)))]).join(''),
        skin.busy,
      )
      meter.text('▁'.repeat(Math.max(0, cells - heard.length)), skin.chrome).space(2)
      meter.button(
        panel.testing ? 'Listening…' : 'Test',
        { kind: 'control', id: 'mic-test' },
        panel.testing ? 'off' : 'rest',
      )
      lines.push(meter.build())
    }
    const listOpen = panel.dropdown?.path === setting.path
    if (listOpen) anchor = { line: body.length + lines.length - 1, col: controlCol }
    // The sentence under a setting, for the one you are on, and what the
    // terminal allows for the talk key, which is not something to guess.
    const talkKey = setting.path === 'surfaces.voice.talk.key'
    if (!listOpen && (focused || (talkKey && panel.search === ''))) {
      const note = talkKey
        ? ctx.releases
          ? { mark: '✓', text: 'hold works here', tone: skin.done }
          : { mark: '▲', text: 'no key releases here — talking toggles', tone: skin.waiting }
        : { mark: '', text: setting.means, tone: skin.hint }
      // Said under the control where that leaves it room to be read, and
      // under the name where it does not.
      const aligned = 1 + layout.label + GAP
      const indent = !layout.stacked && form - aligned >= 32 ? aligned : 3
      const room = form - indent - 1 - (note.mark ? 2 : 0)
      wrapTo(note.text, room, 2).forEach((piece, i) => {
        const r = beneath(indent, NO_POINTER)
        if (note.mark) r.text(i === 0 ? note.mark : ' ', note.tone).space()
        lines.push(r.text(piece, skin.hint).build())
      })
    }
    if (focused) {
      focusFrom = body.length
      focusTo = body.length + lines.length - 1
    }
    for (const built of lines)
      body.push(band ? { text: band(built.text), hits: built.hits } : built)
    // A clear line between every setting and the next, the same one every
    // time. Almost every control here is a label or a knob on its own painted
    // ground, so two settings with nothing between them run into one block of
    // colour — the same reason the rows of buttons on the Accounts page are
    // given a gap. Sparing it for the shorter kinds only made the top of a
    // group breathe and the bottom of it crowd, which is what made the page
    // read as unconsidered: a rhythm that changes half way down is one nobody
    // chose. A group longer than the panel scrolls rather than closing up —
    // the form already follows the row you are on, and a list of fifteen key
    // caps with nothing between them is one nobody can read anyway.
    if (at < rows.length - 1) body.push(blank(form))
  })

  // ── the foot of the form ──
  const foot = new Row(form, skin, pointer).space()
  if (panel.error) foot.text(cap(`▲ ${panel.error}`, form - 2), skin.waiting)
  else if (panel.saved) foot.text('● ', skin.done).text(cap(panel.saved, form - 4), skin.hint)
  else foot.text('● ', skin.done).text(cap('Saved as you change it.', form - 4), skin.hint)
  const buttons = new Row(form, skin, pointer).right((r) => {
    if (form >= 32) r.button('Open config.yaml', { kind: 'control', id: 'open-file' }).space()
    r.button('Done', { kind: 'control', id: 'done' }, 'primary').space()
  })

  // Rows beyond the panel used to be drawn and lost. The form follows the row
  // you are on instead, which is what the wheel over it moves.
  const room = Math.max(1, height - 2 - head.length - 2)
  const offset = scrolledTo(body.length, room, focusFrom, focusTo)
  const shown = body.slice(offset, offset + room)
  const main = [...head, ...shown]

  const popups: PanelDrawing['popups'] = []
  if (anchor !== null) {
    const { line, col } = anchor as { line: number; col: number }
    const at = line - offset
    if (at >= 0 && at < room) {
      const listWidth = Math.min(46, Math.max(24, inner - 2))
      const list = settingsDropdown(panel, rows[panel.row] as Setting, ctx, listWidth)
      const under = 1 + head.length + at + 1
      popups.push({
        drawn: list,
        // Under its control where the list fits below it, and over it where
        // it does not: a list that opens off the bottom of the panel is a
        // list with its far end on the window behind.
        row:
          under + list.rows.length <= height - 1
            ? under
            : Math.max(1, under - 1 - list.rows.length),
        col: Math.max(1, Math.min(1 + side + 1 + col, width - listWidth - 1)),
      })
    }
  }

  const rowsOfBody = height - 2
  const lines: { text: string; hits: Hit[] }[] = []
  for (let i = 0; i < rowsOfBody; i++) {
    const left = aside[i] ?? blank(side)
    let right = main[i] ?? blank(form)
    if (i === rowsOfBody - 2) right = foot.build()
    if (i === rowsOfBody - 1) right = buttons.build()
    lines.push({
      text: `${fitTo(left.text, side)}${skin.chrome('│')}${fitTo(right.text, form)}`,
      hits: [
        ...left.hits,
        ...right.hits.map((hit) => ({ ...hit, from: hit.from + side + 1, to: hit.to + side + 1 })),
      ],
    })
  }

  if (panel.capture) {
    const asked = capture(panel, ctx)
    const askedWidth = Math.max(0, ...asked.rows.map((row) => visibleWidth(row)))
    popups.push({
      drawn: asked,
      row: 3,
      col: Math.max(0, Math.floor((width - askedWidth) / 2)),
    })
  }
  // The file it writes, in the border, while the border has room for it: a
  // corner longer than the box it is drawn in is a box that is not its width.
  const said = `${ctx.configPath} · esc`
  const corner = visibleWidth(said) + visibleWidth(' Settings ') + 6 <= width ? said : 'esc'
  return {
    panel: box('Settings', lines, width, skin, { corner }),
    popups,
  }
}
