import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { duration, type PlanWindow, planLabel, resetsIn, tightestPlan } from '@tade/core'
import type { Frame } from '../frame.ts'
import { type Hit, pointingIn, rowHit, sameTarget, shift, type Target } from '../hits.ts'
import { type AppState, ORCHESTRATOR_TAB, terminalsOf } from '../model.ts'
import { BAR } from '../scrollbar.ts'
import type { Skin } from '../skin.ts'
import { type Drawn, fit, type Pointer, Row, stack } from '../ui.ts'
import { blockAt, scrolledBar, typingIn } from './lane.ts'
import { barBeside, STRIP_ICONS } from './rows.ts'
import { dollars, shortModel, tokens } from './text.ts'

// Along the bottom: the orchestrator and the terminals on tabs, the few
// buttons that are not about an agent, and what the whole thing has cost.
//
// Always there and not closeable — it is how you know what Tade heard.

/**
 * The footer's buttons: the few things that are not about an agent. Starting
 * one and opening a project have their own `+` where agents and projects are,
 * and search has ctrl+k beside the talk key.
 *
 * A button's colour here is what pressing it does. Two of them open a page
 * and do nothing else, so they are the window's own grey and look alike,
 * because they are alike. The third turns the sound off or back on, which is
 * a thing done to the window rather than a page to look at, so it is the
 * stop-and-go pair `danger` and `go` — and what it has to say beyond that, it
 * says in its label.
 */
export const BUTTONS: readonly { label: string; action: string }[] = [
  { label: 'Extensions', action: 'extensions' },
  { label: 'Settings', action: 'settings' },
  { label: 'Mute', action: 'mute' },
]

/**
 * Columns a plan window's bar takes. The context meter's own width, because it
 * is the same kind of figure drawn the same way — how much of something is
 * gone — and two meters of different widths in one window read as two
 * different kinds of thing.
 */
const PLAN_CELLS = 6

/** How full a window is, 0 to 1. A service reporting past its own 100 draws full, never over. */
const share = (window: PlanWindow) => Math.min(1, Math.max(0, window.used) / 100)

/**
 * The bottom panel's row of tabs, drawn on its top edge: the orchestrator,
 * each terminal of the project you are in, `+` for another, and on the right
 * find, fill the window and fold away. The rule around them is the handle
 * that resizes the panel.
 */
export function bottomTabs(
  state: AppState,
  width: number,
  skin: Skin,
  pointer: Pointer,
): { text: string; hits: Hit[] } {
  const edge: Target = { kind: 'divider', edge: 'bottom' }
  const lit = state.resizing === 'bottom' || sameTarget(state.hover, edge)
  const rule = lit ? skin.signal : skin.chrome
  const line = '━'
  const row = new Row(width, skin, pointer).text(`${line} `, rule)
  const orchestrator: Target = { kind: 'bottom-tab', tab: ORCHESTRATOR_TAB }
  row.tab('orchestrator', orchestrator, state.bottom === ORCHESTRATOR_TAB)
  for (const terminal of terminalsOf(state)) {
    const on = terminal.id === state.bottom
    const target: Target = { kind: 'bottom-tab', tab: terminal.id }
    const menu: Target = { kind: 'menu', subject: { kind: 'terminal', id: terminal.id } }
    const close: Target = { kind: 'action', name: `close-terminal:${terminal.id}` }
    // A tab and the two buttons beside it are one thing to point at: they are
    // drawn while the pointer is anywhere in it, and the tab stays lit while
    // it is on them, so reaching for a close is never leaving the tab.
    //
    // Their room is kept whether they are drawn or not. These tabs sit in a
    // row you sweep along, so room taken on hover would slide every tab after
    // it out from under the pointer that summoned it — and this row has the
    // room to spare, since what is to the right of the tabs is the rule.
    const pointed = pointingIn(state.hover, [target, menu, close])
    row.space().tab(terminal.name, target, on, pointed)
    if (pointed) row.icon('×', close, 'danger').icon('≡', menu)
    else row.space(STRIP_ICONS)
  }
  row.space().button('+', { kind: 'action', name: 'new-terminal' }, 'add').space()

  const controls = (r: Row) => {
    if (state.terminals.some((one) => one.id === state.bottom)) {
      r.button('⌕', { kind: 'action', name: 'find-terminal' }).space()
    }
    r.button(state.bottomMode === 'max' ? '⤡' : '⤢', { kind: 'action', name: 'bottom-max' }).space()
    r.button(state.bottomMode === 'min' ? '▴' : '▾', { kind: 'action', name: 'bottom-min' })
    r.text(` ${line}`, rule)
  }
  const probe = new Row(width, skin)
  controls(probe)
  // One short of meeting them: a right-hand group needs a column of room to sit in.
  const fill = width - row.used - probe.used - 1
  if (fill > 0) row.text(line.repeat(fill), rule)
  row.right(controls)
  const built = row.build()
  // Under everything: the rule itself, which is what a drag takes hold of.
  return { text: built.text, hits: [rowHit(0, width, edge), ...built.hits] }
}

