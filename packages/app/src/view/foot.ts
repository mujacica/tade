import { stripTerminalSequences } from '@earendil-works/pi-tui'
import {
  duration,
  nextPlan,
  type PlanWindow,
  planLabel,
  planPressure,
  planShown,
  resetsIn,
} from '@tade/core'
import type { Frame } from '../frame.ts'
import { type Hit, pointingIn, rowHit, sameTarget, shift, type Target } from '../hits.ts'
import { linkedRow } from '../links.ts'
import { type AppState, activeTerminal, ORCHESTRATOR_TAB, terminalsOf } from '../model.ts'
import type { HeldLines } from '../scroll.ts'
import { BAR } from '../scrollbar.ts'
import type { Regions } from '../selection.ts'
import type { Look, Skin } from '../skin.ts'
import { type Drawn, fit, type Pointer, Row, stack } from '../ui.ts'
import { blockAt, laneRegion, pointedIn, screenRows, scrolledBar, typingIn } from './lane.ts'
import { gutterBeside } from './rows.ts'
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
 * Two of them open a page and do nothing else, so they are the window's own
 * grey and look alike, because they are alike. The other two are things done
 * to the window's own world rather than pages to look at — the sound, and the
 * anti-sleep hold beside it — and both carry state, so what each says and
 * wears is `labelled` below, which carries the reasons.
 */
export const BUTTONS: readonly { label: string; action: string }[] = [
  { label: 'Extensions', action: 'extensions' },
  { label: 'Settings', action: 'settings' },
  { label: 'Mute', action: 'mute' },
  { label: 'Keep awake', action: 'awake' },
]

/**
 * What one of them says and wears, given what is true now.
 *
 * **Sound.** Red to cut it off, green to bring it back. That way round
 * because the label is a verb and the colour is the same sentence — a red
 * button stops something, a green one starts it — and because the loud one is
 * then on screen only while there is sound to lose, with the green appearing
 * exactly when you are muted and looking for the way out.
 *
 * **The hold.** Red while it is held, for the same reason and the same pair:
 * pressing it lets the machine sleep again, and the loud one is on screen
 * exactly while sleep is being held off, which is the state worth seeing from
 * across the room. What it is *not* is green while it is off, which is the
 * one place this departs from the sound beside it. `go` is the press the
 * window would like next, and an anti-sleep hold is deliberately not one Tade
 * asks anybody for — it is a choice somebody makes about their own machine.
 * So off it is the window's own grey, like the two pages: an ordinary control,
 * wanted by nobody until it is.
 *
 * **Where it cannot be held**, the label says so rather than the grey
 * pretending: a button that cannot do what it says is worse than one that is
 * not there, and pressing it answers with what is missing and what happens
 * instead. Still grey and still lit under the pointer, because it is still
 * something to press and the strip's rule is that everything in it says so.
 *
 * Black letters on every ground: the grounds are bright, and which ink a
 * ground takes is `inkOn`'s to decide.
 */
