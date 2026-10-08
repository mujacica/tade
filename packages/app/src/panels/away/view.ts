import { blank, box, type Drawn, Row } from '../../ui.ts'
import type { PanelContext } from '../context.ts'
import { bodyRows, type Line, panelSize } from '../frame.ts'
import { AWAY_CONTROLS, type AwayPanel } from './state.ts'

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
// **Nothing cuts its own rows to fit.** The middle — the code, the question
// and the device list — is one scrolling region: a code drawn half and a
// device list ending in `+3 more` are the same bug, and on a short terminal
// what you do is scroll. The head (what is on) and the foot (the sentence
// about this machine's agents, and Disconnect everything) are always drawn,
// because those two are the ones a person must not be able to miss.

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
  /** Said when a LAN bind is on. `LAN_IS_PLAINTEXT`, verbatim. */
  lan: string
  /** Said always. `DEVICES_SEEN_BY_AGENTS`, as the one clause a control gets. */
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

  const head = headOf(view, ctx, inner)
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

/** What is on, and to whom. Always drawn, and always first. */
function headOf(view: AwayView, ctx: PanelContext, inner: number): Line[] {
  const { skin } = ctx
  const row = () => new Row(inner, skin, ctx.pointer)
  const lines: Line[] = [blank(inner)]
  lines.push(row().space().text(state(view), tone(view, skin)).build())
  if (view.listening) {
    lines.push(
      row()
        .space()
        .text(view.bound.join('  ') || 'nothing is bound', skin.hint)
        .build(),
    )
  }
  if (view.bind === 'lan' && view.listening) {
    // Above the code, because the moment to say this is before somebody holds
    // a phone up to the screen — and whole, because the half of this sentence
    // that says what to do about it is the half people act on.
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
  const lines: Line[] = []

  if (!view.listening) {
    lines.push(
      row()
        .space()
        .text('Nothing is listening, so there is nothing to pair with.', skin.hint)
        .build(),
    )
    lines.push(
      row()
        .space()
        .text('Turn it on in Settings → Away view, then open Tade again.', skin.hint)
        .build(),
    )
  } else if (view.bind === 'lan' && view.reachable.length === 0) {
    // `routesOf` says there is no way off this machine. A code for an address
    // nobody can reach is worse than saying so.
    lines.push(
      row().space().text('No network: nothing could reach this machine.', skin.bad).build(),
    )
  } else if (view.ticket === null) {
    lines.push(
      row()
        .right((r) => r.button('New code', { kind: 'control', id: AWAY_CONTROLS.code }).space())
        .build(),
    )
  } else {
    // **A code that does not fit is not drawn.** `fitTo` would cut every row
    // of it to the panel's width, and a cut QR is one that scans as nothing
    // while looking exactly like one that works — the single worst thing this
    // panel could draw. Said instead, with the address, which is the half a
    // narrow window can still carry.
    const widest = Math.max(0, ...view.code.map((line) => line.length))
    if (view.code.length === 0 || widest + 2 > inner) {
      for (const part of wrap(
        'This window is too narrow to draw the code — widen it.',
        inner - 3,
      )) {
        lines.push(row().space().text(part, skin.waiting).build())
      }
    } else {
      for (const line of view.code) lines.push(row().space(2).text(line, skin.you).build())
    }
    lines.push(blank(inner))
    // Over as many lines as it takes. An address is the one thing on this
    // panel somebody may have to read out or type, so a cut one is no address
    // at all — and unlike a sentence it cannot be broken on a space.
    for (const part of chunks(view.ticket.url, inner - 2)) {
      lines.push(row().space().text(part, skin.you).build())
    }
    lines.push(
      row()
        .space()
        .text(
          `Scan it with the phone you want to use — ${left(view.ticket.secondsLeft)}`,
          skin.hint,
        )
        .build(),
    )
    lines.push(
      row()
        .space()
        .text('Tade will ask you here before letting it in.', skin.hint)
        .right((r) => r.chip('New code', { kind: 'control', id: AWAY_CONTROLS.code }).space())
        .build(),
    )
  }

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

  lines.push(blank(inner))
  lines.push(
    row()
      .space()
      .text('DEVICES', skin.label)
      .space()
      .text(view.streams === 0 ? '' : `${view.streams} open`, skin.hint)
      .build(),
  )
  const first = lines.length
  if (view.devices.length === 0) {
    lines.push(row().space().text('No device has been paired.', skin.hint).build())
    return { lines, chosen: null }
  }
  for (const [at, device] of view.devices.entries()) {
    lines.push(deviceLine(device, at === panel.chosen, ctx, inner))
  }
  // Where the chosen row is in the whole region, so scrolling follows it: an
  // offset anchored in the rows it was drawn on would move when the code did.
  // Null until somebody moved the keyboard into the list — see `moved`.
  if (!panel.moved) return { lines, chosen: null }
  const at = first + Math.min(panel.chosen, view.devices.length - 1)
  return { lines, chosen: { from: at, to: at } }
}

/** The two things a person must not be able to scroll past. */
function footOf(view: AwayView, ctx: PanelContext, inner: number): Line[] {
  const { skin } = ctx
  const row = () => new Row(inner, skin, ctx.pointer)
  const lines: Line[] = [blank(inner)]
  for (const said of wrap(view.agents, inner - 3)) {
    lines.push(row().space().text(said, skin.hint).build())
  }
  if (view.problem !== null) {
    lines.push(row().space().text(`▲ ${view.problem}`, skin.bad).build())
  }
  lines.push(
    row()
      .right((r) =>
        r
          .button(
            'Disconnect everything',
            { kind: 'control', id: AWAY_CONTROLS.all },
            view.devices.length === 0 ? 'off' : 'danger',
          )
          .space(),
      )
      .build(),
  )
  return lines
}

function deviceLine(device: AwayDevice, chosen: boolean, ctx: PanelContext, inner: number): Line {
  const { skin } = ctx
  const reads = device.reads.length === 0 ? 'names and counts' : device.reads.join(', ')
  return new Row(inner, skin, ctx.pointer)
    .space()
    .text(chosen ? '›' : ' ', skin.signal)
    .space()
    .text(device.label || 'a device', skin.you)
    .space()
    .text(device.live ? '● now' : '○', device.live ? skin.done : skin.hint)
    .space()
    .text(`${ctx.date(device.pairedAt)} · ${reads}`, skin.hint)
    .right((r) =>
      r.chip('×', { kind: 'control', id: `${AWAY_CONTROLS.revoke}${device.id}` }, 'danger').space(),
    )
    .build()
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
