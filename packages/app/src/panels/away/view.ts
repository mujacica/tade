import { sameTarget, type Target } from '../../hits.ts'
import { blank, box, type Drawn, Row } from '../../ui.ts'
import type { PanelContext } from '../context.ts'
import { bodyRows, type Line, panelSize } from '../frame.ts'
import { AWAY_CONTROLS, type AwayPanel, awayPanel } from './state.ts'

// The AWAY VIEW panel: what is listening, the code to scan, who is asking to
// be let in, and every device that already is.
//
// Pure, like every panel drawing. Everything it says arrives on `ctx.away`,
// which the subject that owns the server fills in each frame.
//
// **Four things it must always say, and the order they are said in.** What is
// on, and to whom — before the code, because somebody about to hold a phone up
// to a screen has already decided and the moment to say *anybody on this wifi
// can read it* is before that. Then the code. Then whoever is asking. Then
// every device there is, because seeing the whole list is the real mitigation
// against one having been minted by something on this machine
// (`DEVICES_AND_AGENTS`).
//
// **Options and values, and a clause where somebody is deciding.** It once
// said all of acting and all of talking above the list, two paragraphs read
// every time the panel opened, plus how to turn it on and why the list is
// whole. What a grant does is now one line in the foot, for the chip under
// the pointer — the moment somebody is about to press it — in the domain's
// short clauses (`help`); the whole sentences are each setting's `means`, the
// README and `add-away-surface`. What is listening is a status line, and the
// one sentence a person must not miss is one clause beside Disconnect
// everything.
//
// **Nothing cuts its own rows to fit.** The middle — the code, the question
// and the device list — is one scrolling region: a code drawn half and a
// device list ending in `+3 more` are the same bug, and on a short terminal
// what you do is scroll. The head (what is on) and the foot (the clause about
// this machine's agents, and Disconnect everything) are always drawn, because
// those two are the ones a person must not be able to miss.

/** Everything the panel draws, as the subject that owns the server has it. */
export interface AwayView {
  /** Whether a listener is up now — not what the config says. */
  listening: boolean
  /** `loopback` or `lan`, as the surface was turned on. */
  bind: 'loopback' | 'lan'
  /** What is bound, as `host:port`. Empty when nothing is. */
  bound: readonly string[]
  /**
   * The addresses a phone could actually reach, as `routesOf`'s rule allows:
   * never a link-local and never an internal one. Empty is `no network`, said
   * as that rather than drawn as a code nobody can reach.
   */
  reachable: readonly string[]
  /** The pairing URL the code carries, and how long it has left. */
  ticket: { url: string; secondsLeft: number } | null
  /** The code itself, as half-block rows. Empty where it could not be made. */
  code: readonly string[]
  /** Somebody is waiting to be let in. */
  asking: { label: string; from: string; host: string; secondsLeft: number } | null
  devices: readonly AwayDevice[]
  /** How many streams are open now. A count, and the liveness of the page. */
  streams: number
  /**
   * Whether `surfaces.web.acting` is on.
   *
   * **What it decides is whether the per-device control exists at all.** A
   * button that cannot do what it says is worse than no button, and with
   * acting off there is no route for one to reach — so the row is drawn
   * exactly as it was before this existed.
   */
  acting: boolean
  /**
   * Whether `surfaces.web.orchestrator` is on.
   *
   * A second flag for a second decision, read the same way `acting` is: with
   * it off there is no route a message could reach, so the chip is not drawn
   * rather than drawn and refused.
   */
  talking: boolean
  /**
   * Whether `surfaces.web.settings` is on: a third flag for a third decision,
   * read the way the two above are — with it off the chip is not drawn.
   */
  configuring: boolean
  /**
   * What each device's control grants, by the control's prefix in
   * `AWAY_CONTROLS`: one clause each, drawn in the foot while the pointer is
   * on that control. Every value is drawn in the same rows, so the foot is as
   * tall as the longest of them whatever is pointed at.
   */
  help: Readonly<Record<string, string>>
  /** Said under the status line when a LAN bind is on. `LAN_IS_PLAINTEXT_SHORT`. */
  lan: string
  /** Said always, beside Disconnect everything. `DEVICES_SEEN_BY_AGENTS`. */
  agents: string
  /** What could not be done, in Tade's own words. */
  problem: string | null
}