export function labelled(
  button: { label: string; action: string },
  frame: Pick<Frame, 'muted' | 'awake'>,
): { label: string; look: Look } {
  if (button.action === 'mute') {
    return frame.muted === true
      ? { label: 'Unmute', look: 'go' }
      : { label: 'Mute', look: 'danger' }
  }
  if (button.action === 'awake') {
    if (frame.awake?.problem != null) return { label: 'No caffeinate', look: 'rest' }
    return frame.awake?.held === true
      ? { label: 'Let it sleep', look: 'danger' }
      : { label: 'Keep awake', look: 'rest' }
  }
  return { label: button.label, look: 'rest' }
}

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
    // A tab and the two buttons beside it are one thing to point at: the tab
    // stays lit while the pointer is on them, so reaching for a close is never
    // leaving the tab, and each of them lights under the pointer on its own.
    //
    // They are always drawn, because they cost nothing to leave there and a
    // button that appears on arrival costs the two things a button is for.
    // It cannot be seen before it is needed, so the only way to learn a
    // terminal closes from its tab is to have already pointed at the tab; and
    // it cannot be reached except through the tab, since the columns it will
    // occupy are nobody's until it is drawn in them — the pointer crossing the
    // row from the right passes over its close without ever finding it. The
    // room was kept for them either way, so nothing is paid for keeping them:
    // these tabs sit in a row you sweep along, and columns taken on hover
    // would slide every tab after them out from under the pointer.
    row.space().tab(terminal.name, target, on, pointingIn(state.hover, [target, menu, close]))
    row.icon('×', close, 'danger').icon('≡', menu)
  }
  row.space().button('+', { kind: 'action', name: 'new-terminal' }, 'add').space()

  const controls = (r: Row) => {
    if (activeTerminal(state)) {
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
  /**
   * What to read the terminal's text for, or `null` to read it for nothing at
   * all — which is what a lane that answers the pointer itself gets, exactly as
   * an agent's pane hands its cells over: a path that lights up under the
   * pointer and then hands the click to the program is a worse lie than not
   * offering it.
   */
  linkers?: Frame['linkers'] | null
  /** The lines the window holds of this lane, which is what a selection reaches into. */
  held?: HeldLines
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
  // The lane's own lines behind what is drawn, filled in below by whichever
  // branch draws them: a selection over a terminal is anchored in those, so
  // scrolling carries it rather than losing it.
  let regions: Regions = {}
  // A line of the terminal's own output, with the links and the file
  // references in it made clickable — unless the lane answers the pointer
  // itself, and then Tade's reading of its text steps aside.
  const linked = (line: string) => {
    if (opts.linkers === null) {
      rows.push(fit(line, width))
      return
    }
    const row = linkedRow(line, width, skin, pointer, opts.linkers ?? [])
    hits.push(...shift(row.hits, rows.length))
    rows.push(row.text)
  }
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
    const screen = (terminal?.screen ?? '').split('\n')
    // Counted forward, not as `slice(-(room - 1))`: a panel with one row in it
    // would ask for the last none of them and be given all of them.
    const lines = screen.slice(Math.max(0, screen.length - Math.max(0, room - 1)))
    for (const line of lines) linked(line)
    regions = anchored(opts, screen, lines, screen.length - lines.length)
    while (rows.length < room - 1) rows.push(' '.repeat(width))
    const bar = scrolledBar(scroll, 'terminal-end', width, skin, pointer)
    hits.push(...shift(bar.hits, rows.length))
    rows.push(bar.text)
  } else {
    const lines = (terminal?.screen ?? '').split('\n')
    const seen = lines.slice(-room)
    for (const line of seen) linked(line)
    regions = anchored(opts, lines, seen, lines.length - seen.length)
    // A shell with a program in it that answers the pointer itself: the cells
    // it drew are its own, exactly as an agent's pane hands its over. Read
    // from the same `typingIn` the cursor block below reads, so the two can
    // never disagree about which lane is in front.
    // Which lane this is, read the way the look reads it: the terminal in
    // front. A split's second half never gets here — it is handed no state,
    // and so no bar and no pointer either.
    const id = opts.state ? activeTerminal(opts.state)?.id : null
    if (view && id && pointedIn(view, !!opts.state && typingIn(opts.state) === 'terminal')) {
      const screen = screenRows(view.lines, room)
      const target: Target = {
        kind: 'screen',
        lane: id,
        from: screen.from,
        drags: view.pointing === 'drag',
      }
      // The first of the region's rows, because a terminal's screen is drawn
      // from the top of it down. Pushed before the region's own hits are
      // taken aside, which is what puts them back last and so on top.
      for (let i = 0; i < screen.rows; i++) hits.push(rowHit(i, width, target))
    }
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
  if (!view || !opts.state) return { rows, hits, regions }
  // The bar last, over the click map: dragging it is not clicking into the
  // terminal, and a press that did both would scroll and steal the keyboard.
  const seen = rows.length
  const drawn = gutterBeside(
    rows.map((text, i) => ({
      text,
      hits: hits.filter((hit) => hit.row === i).map((hit) => ({ ...hit, row: 0 })),
    })),
    // A shell with an editor open in it is an agent drawing its own
    // conversation: the lane says whose the scrolling is, and this column
    // says the same thing the pane's does about it.
    view.scrolling ?? 'window',
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
  return { ...stack(drawn), regions }
}

/**
 * The terminal's screen as a region a selection can be anchored in, or nothing
 * where it is not one: a split's half, which the window neither scrolls nor
 * holds lines for, and a lane whose capture did not come out of what is held.
 */
function anchored(
  opts: Parameters<typeof terminalBody>[0],
  screen: readonly string[],
  drawn: readonly string[],
  dropped: number,
): Regions {
  if (!opts.state || opts.side) return {}
  const region = laneRegion({
    held: opts.terminal ? opts.held : undefined,
    screen: screen.length,
    dropped,
    shown: drawn.length,
    top: drawn[0] ?? '',
    // A terminal's screen is drawn from the top of its region down.
    row: 0,
    back: opts.scroll ?? 0,
    // How deep the lane is now, as the look reads it: what the driver last
    // said, or — before it has said anything — how deep it was when these
    // lines were read.
    at: opts.terminal?.view?.lines ?? opts.held?.at ?? 0,
  })
  return region ? { terminal: region } : {}
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
    // What each one says and wears is `labelled`'s, which carries the reasons.
    const { label, look } = labelled(button, frame)
    row.button(label, press, look)
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
  // when nothing is priced. One account — the one somebody moved to, or the one
  // with the fullest window anywhere, which is the one about to stop somebody
  // working — and every window it named. Nothing at all when no harness has
  // said: the reason is on the Spend page, and a strip is no place for a
  // sentence.
  const plan = planShown(frame.plan ?? [], state.planShown)
  // What today's plan turns would have cost at list price. Its own slot only
  // where there is a bill in the slot that never sheds: with no money at all
  // this *is* that slot's figure (`costToday`), and saying it twice on one row
  // is a row that looks like it is adding up to something.
  const listed = spend?.hasCost ? atList(spend) : null
  // Where pressing the name goes next, and null where there is nowhere: with
  // one sign-in reporting anything there is nothing to move between, so the
  // name and the control are both left off rather than drawn doing nothing.
  const along = nextPlan(frame.plan ?? [], state.planShown)
  const flip: Target = { kind: 'action', name: 'plan-next' }
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
    listed: true,
  }
  // `listed` goes after the plan's own trimmings and before the controls: it is
  // a dollar figure, so it outlasts the tokens and the reset times, and it is
  // one click away on the page it opens, so it goes before anything that cannot
  // be clicked any more. Before the bars, too — what a plan has *left* is what
  // stops somebody working, and that is the more urgent of the two.
  const shed: Array<keyof typeof full> = [
    'account',
    'tokens',
    'reset',
    'both',
    'listed',
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
      // Only what needs somebody. How a provider is paid for used to be said
      // here in full — `signed in` beside every model, every draw — which is
      // three columns spent saying that the thing you are talking to works.
      // A provider with no credential for it is the other case, and it is the
      // one somebody has to do something about, so it is never one of the
      // trimmings: it stays for as long as the model it belongs to does.
      if (account?.problem) r.text(` · ${account.problem}`, skin.bad, switcher)
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
      // riddle without it. It is also the control that moves to the next of
      // them — the name of what you are looking at is the thing to press to
      // look at another — so both appear exactly when `nextPlan` has somewhere
      // to go, and a person who moved stays where they moved to.
      if (along) r.text(`${planLabel(plan)} ⇄ `, lit(flip, skin.hint), flip)
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
        const pressure = planPressure(used)
        const tone =
          pressure === 'tight' ? skin.bad : pressure === 'warm' ? skin.waiting : skin.done
        r.text(`${window.label} `, money, target)
        if (show.bars) r.meter(share(window), PLAN_CELLS, lit(target, tone), target).space()
        r.text(`${used}%`, lit(target, tone), target)
        // Without a clock there is no "in two hours" to say, only the share.
        const left = frame.now === undefined ? null : resetsIn(window, frame.now)
        if (left !== null && show.reset) r.text(` ↻ ${duration(left)}`, money, target)
      })
      r.text(' │ ', skin.chrome, target)
    }
    // What those turns would have cost at the published rate, beside the plan
    // that paid for them: the figure `ccusage` gives, and not a bill — nobody is
    // charged a plan per turn. Marked and worded as somebody else's arithmetic
    // (`≈`, `at list`) and in the hint's tone, because the headline figure to
    // the right of it is money and this is not. Drawn whether or not a plan bar
    // could be: a harness that has not said how full its plan is has still run
    // the turns.
    if (listed && show.listed) {
      r.text(`${listed} at list`, money, target).text(' │ ', skin.chrome, target)
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
    const today = costToday(spend)
    if (today.figure !== null) r.text(today.figure, lit(target, skin.you), target).space()
    r.text(today.said, money, target).space()
  }
  const fits = tries.find((show) => {
    const probe = new Row(width, skin)
    status(show)(probe)
    return row.used + 1 + probe.used <= width
  })
  row.right(status(fits ?? tries[tries.length - 1] ?? full))
  return stack([{ text: skin.chrome('─'.repeat(width)), hits: [] }, row.build()])
}

