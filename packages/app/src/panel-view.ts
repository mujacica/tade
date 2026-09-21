import { visibleWidth } from '@earendil-works/pi-tui'
import { HARNESS_CHOICES, masked, type Setting, shownValue } from '@tade/core'
import { type Hit, sameTarget, type Target } from './hits.ts'
import { checkTalkKey, keyCaps, TALK_SUGGESTIONS } from './keys.ts'
import { cap, fitTo, padTo, sideWidth, withFocus, wrapTo } from './panels/cells.ts'
import type { PanelContext, PanelDrawing } from './panels/context.ts'
import {
  ACCOUNTS,
  accountActions,
  choicesFor,
  matchingChoices,
  type SettingsPanel,
  UPDATES,
  updateActions,
  usesDropdown,
  visibleSettings,
} from './panels.ts'
import type { Look } from './skin.ts'
import { blank, box, type Drawn, keysWidth, NO_POINTER, type Pointer, Row } from './ui.ts'

// How each panel looks. The model of what a panel holds and what a key does to
// it is in `panels.ts`; this only draws it, and names each control so a click
// can find its way back there.
//
// What it is handed and which drawing answers which panel are in
// `panels/context.ts`; the cells they are all built out of are in
// `panels/cells.ts`. This file is what is left while the panels move into
// `panels/<name>/` one at a time, and goes when the last of them has.

// ── Settings ────────────────────────────────────────────────────────────────

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

  // ── the head of the form: what this group is, and what it is about ──
  const group = ctx.settings.find((g) => g.id === panel.category)
  const title = panel.search
    ? `Matching “${panel.search}”`
    : panel.category === ACCOUNTS
      ? 'Accounts'
      : panel.category === UPDATES
        ? 'Updates'
        : (group?.title ?? '')
  const about = panel.search
    ? 'Every setting whose name or meaning has those words.'
    : panel.category === ACCOUNTS
      ? "Who each harness's agents run as. Signing in is each harness's own, inside this window: what you give it goes where it keeps it, never through Tade. ▸ marks the account new agents use; an agent's own menu moves it to another."
      : panel.category === UPDATES
        ? 'The programs Tade runs, and Tade itself: what is here, how it got here — which is what decides how it moves forward — and what is current. Asking what is current is the one thing here that reaches the network, and it happens when you press it. Nothing installs anything: the exact command is here to read, and running it opens a terminal you can watch.'
        : (group?.about ?? '')
  const head: { text: string; hits: Hit[] }[] = [
    new Row(form, skin)
      .space()
      .text(cap(title, form - 2), skin.brand)
      .build(),
  ]
  // What the group is about, kept inside the panel: broken over lines rather
  // than cut off mid-word at whatever width the window happens to be.
  for (const line of wrapTo(about, form - 2, height >= 22 ? 3 : 2))
    head.push(new Row(form, skin).space().text(line, skin.hint).build())
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
          .text(cap('Asking each harness who it is signed in as…', form - 2), skin.hint)
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
          ? { mark: '✓', text: 'Hold works here: this terminal reports releases.', tone: skin.done }
          : {
              mark: '▲',
              text: "This terminal can't report releases, so talking toggles.",
              tone: skin.waiting,
            }
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

/**
 * The Updates page: the programs Tade runs, and Tade itself.
 *
 * Which programs those are is read off what every driver, harness and forge
 * declares, so nothing here knows there is such a thing as tmux. Each says
 * what is here, how it got here — because that is what decides how it moves
 * forward — and what is current, once somebody has pressed the one button
 * that touches the network. A version nobody could read is drawn as a version
 * nobody could read.
 */