export interface AwayDevice {
  id: string
  /** The person's own words about their own phone. Drawn as text, never markup. */
  label: string
  pairedAt: number
  /** What it was granted beyond names and counts, already in grant order. */
  reads: readonly string[]
  /**
   * Whether a person at the machine has let this device act.
   *
   * The device's own scopes beyond `read`, folded to one answer, because the
   * row has width for a word and not a list — and because the question
   * somebody scanning the list is asking is *can any of these change my
   * work*. What it was granted exactly is in `web-devices.jsonl`, which is
   * the record either way.
   */
  mayAct: boolean
  /** Whether it was granted `ask`: free text into the conversation. */
  mayTalk: boolean
  /** Whether it was granted `lanes`: the last rows of agents' own screens. */
  maySee: boolean
  /** Whether it was granted `agents`: stopping an agent and opening it again. */
  mayStop: boolean
  /** Whether it was granted `projects`: closing a project and opening it again. */
  mayClose: boolean
  /** Whether it was granted `settings`: reading the settings, every key said as set or not. */
  mayReadSettings: boolean
  /** Whether it was granted `configure`: changing a setting a request is enough for. */
  mayConfigure: boolean
  /** Whether it has a live stream open now. */
  live: boolean
}

/** How wide the box may be. Wide enough for a code and its quiet zone. */
const WIDEST = 74

export function away(panel: AwayPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const view = ctx.away
  const { width, inner, rows: room } = panelSize(ctx, { max: WIDEST })
  const row = () => new Row(inner, skin, ctx.pointer)

  if (view === null) {
    return box(
      'AWAY VIEW',
      [blank(inner), row().space().text('The away view is not wired up here.', skin.hint).build()],
      width,
      skin,
      { corner: 'esc' },
    )
  }

  const head = headOf(view, ctx, inner, true)
  const foot = footOf(view, ctx, inner)
  const middle = middleOf(panel, view, ctx, inner)
  const space = Math.max(1, room - head.length - foot.length)
  const drawn =
    middle.lines.length === 0
      ? { rows: [] as Line[] }
      : bodyRows(
          {
            lines: middle.lines,
            width: inner,
            room: Math.min(space, middle.lines.length),
            scroll: panel.scroll,
            chosen: middle.chosen,
          },
          ctx,
        )
  return box('AWAY VIEW', [...head, ...drawn.rows, ...foot], width, skin, { corner: 'esc' })
}

/**
 * The panel's body with no box and no scrolling of its own: what is on, the
 * code and its link, whoever is asking, the devices, and the foot.
 *
 * For the Away page of Settings, which draws it under the switch that turned
 * the away view on — the same lines rather than a second drawing of them, so
 * the two can never say different things about one code. The page is its own
 * scrolling region; no device is chosen in it, because the keyboard there
 * walks the settings.
 */
export function awayLines(view: AwayView, ctx: PanelContext, inner: number): Line[] {
  return [
    ...headOf(view, ctx, inner, false).slice(1),
    ...middleOf(awayPanel(), view, ctx, inner).lines,
    ...footOf(view, ctx, inner),
  ]
}

/**
 * What is on, and to whom, in one line with what is bound beside it. Always
 * drawn, and always first.
 *
 * Off, the panel offers the way to the switch (`away-settings`, the strip's
 * chip's own action) rather than a sentence saying where it is — and not on
 * the Settings page, which is where that switch already is.
 */
