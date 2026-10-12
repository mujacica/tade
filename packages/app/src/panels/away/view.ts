import { sameTarget, type Target } from '../../hits.ts'
import { blank, box, type Drawn, Row } from '../../ui.ts'
import type { PanelContext } from '../context.ts'
import { bodyRows, type Line, panelSize } from '../frame.ts'
import { askingCard, deviceLines, left, wrap } from './cards.ts'
import { AWAY_CONTROLS, type AwayPanel, awayPanel } from './state.ts'

// The AWAY VIEW panel: what is listening, who is asking to be let in, the
// code to scan, and every device that already is.
//
// Pure, like every panel drawing. Everything it says arrives on `ctx.away`,
// which the subject that owns the server fills in each frame.
//
// **Four things it must always say, and the order they are said in.** What is
// on, and who could reach it — before the code, because somebody about to
// hold a phone up to a screen has already decided and the moment to say
// *anybody on this wifi can read it* is before that. Then a device at the
// door, **above the code**: it is the one question on the panel, it has a
// minute, and drawn under twenty rows of code it was scrolled out of sight on
// any ordinary terminal. Then the code. Then every device there is, because
// seeing the whole list is the real mitigation against one having been minted
// by something on this machine (`DEVICES_AND_AGENTS`).
//
// **Options and values, and a clause where somebody is deciding.** What a
// grant does is one line in the foot, for the box under the pointer — the
// moment somebody is about to press it (`help`); the whole sentences are each
// setting's `means`, the README and `add-away-surface`. What is listening is
// a status line in words, and the one sentence a person must not miss is one
// clause beside Disconnect everything.
//
// **Nothing cuts its own rows to fit.** The middle — the question, the code
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
  /** What this machine is called in a sentence: `this Mac`, `this machine`. */
  machine: string
  /** The pairing URL the code carries, and how long it has left. */
  ticket: { url: string; secondsLeft: number } | null
  /** The code itself, as half-block rows. Empty where it could not be made. */
  code: readonly string[]
  /**
   * Somebody is waiting to be let in: what it calls itself, where it came
   * from in words (`whereFrom`), the address itself where that is worth
   * checking and empty where it is this machine, and the seconds it has left
   * of how many it was given.
   */
  asking: {
    label: string
    from: string
    address: string
    secondsLeft: number
    seconds: number
  } | null
  devices: readonly AwayDevice[]
  /** How many streams are open now. A count, and the liveness of the page. */
  streams: number
  /**
   * Whether `surfaces.web.acting` is on.
   *
   * **What it decides is whether the per-device boxes exist at all.** A
   * control that cannot do what it says is worse than none, and with acting
   * off there is no route for one to reach.
   */
  acting: boolean
  /** Whether `surfaces.web.orchestrator` is on, read the way `acting` is. */
  talking: boolean
  /** Whether `surfaces.web.settings` is on: a third flag for a third decision. */
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
  /**
   * Where it paired from, in words (`whereFrom`): `this Mac`, `your network`,
   * `Tailscale`. Never the address — what another device is, from here, is a
   * name, a place and a date.
   */
  from: string
  pairedAt: number
  /** What it was granted beyond names and counts, already in grant order. */
  reads: readonly string[]
  /** Whether a person at the machine has let it answer and steer. */
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
  const middle = middleOf(panel, view, ctx, inner, true)
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
 * The panel's body with no box and no scrolling of its own: what is on, a
 * device at the door, the code and its link, the devices, and the foot.
 *
 * For the Away page of Settings, which draws it under the switch that turned
 * the away view on — the same lines rather than a second drawing of them, so
 * the two can never say different things about one code. The page is its own
 * scrolling region; no device is chosen in it, because the keyboard there
 * walks the settings — and for the same reason the card draws no key caps.
 */
export function awayLines(view: AwayView, ctx: PanelContext, inner: number): Line[] {
  return [
    ...headOf(view, ctx, inner, false).slice(1),
    ...middleOf(awayPanel(), view, ctx, inner, false).lines,
    ...footOf(view, ctx, inner),
  ]
}