function drawUpdates(
  panel: SettingsPanel,
  ctx: PanelContext,
  form: number,
  body: { text: string; hits: Hit[] }[],
  keepInView: (from: number, to: number) => void,
): void {
  const { skin } = ctx
  const look = ctx.updates ?? null
  const actions = updateActions(look, ctx.updatesBusy === true)
  const focused = panel.focus === 'form' ? (actions[panel.row]?.id ?? null) : null
  const keys = withFocus(ctx.pointer, focused)
  const plain = (text: string) => text

  const say = (text: string, tone = skin.hint, indent = 3, lines = 3) => {
    for (const line of wrapTo(text, Math.max(8, form - indent - 1), lines)) {
      body.push(new Row(form, skin).space(indent).text(line, tone).build())
    }
  }
  const heading = (text: string) =>
    body.push(
      new Row(form, skin)
        .space()
        .text(cap(text, form - 2), skin.brand)
        .build(),
    )
  /** A row of buttons, with the focused one's line remembered so it stays in view. */
  const putButtons = (ids: readonly string[], look_: Look = 'rest', indent = 3) => {
    const mine = actions.filter((action) => ids.includes(action.id))
    if (mine.length === 0) return
    const row = new Row(form, skin, keys).space(indent)
    for (const action of mine) {
      row.button(action.label, { kind: 'control', id: action.id }, look_).space()
    }
    if (focused !== null && mine.some((action) => action.id === focused)) {
      keepInView(body.length, body.length)
    }
    body.push(row.build())
  }
  /**
   * The exact command, drawn where a person reads it before anything runs it —
   * and where there is none, what is in the way of there being one.
   */
  const command = (update: { command: string } | { cannot: string }, indent = 3) =>
    'command' in update
      ? say(update.command, skin.busy, indent, 2)
      : say(`No command: ${update.cannot}.`, skin.hint, indent, 3)

  putButtons(['updates:check'], 'primary')
  say(
    look === null
      ? 'Reading what is installed on this machine…'
      : look.asked
        ? 'Checked just now. Nothing was asked of anybody until you pressed it.'
        : 'Nothing has been asked of the network yet — this is what is installed here.',
  )
  body.push(blank(form))
  if (look === null) return

  // ── Tade itself ──
  heading('Tade')
  const tade = look.tade
  const said = [
    tade.version,
    tade.branch,
    tade.commit,
    tade.from === 'checkout'
      ? `a git checkout at ${tade.where}`
      : (tade.install?.said ?? tade.where),
  ].filter(Boolean)
  say(said.join(' · '), plain)
  // Before anything has been asked, the page has already said so once at the
  // top; saying it again under every line is noise that reads as a problem.
  if (tade.newer) say(`● ${tade.newer}`, skin.waiting)
  else if (!look.asked) say('')
  else if (tade.cannotTell) say(`· ${tade.cannotTell}`, skin.hint)
  else say('✓ This is the newest there is.', skin.done)
  command(tade.update)
  putButtons(['updates:update:tade', 'updates:reload'], 'attention')
  // What reloading costs is the driver's answer, never the driver's name:
  // where lanes outlive the window, restarting it stops nothing.
  const kept = 'Worktrees, branches, the journal, queued work and schedules all survive.'
  say(
    ctx.lanesSurvive
      ? `Reloading restarts the window; agents run outside it and go on working. ${kept}`
      : ctx.running > 0
        ? `Reloading restarts the window, and the ${ctx.running} agent${ctx.running === 1 ? '' : 's'} running inside it stop with it — their conversations are kept, and they open again where they stopped. ${kept}`
        : `Reloading restarts the window. Agents run inside it here, so any at work would stop; there are none. ${kept}`,
    skin.hint,
    3,
    4,
  )
  body.push(blank(form))

  // ── the programs it runs ──
  heading('Programs it runs')
  const named = Math.min(16, Math.max(6, form - 40))
  for (const program of look.programs) {
    const from = body.length
    // The row the keyboard stops on for this program: its button where it
    // has one, and the row itself where it has not.
    const rowId = actions.find((action) => action.about === program.need.command)?.id ?? ''
    const version = program.version ?? (program.install ? 'no version' : '—')
    const mark = !program.install
      ? {
          text: program.need.optional ? '○ not installed, and optional' : '▲ not installed',
          tone: program.need.optional ? skin.hint : skin.waiting,
        }
      : !look.asked
        ? { text: '', tone: skin.hint }
        : program.behind && program.latest
          ? { text: `● ${program.latest} is out`, tone: skin.waiting }
          : program.latest
            ? { text: '✓ current', tone: skin.done }
            : { text: '· cannot tell', tone: skin.hint }
    const target = { kind: 'control' as const, id: rowId }
    // The row the keyboard is on is marked down its left, the same bar every
    // other marked row in the window gets — and the column is taken whether or
    // not it is marked, so nothing shifts as the keyboard walks down the page.
    const name = new Row(form, skin, keys)
      .marker(focused === rowId)
      .space(2)
      .text(padTo(cap(program.need.title, named), named), plain, target)
      .text(padTo(cap(version, 12), 12), program.install ? plain : skin.hint)
      .text(cap(mark.text, Math.max(0, form - named - 17)), mark.tone)
      .build()
    body.push(focused === rowId ? { text: skin.selected(name.text), hits: name.hits } : name)
    // Everything about one program sits under its name: how it got here,
    // which is what decides how it moves forward, then what needs it, then
    // the exact command and the button that runs it.
    const under = 3 + named
    if (program.install) {
      body.push(
        new Row(form, skin)
          .space(under)
          .text(
            cap(
              `${program.install.said} · ${program.install.where}`,
              Math.max(8, form - under - 1),
            ),
            skin.hint,
          )
          .build(),
      )
    }
    say(
      program.need.needed.map((one) => `${one.what}: ${one.why}`).join(' · '),
      skin.hint,
      under,
      2,
    )
    if (!program.need.inUse) say('Nothing Tade is set up to use needs it.', skin.hint, under, 1)
    if (look.asked && program.cannotTell && program.install) {
      say(program.cannotTell, skin.hint, under, 2)
    }
    // The exact command is always on the page, whether or not anything has
    // been asked: what a button would run is read before it is pressed.
    command(program.update, under)
    putButtons([`updates:update:${program.need.command}`], 'rest', under)
    body.push(blank(form))
    // Everything about one program is kept in view together, so walking down
    // the page scrolls past the whole of each rather than its first line.
    if (focused === rowId) keepInView(from, body.length - 1)
  }
}