function headOf(view: AwayView, ctx: PanelContext, inner: number, panel: boolean): Line[] {
  const { skin } = ctx
  const row = () => new Row(inner, skin, ctx.pointer)
  const lines: Line[] = [blank(inner)]
  const settings: Target = { kind: 'action', name: 'away-settings' }
  if (!view.listening) {
    const off = { said: state(view), tone: tone(view, skin) }
    const go = (r: Row) => r.button('Settings › Away view', settings).space()
    lines.push(...(panel ? withControl(row, inner, off, go, settings) : said(row, inner, off)))
  } else {
    // What is bound beside it where both fit, and under it where they do not:
    // an address is never what gets cut.
    const bound = view.bound.join('  ') || 'nothing is bound'
    const one = state(view).length + 2 + bound.length + 2 <= inner
    const status = row().space().text(state(view), tone(view, skin))
    if (one) lines.push(status.space(2).text(bound, skin.hint).build())
    else lines.push(status.build(), ...said(row, inner, { said: bound, tone: skin.hint }))
  }
  if (view.bind === 'lan' && view.listening) {
    // Above the code, because the moment to say this is before somebody holds
    // a phone up to the screen. One clause: the whole of it, with the way out,
    // is the bind setting's own `means`.
    for (const said of wrap(view.lan, inner - 3)) {
      lines.push(row().space().text(said, skin.waiting).build())
    }
  }
  lines.push(blank(inner))
  return lines
}

/** The code, the question, and the devices: the part that scrolls. */
function middleOf(
  panel: AwayPanel,
  view: AwayView,
  ctx: PanelContext,
  inner: number,
): { lines: Line[]; chosen: { from: number; to: number } | null } {
  const { skin } = ctx
  const row = () => new Row(inner, skin, ctx.pointer)
  // Off, there is nothing to pair with and the status line has said so; the
  // devices still follow, because the list is the mitigation either way.
  const lines: Line[] = view.listening ? pairingOf(view, ctx, inner) : []

  if (view.asking !== null) {
    lines.push(blank(inner))
    lines.push(row().space().text('A DEVICE WANTS TO PAIR', skin.label).build())
    lines.push(
      row()
        .space()
        .text(view.asking.label || 'a device', skin.you)
        .build(),
    )
    lines.push(
      row().space().text(`${view.asking.from} · reached ${view.asking.host}`, skin.hint).build(),
    )
    lines.push(
      row()
        .space()
        .text('It will be able to read names, states and counts — and change nothing.', skin.hint)
        .build(),
    )
    lines.push(
      row()
        .space()
        .text(left(view.asking.secondsLeft), skin.hint)
        .right((r) =>
          r
            .button(`${ctx.bindings.approve ?? 'a'} let it in`, {
              kind: 'control',
              id: AWAY_CONTROLS.allow,
            })
            .space()
            .button(
              `${ctx.bindings.deny ?? 'd'} refuse`,
              { kind: 'control', id: AWAY_CONTROLS.deny },
              'danger',
            )
            .space(),
        )
        .build(),
    )
  }

  // A row between the devices and whatever is above them in this region, and
  // none where nothing is: the head already ends in one.
  if (lines.length > 0) lines.push(blank(inner))
  lines.push(
    row()
      .space()
      .text('DEVICES', skin.label)
      .space()
      .text(view.streams === 0 ? '' : `${view.streams} open`, skin.hint)
      .build(),
  )
  if (view.devices.length === 0) {
    lines.push(row().space().text('No device has been paired.', skin.hint).build())
    return { lines, chosen: null }
  }
  const starts: number[] = []
  for (const [at, device] of view.devices.entries()) {
    starts.push(lines.length)
    lines.push(...deviceLines(device, at === panel.chosen, view, ctx, inner))
  }
  // Where the chosen device is in the whole region, so scrolling follows it:
  // an offset anchored in the rows it was drawn on would move when the code
  // did. Null until somebody moved the keyboard into the list — see `moved`.
  if (!panel.moved) return { lines, chosen: null }
  const which = Math.min(panel.chosen, view.devices.length - 1)
  const from = starts[which] ?? lines.length - 1
  return { lines, chosen: { from, to: (starts[which + 1] ?? lines.length) - 1 } }
}