/**
 * A terminal's screen, tailing like an agent's. While finding in it, its
 * scrollback instead, with the line found in view and what matched lit.
 */
export function terminalBody(opts: {
  terminal: Frame['terminal']
  width: number
  room: number
  skin: Skin
  scroll?: number
  pointer?: Pointer
  /** The half beside the one in front, which has neither bar nor cursor of its own. */
  side?: 'split'
  /**
   * The window, for the terminal in front: what its bar is lit by, and whether
   * what you type goes here. Left out for a split's second half.
   */
  state?: AppState
}): Drawn {
  const { terminal, room, skin, side } = opts
  const scroll = opts.scroll ?? 0
  const pointer = opts.pointer ?? { hover: null, pressed: null }
  const find = terminal?.find
  // The bar down its right, and the column it takes: only the terminal in
  // front, whose lane the window sized to leave room for it. Never while
  // finding, where what is shown is the scrollback being searched and a bar
  // drawn from the live screen would point at the wrong part of it.
  const view = opts.state && !side && !find ? (terminal?.view ?? null) : null
  const width = view ? opts.width - BAR : opts.width
  const rows: string[] = []
  const hits: Hit[] = []
  if (find) {
    const at = find.line ?? find.lines.length - 1
    const start = Math.max(0, Math.min(at - Math.floor(room / 2), find.lines.length - room))
    const want = find.query.toLowerCase()
    find.lines.slice(start, start + room).forEach((line, offset) => {
      const here = start + offset === find.line
      const cut = fit(line, width)
      const plain = stripTerminalSequences(cut)
      const found = want ? plain.toLowerCase().indexOf(want) : -1
      const text =
        found >= 0
          ? plain.slice(0, found) +
            (here ? skin.transmit : skin.waiting)(plain.slice(found, found + want.length)) +
            plain.slice(found + want.length)
          : plain
      rows.push(here ? skin.selected(text) : text)
    })
  } else if (scroll > 0) {
    const lines = (terminal?.screen ?? '').split('\n').slice(-(room - 1))
    for (const line of lines) rows.push(fit(line, width))
    while (rows.length < room - 1) rows.push(' '.repeat(width))
    const bar = scrolledBar(scroll, 'terminal-end', width, skin, pointer)
    hits.push(...shift(bar.hits, rows.length))
    rows.push(bar.text)
  } else {
    const lines = (terminal?.screen ?? '').split('\n')
    for (const line of lines.slice(-room)) rows.push(fit(line, width))
    // The block where what you type lands, where this is where it goes.
    if (view && opts.state && typingIn(opts.state) === 'terminal') {
      const paint = rows.map((text) => ({ text, hits: [] }))
      blockAt(
        paint,
        Math.min(lines.length, room) - 1 - view.cursor.back,
        view.cursor.column,
        width,
        skin,
      )
      rows.splice(0, rows.length, ...paint.map((row) => row.text))
    }
  }
  while (rows.length < room) rows.push(' '.repeat(width))
  const own = hits.splice(0)
  for (let i = 0; i < rows.length; i++) {
    if (!side) hits.push(rowHit(i, opts.width, { kind: 'scroll', area: 'terminal' }))
    hits.push(rowHit(i, opts.width, side ? { kind: 'terminal', side } : { kind: 'terminal' }))
  }
  hits.push(...own)
  if (!view || !opts.state) return { rows, hits }
  // The bar last, over the click map: dragging it is not clicking into the
  // terminal, and a press that did both would scroll and steal the keyboard.
  const seen = rows.length
  const drawn = barBeside(
    rows.map((text, i) => ({
      text,
      hits: hits.filter((hit) => hit.row === i).map((hit) => ({ ...hit, row: 0 })),
    })),
    {
      total: Math.max(view.lines, seen),
      shown: seen,
      offset: Math.max(0, view.lines - seen - scroll),
      rows: seen,
    },
    'terminal',
    width,
    opts.state,
    skin,
  )
  return stack(drawn)
}