/** A choice shown as radios rather than a list. */
function spellsOut(setting: Setting): boolean {
  return setting.type.kind === 'choice' && !usesDropdown(setting)
}

function optionsOf(setting: Setting): { value: string; label: string; on: boolean }[] {
  if (setting.type.kind !== 'choice') return []
  const value = setting.value || setting.fallback
  return setting.type.options.map((option) => ({
    value: option,
    label: CHOICE_LABELS[setting.path]?.[option] ?? option,
    on: value === option,
  }))
}

/** Whether a setting's control fits on the line beside its name. */
function fitsInline(setting: Setting, room: number): boolean {
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
function control(
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
      const width = Math.max(8, Math.min(40, room))
      // A credential is bullets as it is typed and a sentence about where it
      // is when it is not: a key on a screen is a key in a recording.
      if (panel.editing?.path === setting.path) {
        const typed = setting.secret ? masked(panel.editing.text) : panel.editing.text
        row.field(typed, width, { caret: true, target })
      } else {
        const shown = setting.secret ? shownValue(setting) : value
        row.field(shown || setting.fallback, width, { hint: !shown, target })
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

/** The control the keyboard would operate, so it looks the part. */
function controlOf(setting: Setting): string | null {
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
function badgeFor(id: string, ctx: PanelContext): ((row: Row) => void) | null {
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
function settingsDropdown(
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
function capture(panel: SettingsPanel, ctx: PanelContext): Drawn {
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
  for (const line of wrapTo(
    'Never a key that types a character — you have to be able to type a space into your agent.',
    inner - 2,
    2,
  ))
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