/** The code, its link and how to use them, or why there is none: what a listener offers. */
function pairingOf(view: AwayView, ctx: PanelContext, inner: number): Line[] {
  const { skin } = ctx
  const row = () => new Row(inner, skin, ctx.pointer)
  const code: Target = { kind: 'control', id: AWAY_CONTROLS.code }
  if (view.bind === 'lan' && view.reachable.length === 0) {
    // `routesOf` says there is no way off this machine. A code for an address
    // nobody can reach is worse than saying so.
    return [row().space().text('No network: nothing could reach this machine.', skin.bad).build()]
  }
  if (view.ticket === null)
    return [
      row()
        .right((r) => r.button('New code', code).space())
        .build(),
    ]
  const lines: Line[] = []
  // **A code that does not fit is not drawn.** `fitTo` would cut every row of
  // it to the panel's width, and a cut QR is one that scans as nothing while
  // looking exactly like one that works — the single worst thing this panel
  // could draw. Said instead, with the address, which is the half a narrow
  // window can still carry.
  const widest = Math.max(0, ...view.code.map((line) => line.length))
  if (view.code.length === 0 || widest + 2 > inner) {
    for (const part of wrap('This window is too narrow to draw the code — widen it.', inner - 3)) {
      lines.push(row().space().text(part, skin.waiting).build())
    }
  } else {
    for (const line of view.code) lines.push(row().space(2).text(line, skin.you).build())
  }
  lines.push(blank(inner))
  // Over as many lines as it takes. An address is the one thing on this panel
  // somebody may have to read out or type, so a cut one is no address at all —
  // and unlike a sentence it cannot be broken on a space.
  for (const part of chunks(view.ticket.url, inner - 2)) {
    lines.push(row().space().text(part, skin.you).build())
  }
  // How to use it, in what is true of this address: a phone can only follow a
  // code to a name it can reach, and `localhost` on a phone is the phone — what
  // to name instead is the Trusted hostnames row's to say.
  const phone = view.bind === 'lan' || view.ticket.url.startsWith('https://')
  const how = `${phone ? 'Scan it, or open the link' : 'Open the link on this machine'} — ${left(view.ticket.secondsLeft)}`
  lines.push(
    ...withControl(
      row,
      inner,
      { said: how, tone: skin.hint },
      (r) => r.chip('New code', code).space(),
      code,
    ),
  )
  return lines
}

/**
 * The foot, which is never scrolled: what the control under the pointer
 * grants, anything that went wrong, and the clause about this machine's agents
 * beside Disconnect everything — the two things a person must not be able to
 * scroll past.
 *
 * **The help keeps its rows whatever is pointed at**, as many as the longest
 * clause in `help` needs at this width: a foot that grew a row under the
 * pointer would move the chip it is explaining out from under it.
 */
function footOf(view: AwayView, ctx: PanelContext, inner: number): Line[] {
  const { skin } = ctx
  const row = () => new Row(inner, skin, ctx.pointer)
  const lines: Line[] = []
  const room =
    view.devices.length === 0
      ? 1
      : Math.max(1, ...Object.values(view.help).map((one) => wrap(one, inner - 3).length))
  const pointed = helpFor(view, ctx.pointer.hover)
  const said = pointed === null ? [] : wrap(pointed, inner - 3)
  for (let at = 0; at < room; at += 1) {
    const part = said[at]
    lines.push(part === undefined ? blank(inner) : row().space().text(part, skin.hint).build())
  }
  if (view.problem !== null) {
    lines.push(row().space().text(`▲ ${view.problem}`, skin.bad).build())
  }
  const all: Target = { kind: 'control', id: AWAY_CONTROLS.all }
  lines.push(
    ...withControl(
      row,
      inner,
      { said: view.agents, tone: skin.hint },
      (r) =>
        r
          .button('Disconnect everything', all, view.devices.length === 0 ? 'off' : 'danger')
          .space(),
      all,
    ),
  )
  return lines
}

/** What the control under the pointer grants, or null where it is not one of a device's. */
function helpFor(view: AwayView, hover: Target | null): string | null {
  if (hover?.kind !== 'control') return null
  const found = Object.entries(view.help).find(([prefix]) => hover.id.startsWith(prefix))
  return found === undefined ? null : found[1]
}