/**
 * What a plan's turns would have cost at the published rate, in the shape the
 * Spend page draws it in — `≈` for Tade's own arithmetic, `≥` where some of them
 * ran on a model no rate knows — and null where there is nothing to say.
 */
function atList(spend: Frame['spend']): string | null {
  if (!spend || spend.onPlan === undefined || spend.onPlan === 'none') return null
  return `${spend.onPlan === 'partly' ? '≥' : ''}≈${dollars(spend.usdOnPlan ?? 0)}`
}

/**
 * What today cost, as the one slot in the strip that is drawn whatever else is
 * given up: the figure, and the words beside it.
 *
 * Four answers, and they are four different claims about the same day. A
 * figure is what somebody was charged. `≈$11.40 at list` is what a day a plan
 * paid for would have cost at the published rate, which is nobody's bill and
 * says so in a word. `—` is effort no dollar here covers — a model nothing has
 * a rate for, a plan whose turns could not be priced either — which is the mark
 * the Spend page puts on that same figure and `tade spend` puts in that same
 * column, because this is that figure drawn smaller and two rules for it would
 * disagree the day one of them moved. And a day where nothing was counted and
 * nothing ran is a nought, which is a figure somebody looked at, said in the
 * words there is room for.
 *
 * The two it may never collapse are the last two. Nothing *reported* is not
 * nothing *spent*: a harness whose sign-in is a plan runs up tokens and never a
 * dollar, and a window that has not read the journal yet has not looked at all
 * — so neither may claim the nought. Drawn as `$0.00` either would read as
 * free, and drawn as nothing at all — which is what this did, leaving
 * `1.9M tok │ 2h 5m │ today ▾` with an empty slot in front of the label — it
 * reads as a figure that failed to load rather than one nobody can give.
 */
function costToday(spend: Frame['spend']): { figure: string | null; said: string } {
  if (spend?.hasCost) return { figure: dollars(spend.usd), said: 'today ▾' }
  // A day a plan paid for has no bill and is not nothing: what those same turns
  // would have cost at the published rate is a figure, and this slot is the one
  // place on the row that is never given up — a subscription's whole day drawn
  // as `—` while that figure exists is the hole people leave to run `ccusage`.
  // `at list` is the word that keeps it from reading as money: nobody is billed
  // a plan per turn, so this is arithmetic and not a bill.
  const onPlan = atList(spend)
  if (onPlan) return { figure: onPlan, said: 'at list today ▾' }
  const ran = spend?.runtime
  const nothing =
    spend !== undefined && spend.tokens === 0 && ran !== undefined && ran.ms === 0 && ran.runs === 0
  return nothing
    ? { figure: null, said: 'nothing spent today ▾' }
    : { figure: '—', said: 'today ▾' }
}