/**
 * What is on, and who could reach it, in words — with the port at the right.
 * Always drawn, and always first.
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
  const status = { said: state(view), tone: tone(view, skin) }
  if (!view.listening) {
    const go = (r: Row) => r.button('Settings › Away view', settings).space()
    lines.push(
      ...(panel ? withControl(row, inner, status, go, settings) : said(row, inner, status)),
    )
  } else {
    // The port at the right where both fit, and under it where they do not:
    // the addresses behind it are what the link below already says.
    const port = portOf(view.bound)
    const one = status.said.length + 2 + port.length + 2 <= inner
    const line = row().space().text(status.said, status.tone)
    if (port === '' || one) lines.push(line.right((r) => r.text(port, skin.hint).space()).build())
    else lines.push(line.build(), ...said(row, inner, { said: port, tone: skin.hint }))
  }
  if (view.bind === 'lan' && view.listening) {
    // Above the code, because the moment to say this is before somebody holds
    // a phone up to the screen. One clause: the whole of it, with the way out,
    // is the bind setting's own `means`.
    lines.push(...said(row, inner, { said: `▲ ${view.lan}`, tone: skin.waiting }))
  }
  lines.push(blank(inner))
  return lines
}

/** The question, the code and the devices: the part that scrolls. */
function middleOf(
  panel: AwayPanel,
  view: AwayView,
  ctx: PanelContext,
  inner: number,
  keys: boolean,
): { lines: Line[]; chosen: { from: number; to: number } | null } {
  const { skin } = ctx
  const row = () => new Row(inner, skin, ctx.pointer)
  const lines: Line[] = []
  if (view.asking !== null) lines.push(...askingCard(view.asking, ctx, inner, keys), blank(inner))
  // Off, there is nothing to pair with and the status line has said so; the
  // devices still follow, because the list is the mitigation either way.
  if (view.listening) lines.push(...pairingOf(view, ctx, inner), blank(inner))

  const live = view.devices.filter((one) => one.live).length
  const count =
    view.devices.length === 0
      ? ''
      : `${view.devices.length} paired${live === 0 ? '' : ` · ${live} connected`}`
  lines.push(row().space().text('DEVICES', skin.label).space(2).text(count, skin.hint).build())
  if (view.devices.length === 0) {
    lines.push(row().space().text('No device has been paired.', skin.hint).build())
    return { lines, chosen: null }
  }
  const starts: number[] = []
  for (const [at, device] of view.devices.entries()) {
    lines.push(blank(inner))
    starts.push(lines.length)
    const chosen = panel.moved && at === panel.chosen
    lines.push(...deviceLines(device, chosen, view, ctx, inner))
  }
  // Where the chosen device is in the whole region, so scrolling follows it:
  // an offset anchored in the rows it was drawn on would move when the code
  // did. Null until somebody moved the keyboard into the list — see `moved`.
  if (!panel.moved) return { lines, chosen: null }
  const which = Math.min(panel.chosen, view.devices.length - 1)
  const from = starts[which] ?? lines.length - 1
  const to = (starts[which + 1] ?? lines.length + 1) - 2
  return { lines, chosen: { from, to } }
}

/** A heading with New code at its right, then the code, its link and how to use them. */
function pairingOf(view: AwayView, ctx: PanelContext, inner: number): Line[] {
  const { skin } = ctx
  const row = () => new Row(inner, skin, ctx.pointer)
  const code: Target = { kind: 'control', id: AWAY_CONTROLS.code }
  const heading = row().space().text('PAIR A DEVICE', skin.label)
  if (view.bind === 'lan' && view.reachable.length === 0) {
    // `routesOf` says there is no way off this machine. A code for an address
    // nobody can reach is worse than saying so.
    return [
      heading.build(),
      row().space().text('No network: nothing could reach this machine.', skin.bad).build(),
    ]
  }
  const lines: Line[] = [heading.right((r) => r.chip('New code', code).space()).build()]
  // No row between the heading and the code: the code carries its own quiet
  // zone, and a row of ours on top of it is three empty rows.
  if (view.ticket === null) return lines
  // **A code that does not fit is not drawn.** `fitTo` would cut every row of
  // it to the panel's width, and a cut QR is one that scans as nothing while
  // looking exactly like one that works — the single worst thing this panel
  // could draw. Said instead, with the address, which is the half a narrow
  // window can still carry.
  const widest = Math.max(0, ...view.code.map((line) => line.length))
  if (view.code.length === 0 || widest + 2 > inner) {
    const narrow = 'This window is too narrow to draw the code — widen it.'
    lines.push(...said(row, inner, { said: narrow, tone: skin.waiting }))
  } else {
    for (const line of view.code) lines.push(row().space(2).text(line, skin.you).build())
  }
  lines.push(blank(inner), ...linkLines(view.ticket.url, ctx, inner))
  // How to use it, in what is true of this address: a phone can only follow a
  // code to a name it can reach, and `localhost` on a phone is the phone — what
  // to name instead is the Trusted hostnames row's to say.
  const phone = view.bind === 'lan' || view.ticket.url.startsWith('https://')
  const how = phone
    ? 'Scan it with a phone’s camera, or open the link'
    : `Open the link on ${view.machine}`
  lines.push(
    ...said(row, inner, { said: `${how} · ${left(view.ticket.secondsLeft)}`, tone: skin.hint }),
  )
  return lines
}