/**
 * A line with its control pinned at the right, or the control on a line of
 * its own under it where the two do not fit: `Row` drops a right-hand group
 * that does not fit whole, and **a control is never what gets cut**.
 */
function withControl(
  row: () => Row,
  inner: number,
  text: Said,
  control: (r: Row) => Row,
  target: Target,
): Line[] {
  const one = row().space().text(text.said, text.tone).right(control).build()
  const drawn = one.hits.some((hit) => sameTarget(hit.target, target))
  return drawn ? [one] : [...said(row, inner, text), row().right(control).build()]
}

/** Words in one tone, as many lines as they take: wrapped, never cut. */
interface Said {
  said: string
  tone: (text: string) => string
}

function said(row: () => Row, inner: number, text: Said): Line[] {
  return wrap(text.said, inner - 3).map((part) => row().space().text(part, text.tone).build())
}

/**
 * One device: one line where its controls fit beside what it is, two where
 * they do not.
 *
 * **A control is never what gets cut.** `Row` drops a right-hand group that
 * does not fit as a whole, so a long name, a date and three chips would lose
 * the `×` along with the rest — and a device nobody can disconnect from the
 * list is the one outcome this panel exists to prevent. Where the `×` did not
 * make it onto the line, the controls get one of their own under it.
 */
function deviceLines(
  device: AwayDevice,
  chosen: boolean,
  view: Pick<AwayView, 'acting' | 'talking' | 'configuring'>,
  ctx: PanelContext,
  inner: number,
): Line[] {
  const revoke = `${AWAY_CONTROLS.revoke}${device.id}`
  const one = deviceLine(device, chosen, view, ctx, inner, true)
  const fits = one.hits.some((hit) => hit.target.kind === 'control' && hit.target.id === revoke)
  if (fits) return [one]
  return [
    deviceLine(device, chosen, view, ctx, inner, false),
    new Row(inner, ctx.skin, ctx.pointer).right((r) => chipsOf(r, device, view)).build(),
  ]
}

function deviceLine(
  device: AwayDevice,
  chosen: boolean,
  view: Pick<AwayView, 'acting' | 'talking' | 'configuring'>,
  ctx: PanelContext,
  inner: number,
  controls: boolean,
): Line {
  const { skin } = ctx
  const acting = view.acting
  const reads = device.reads.length === 0 ? 'names and counts' : device.reads.join(', ')
  // `may act` is on the row rather than only on the control, because the list
  // is what somebody reads to answer *can any of these change my work* — and a
  // capability you can only see by looking at the state of a button is one
  // nobody audits. Absent with acting off, where it cannot be true.
  // Two words rather than two clauses, because the row is cut to the panel's
  // width and the half that would be cut is the second one — which is the one
  // somebody scanning the list is least likely to have expected.
  const can = [
    acting && device.mayAct ? 'may act' : '',
    acting && device.mayStop ? 'may stop agents' : '',
    acting && device.mayClose ? 'may close projects' : '',
    view.talking && device.mayTalk ? 'may talk' : '',
    view.configuring && device.mayConfigure ? 'may change settings' : '',
  ].filter(Boolean)
  const said = can.length === 0 ? reads : `${reads} · ${can.join(' · ')}`
  const line = new Row(inner, skin, ctx.pointer)
    .space()
    .text(chosen ? '›' : ' ', skin.signal)
    .space()
    .text(device.label || 'a device', skin.you)
    .space()
    .text(device.live ? '● now' : '○', device.live ? skin.done : skin.hint)
    .space()
    .text(`${ctx.date(device.pairedAt)} · ${said}`, skin.hint)
  return (controls ? line.right((r) => chipsOf(r, device, view)) : line).build()
}