export function renderFoot(
  state: AppState,
  frame: Frame,
  width: number,
  skin: Skin,
  pointer: Pointer,
): Drawn {
  const row = new Row(width, skin, pointer).space()
  for (const button of BUTTONS) {
    const press: Target = { kind: 'action', name: button.action }
    // The sound button is the one here that carries state, and what it wears
    // is what the press will do: red to cut the sound off, green to bring it
    // back. That way round because the label is a verb and the colour is the
    // same sentence — a red button stops something, a green one starts it —
    // and because the loud one is then on screen only while there is sound to
    // lose, with the green appearing exactly when you are muted and looking
    // for the way out. Black letters on both: the grounds are bright, and
    // which ink a ground takes is `inkOn`'s to decide, not this loop's.
    const sound = button.action === 'mute'
    const muted = sound && frame.muted === true
    row.button(muted ? 'Unmute' : button.label, press, sound ? (muted ? 'go' : 'danger') : 'rest')
    // Extensions is a page like Settings and is drawn as one — the same grey,
    // the same ink, the same weight. How many of them need setting up or are
    // broken is a count, and a count is said the way every other count in the
    // window is said: a badge beside the thing it is about, in the button's
    // own target so the two are one control to click.
    const needed = button.action === 'extensions' ? (frame.extensionsNeedYou ?? 0) : 0
    if (needed > 0) row.text(` ${needed} `, skin.badge, press)
    row.space()
  }
  const spend = frame.spend
  const target: Target = { kind: 'action', name: 'spend' }
  // The orchestrator's model, how hard it thinks, and the account paying for
  // it: an agent's own are on its pane, so these are only ever the one you
  // talk to.
  const switcher: Target = { kind: 'action', name: 'model:orchestrator' }
  const thinker = frame.orchestratorModel
  const level: Target = { kind: 'action', name: 'thinking:orchestrator' }
  const thinking = frame.orchestratorThinking
  const account = frame.orchestratorAccount
  const spent = spend && (spend.tokens > 0 || spend.hasCost)
  // How long the agents have been at it today, beside what they charged for
  // it: the two halves of the same question.
  const ran = spend?.runtime && spend.runtime.ms > 0 ? spend.runtime : null
  // What a subscription has left, which is the only figure that means anything
  // when nothing is priced. One account — the one with the fullest window
  // anywhere, which is the one about to stop somebody working — and every
  // window it named. Nothing at all when no harness has said: the reason is on
  // the Spend page, and a strip is no place for a sentence.
  const plan = tightestPlan(frame.plan ?? [])
  // Everything here is clickable, and says so under the pointer the way a
  // link does: lit and underlined, rather than a block of background that
  // would read as a button in a strip that has none.
  const lit = (of: Target, tone: (text: string) => string) =>
    sameTarget(state.hover, of) ? skin.link : tone
  // Said in full where there is room, and shed from the left where there is
  // not: what it costs is the part worth keeping on a small terminal, and how
  // long it took is the next to last to go.
  //
  // What a plan has left is the last figure of all, because where a
  // subscription pays for the work it is the only one that says anything: the
  // dollars beside it are an estimate of something nobody is charged. But its
  // trimmings go early, before the controls beside them: when each window
  // comes back, and then the window that is not the tightest. Both are said
  // again on the page this opens, where the model and how hard it thinks are
  // not said anywhere else — and a control you can no longer click costs more
  // than a figure that is one click away. What is left of it gives up its bars
  // last of all: a percent with no bar is still the figure.
  const full = {
    model: true,
    account: true,
    thinking: true,
    tokens: true,
    runtime: true,
    plan: true,
    both: true,
    bars: true,
    reset: true,
  }
  const shed: Array<keyof typeof full> = [
    'account',
    'tokens',
    'reset',
    'both',
    'thinking',
    'model',
    'runtime',
    'bars',
    'plan',
  ]
  // Each try is the one before it with one more thing given up, so the order
  // above is the whole of what gets shed and in what order.
  const tries: Array<typeof full> = [full]
  for (const what of shed) tries.push({ ...(tries[tries.length - 1] ?? full), [what]: false })
  const status = (show: (typeof tries)[number]) => (r: Row) => {
    // What extensions keep here — what Tade is using — clicked for their view.
    if (show.model) {
      for (const one of frame.statuses ?? []) {
        const view: Target = { kind: 'action', name: `extension-view:${one.extension}` }
        const tone =
          one.tone === 'bad' ? skin.bad : one.tone === 'warning' ? skin.waiting : skin.hint
        r.text(one.text, lit(view, tone), one.viewable ? view : undefined)
        r.text(' │ ', skin.chrome)
      }
    }
    if (show.model && thinker !== undefined) {
      const look = lit(switcher, skin.hint)
      r.text(`${thinker ? shortModel(thinker) : 'no model'} ▾`, look, switcher)
      if (show.account && account?.provider) r.text(` · ${account.provider}`, look, switcher)
      if (show.account && account?.credential) r.text(` · ${account.credential}`, look, switcher)
      r.text(' │ ', skin.chrome)
      // How hard it thinks, changed like an agent's: a dropdown of the same
      // levels, beside the model it applies to.
      if (show.thinking) {
        r.text(`${thinking ?? 'thinking'} ▾`, lit(level, skin.hint), level)
        r.text(' │ ', skin.chrome)
      }
    }
    // What today cost, in one clickable group: the whole of it lights, because
    // the whole of it opens the same overview.
    const money = lit(target, skin.hint)
    // A share of a plan, never added to the money beside it: the two are
    // different currencies and there is no rate between them. It opens the
    // same overview, where the windows are listed account by account.
    if (plan && show.plan) {
      // Whose plan, only where more than one account has one to speak of: with
      // a single sign-in the name is noise, and with two the figure is a
      // riddle without it.
      const whose = (frame.plan ?? []).filter((one) => one.windows.length > 0).length > 1
      if (whose) r.text(`${planLabel(plan)} `, money, target)
      // A bar each, the way the context meter says how much of a window is
      // gone: the session first and the longer one after it, in the order the
      // harness named them. Short of room it is the fullest alone — the one
      // about to stop somebody working.
      const windows = show.both ? plan.windows : [plan.tightest]
      windows.forEach((window, at) => {
        if (at > 0) r.text(' · ', skin.chrome, target)
        const used = Math.round(window.used)
        // The Spend page's own thresholds and the Spend page's own colours:
        // this is the same figure drawn smaller, and two rules for when a
        // plan is worrying would disagree the day one of them moved.
        const tone = used >= 90 ? skin.bad : used >= 75 ? skin.waiting : skin.done
        r.text(`${window.label} `, money, target)
        if (show.bars) r.meter(share(window), PLAN_CELLS, lit(target, tone), target).space()
        r.text(`${used}%`, lit(target, tone), target)
        // Without a clock there is no "in two hours" to say, only the share.
        const left = frame.now === undefined ? null : resetsIn(window, frame.now)
        if (left !== null && show.reset) r.text(` ↻ ${duration(left)}`, money, target)
      })
      r.text(' │ ', skin.chrome, target)
    }
    if (spent && show.tokens) {
      r.text(tokens(spend.tokens), money, target).text(' │ ', skin.chrome, target)
    }
    // An agent still working is time still counting, so it is said in the
    // colour of something happening rather than the colour of a record.
    if (ran && show.runtime) {
      r.text(duration(ran.ms), lit(target, ran.running ? skin.busy : skin.hint), target).text(
        ' │ ',
        skin.chrome,
        target,
      )
    }
    if (spent && spend.hasCost) r.text(dollars(spend.usd), lit(target, skin.you), target).space()
    r.text(spent ? 'today ▾' : 'nothing spent today ▾', money, target).space()
  }
  const fits = tries.find((show) => {
    const probe = new Row(width, skin)
    status(show)(probe)
    return row.used + 1 + probe.used <= width
  })
  row.right(status(fits ?? tries[tries.length - 1] ?? full))
  return stack([{ text: skin.chrome('─'.repeat(width)), hits: [] }, row.build()])
}