/**
 * The address the code carries, with `Open` and `Copy` at the right of the
 * line it ends on, or on a line of their own under it where they do not fit.
 *
 * Over as many lines as it takes. An address is the one thing on this panel
 * somebody may have to read out or type, so a cut one is no address at all —
 * and unlike a sentence it cannot be broken on a space.
 *
 * **The address is `Open` too**: a press on it is that control, carried out
 * by the subject holding the ticket, so the address itself is never in a hit.
 * It is a link in the terminal's own sense as well (`hyperlink`), for a
 * terminal that offers its own open and copy on one.
 */
function linkLines(url: string, ctx: PanelContext, inner: number): Line[] {
  const { skin } = ctx
  const open: Target = { kind: 'control', id: AWAY_CONTROLS.open }
  const copy: Target = { kind: 'control', id: AWAY_CONTROLS.copy }
  const buttons = (r: Row) => r.chip('Open', open).space().chip('Copy', copy).space()
  const look = (part: string) => skin.hyperlink(url, skin.link(part))
  const line = (part: string) => new Row(inner, skin, ctx.pointer).space().text(part, look, open)
  const parts = chunks(url, inner - 2)
  const last = parts.pop() ?? ''
  const lines = parts.map((part) => line(part).build())
  const beside = line(last).right(buttons).build()
  if (beside.hits.some((hit) => sameTarget(hit.target, copy))) return [...lines, beside]
  return [...lines, line(last).build(), new Row(inner, skin, ctx.pointer).right(buttons).build()]
}

/**
 * The foot, which is never scrolled: what the control under the pointer
 * grants, anything that went wrong, and the clause about this machine's agents
 * beside Disconnect everything — the two things a person must not be able to
 * scroll past.
 *
 * **Disconnect everything is destructive and not what the panel is for**, so
 * it is grey until the pointer is on it and red then (`harm`), the clause
 * beside it saying why it is there at all.
 *
 * **The help keeps its rows whatever is pointed at**, as many as the longest
 * clause in `help` needs at this width: a foot that grew a row under the
 * pointer would move the box it is explaining out from under it.
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
        r.button('Disconnect everything', all, view.devices.length === 0 ? 'off' : 'harm').space(),
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

/** The one line that says what is on, and who could reach it. */
function state(view: AwayView): string {
  if (!view.listening) return '○ Off — nothing is listening'
  if (view.bind === 'lan') return '● On — anyone on your network can reach it'
  return `● On — only ${view.machine} can reach it`
}

function tone(view: AwayView, skin: PanelContext['skin']): (text: string) => string {
  if (!view.listening) return skin.hint
  return view.bind === 'lan' ? skin.waiting : skin.done
}

/** The port, or ports, out of what is bound: `127.0.0.1:7654` and `[::1]:7654` are one port. */
function portOf(bound: readonly string[]): string {
  const ports = [...new Set(bound.map((one) => one.slice(one.lastIndexOf(':') + 1)))]
  if (ports.length === 0) return ''
  return `${ports.length === 1 ? 'port' : 'ports'} ${ports.join(', ')}`
}

/** A value with no spaces in it, as lines that fit: an address. */
function chunks(said: string, width: number): string[] {
  const most = Math.max(8, width)
  const out: string[] = []
  for (let at = 0; at < said.length; at += most) out.push(said.slice(at, at + most))
  return out.length === 0 ? [said] : out
}