/** One device's controls, the `×` last where the eye looks for it. */
function chipsOf(
  r: Row,
  device: AwayDevice,
  view: Pick<AwayView, 'acting' | 'talking' | 'configuring'>,
): Row {
  // **Only where the setting is on.** With it off there is no route a grant
  // could reach, so the control is not drawn rather than drawn and refused —
  // and the row is byte-identical to what it was before any of this existed.
  if (view.acting) {
    // **One chip, one word, and the colour says which way it goes** —
    // `danger`/`go` is the window's own pair for exactly this. The *state* is
    // never colour alone: it is `· may act` in the row's own words, which is
    // also the half that has to be readable in a screenshot and in a
    // `tade web devices` listing.
    r.chip(
      'act',
      { kind: 'control', id: `${AWAY_CONTROLS.act}${device.id}` },
      device.mayAct ? 'danger' : 'go',
    ).space()
    // The lifecycle, a chip each: neither is implied by `act`, and neither by
    // the other — the same shape and the same argument as the chip above.
    r.chip(
      'agents',
      { kind: 'control', id: `${AWAY_CONTROLS.agents}${device.id}` },
      device.mayStop ? 'danger' : 'go',
    ).space()
    r.chip(
      'projects',
      { kind: 'control', id: `${AWAY_CONTROLS.projects}${device.id}` },
      device.mayClose ? 'danger' : 'go',
    ).space()
  }
  if (view.talking) {
    // The same shape as the act chip and the same argument: one chip, one
    // word, the colour saying which way it goes, and the *state* in the row's
    // own words rather than in colour alone.
    r.chip(
      'talk',
      { kind: 'control', id: `${AWAY_CONTROLS.talk}${device.id}` },
      device.mayTalk ? 'danger' : 'go',
    ).space()
  }
  if (view.configuring) {
    // The same shape again: drawn only where the setting is on, the state in
    // the row's own words (`may change settings`) rather than in colour alone.
    r.chip(
      'configure',
      { kind: 'control', id: `${AWAY_CONTROLS.configure}${device.id}` },
      device.mayConfigure ? 'danger' : 'go',
    ).space()
  }
  // **Always drawn**, unlike the ones above: each grants reading, not doing, so
  // there is no setting that could make it a button nothing can carry out. The
  // state is `lanes` and `settings` in the row's own words, as theirs is.
  r.chip(
    'lanes',
    { kind: 'control', id: `${AWAY_CONTROLS.see}${device.id}` },
    device.maySee ? 'danger' : 'go',
  ).space()
  r.chip(
    'settings',
    { kind: 'control', id: `${AWAY_CONTROLS.settings}${device.id}` },
    device.mayReadSettings ? 'danger' : 'go',
  ).space()
  return r
    .chip('×', { kind: 'control', id: `${AWAY_CONTROLS.revoke}${device.id}` }, 'danger')
    .space()
}

/** The one line that says what is on, and to whom. */
function state(view: AwayView): string {
  if (!view.listening) return '○ Off — nothing is listening'
  if (view.bind === 'lan') return '● On, listening on the network'
  return '● On, on this machine alone'
}

function tone(view: AwayView, skin: PanelContext['skin']): (text: string) => string {
  if (!view.listening) return skin.hint
  return view.bind === 'lan' ? skin.waiting : skin.done
}

/** How long is left, in the window's own plain words. */
function left(seconds: number): string {
  if (seconds <= 0) return 'expired'
  if (seconds < 60) return `${seconds}s left`
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} left`
}

/** A value with no spaces in it, as lines that fit: an address. */
function chunks(said: string, width: number): string[] {
  const most = Math.max(8, width)
  const out: string[] = []
  for (let at = 0; at < said.length; at += most) out.push(said.slice(at, at + most))
  return out.length === 0 ? [said] : out
}

/**
 * A sentence as lines that fit, broken on spaces.
 *
 * Wrapped rather than cut, because these two sentences are the ones that may
 * never say only the comfortable half: a LAN warning truncated at *anybody on
 * the same* is a warning that stopped being one.
 */
function wrap(said: string, width: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of said.split(/\s+/)) {
    if (line === '') line = word
    else if (line.length + 1 + word.length <= width) line = `${line} ${word}`
    else {
      out.push(line)
      line = word
    }
  }
  if (line !== '') out.push(line)
  return out
}
