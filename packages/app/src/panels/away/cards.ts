import { sameTarget, shift, type Target } from '../../hits.ts'
import { blank, Row } from '../../ui.ts'
import { widthOf } from '../../width.ts'
import type { PanelContext } from '../context.ts'
import type { Line } from '../frame.ts'
import { AWAY_CONTROLS, AWAY_LABELS } from './state.ts'
import type { AwayDevice, AwayView } from './view.ts'

// The two things on the away panel that are about one device: the card a
// device at the door is drawn as, and a paired device's own block in the list.
//
// Pure, like the panel drawing that composes them.
//
// **The card is the one thing on the panel that is a question**, so it is
// drawn as one: a frame of its own in the waiting tone, the device in its own
// words and where it came from in plain ones, what letting it in grants as
// pills, the time left as a bar, and the two answers as the window's own pair
// — `go` and `danger` — with the key each is on drawn as a key cap beside it
// rather than glued to the front of its word. `a let it in` on a grey block was
// read as three words, one of them a letter nobody could place.

/** What every device reads, granted or not. */
const BASE = ['names', 'states', 'counts'] as const

/** The column a block's lead word takes, so what follows lines up under it. */
const LEAD = 9

/**
 * The device at the door, as a card: who, from where, what it will get, how
 * long is left, and Approve and Refuse.
 *
 * `keys` is whether the panel's own keys answer it here — the panel's do, the
 * Settings page's walk the settings — so a key cap is never drawn for a key
 * that would not do what it says.
 */
export function askingCard(
  asking: NonNullable<AwayView['asking']>,
  ctx: PanelContext,
  inner: number,
  keys: boolean,
): Line[] {
  const { skin } = ctx
  const edge = skin.waiting
  const room = Math.max(12, inner - 6)
  const row = () => new Row(room, skin, ctx.pointer)
  const framed = (content: Line): Line => ({
    text: ` ${edge('│')} ${content.text} ${edge('│')} `,
    hits: shift(content.hits, 0, 3),
  })
  const title = ' A DEVICE WANTS TO PAIR '
  const run = Math.max(0, room + 1 - widthOf(title))
  const lines: Line[] = [
    { text: ` ${edge('╭─')}${skin.waiting(title)}${edge(`${'─'.repeat(run)}╮`)} `, hits: [] },
  ]

  // Who, and from where in words; the address beside them where the words are
  // not this machine, because a stranger's address is the thing to check.
  const name = asking.label || 'a device'
  const from =
    asking.address === '' ? `from ${asking.from}` : `from ${asking.from} · ${asking.address}`
  if (widthOf(name) + 2 + widthOf(from) <= room) {
    lines.push(framed(row().text(name, skin.you).space(2).text(from, skin.hint).build()))
  } else {
    lines.push(framed(row().text(name, skin.you).build()))
    for (const part of wrap(from, room)) lines.push(framed(row().text(part, skin.hint).build()))
  }

  // What a yes grants, said before it is pressed: everything — the owner's
  // call, opt-out rather than opt-in (`EVERYTHING`, `wire/web-grants.ts`) —
  // and where any of it is taken back, which is that device's own row.
  const back = '· untick any of it in its row below'
  const gets = [
    pill('full access'),
    { width: widthOf(back), draw: (r: Row) => r.text(back, skin.hint) },
  ]
  for (const one of flow('will get', gets, room, ctx, 1)) lines.push(framed(one))

  // The time left as a bar, so it can be read from across the room, and as a
  // figure, so it can be read without colour.
  const said = left(asking.secondsLeft)
  const share = asking.seconds <= 0 ? 0 : asking.secondsLeft / asking.seconds
  const tone = asking.secondsLeft <= 10 ? skin.bad : skin.waiting
  const cells = Math.max(4, room - widthOf(said) - 1)
  lines.push(framed(row().meter(share, cells, tone).space().text(said, tone).build()))
  lines.push(framed(blank(room)))

  const allow: Target = { kind: 'control', id: AWAY_CONTROLS.allow }
  const deny: Target = { kind: 'control', id: AWAY_CONTROLS.deny }
  // Key caps only where there is room for them as well as both answers: an
  // answer is never what gets cut, and a cap is the half that can go.
  const capped = keys && room >= 40
  const answers = row()
  if (capped) answers.keys([ctx.bindings.approve ?? 'a'], allow).space()
  answers.button('Approve', allow, 'go').space(3)
  if (capped) answers.keys([ctx.bindings.deny ?? 'd'], deny).space()
  answers.button('Refuse', deny, 'danger')
  lines.push(framed(answers.build()))
  lines.push({ text: ` ${edge(`╰${'─'.repeat(room + 2)}╯`)} `, hits: [] })
  return lines
}

/**
 * One paired device: its name and whether it is connected now, with Sign out
 * at the right; what it is and where it paired from; what it reads, as pills;
 * and what it may do, a box each, ticked where a person here granted it.
 *
 * **A box and not a coloured chip**, because a chip whose colour said which
 * way pressing it went — green for *grant*, red for *take back* — was read the
 * other way round: green as *allowed*. A ticked box says what is true in a
 * screenshot, a pipe and `NO_COLOR` alike, and pressing it does the obvious
 * thing.
 */
export function deviceLines(
  device: AwayDevice,
  chosen: boolean,
  view: Pick<AwayView, 'acting' | 'talking' | 'configuring'>,
  ctx: PanelContext,
  inner: number,
): Line[] {
  const { skin } = ctx
  const row = () => new Row(inner, skin, ctx.pointer)
  const revoke: Target = { kind: 'control', id: `${AWAY_CONTROLS.revoke}${device.id}` }
  const out = (r: Row) => r.chip(AWAY_LABELS[AWAY_CONTROLS.revoke], revoke, 'harm').space()
  const head = row()
    .space()
    .text(chosen ? '›' : ' ', skin.signal)
    .text(device.live ? '●' : '○', device.live ? skin.done : skin.hint)
    .space()
    .text(device.label || 'a device', skin.you)
    .space(2)
    .text(device.live ? 'connected now' : 'not connected', device.live ? skin.done : skin.hint)
  const lines: Line[] = []
  // **Sign out is never what gets cut**: where the name leaves it no room, it
  // takes a line of its own rather than being dropped with the right group.
  const one = head.right(out).build()
  if (one.hits.some((hit) => sameTarget(hit.target, revoke))) {
    lines.push(one)
  } else {
    lines.push(head.build(), row().right(out).build())
  }

  const kind = kindOf(device.label)
  const about = [kind, `from ${device.from}`, `paired ${ctx.date(device.pairedAt)}`]
  for (const part of wrap(about.filter(Boolean).join(' · '), inner - 5)) {
    lines.push(row().space(4).text(part, skin.hint).build())
  }

  // What it reads, beyond what every device does. The two reading grants that
  // have a box of their own are said by the box, not twice.
  const boxed: readonly string[] = ['lanes', 'settings']
  const reads = [...BASE, ...device.reads.filter((one) => !boxed.includes(one))]
  lines.push(...indented(flow('reads', reads.map(pill), inner - 4, ctx, 1)))
  lines.push(...indented(flow('may', mayOf(device, view), inner - 4, ctx)))
  return lines
}

/**
 * The boxes a device's row offers, in the order a person would weigh them:
 * changing the work, then talking, then settings, then what it may see.
 *
 * **Only where the setting is on** for the four that do something: with it off
 * there is no route a grant could reach, so the box is not drawn rather than
 * drawn and refused. The two that grant reading are always drawn — nothing
 * they grant can change anything.
 */
function mayOf(
  device: AwayDevice,
  view: Pick<AwayView, 'acting' | 'talking' | 'configuring'>,
): Piece[] {
  const boxes: [string, boolean][] = [
    [AWAY_CONTROLS.everything, device.full],
    ...(view.acting
      ? ([
          [AWAY_CONTROLS.act, device.mayAct],
          [AWAY_CONTROLS.agents, device.mayStop],
          [AWAY_CONTROLS.projects, device.mayClose],
        ] as [string, boolean][])
      : []),
    ...(view.talking ? ([[AWAY_CONTROLS.talk, device.mayTalk]] as [string, boolean][]) : []),
    ...(view.configuring
      ? ([[AWAY_CONTROLS.configure, device.mayConfigure]] as [string, boolean][])
      : []),
    [AWAY_CONTROLS.see, device.maySee],
    [AWAY_CONTROLS.settings, device.mayReadSettings],
  ]
  return boxes.map(([control, on]) => {
    const label = AWAY_LABELS[control as keyof typeof AWAY_LABELS]
    const target: Target = { kind: 'control', id: `${control}${device.id}` }
    return { width: 2 + widthOf(label), draw: (r: Row) => r.check(on, label, target) }
  })
}

/** Something laid along a line: how wide it is, and how to draw it. */
interface Piece {
  width: number
  draw: (r: Row) => Row
}

/** A word as a pill: painted, and not a control. */
function pill(word: string): Piece {
  return { width: widthOf(word) + 2, draw: (r: Row) => r.badge(word) }
}

/**
 * A lead word and then pieces, `gap` columns apart, onto as many lines as they
 * take: a line ends before a piece that would not fit, and nothing is cut. A
 * pill is padded already, so pills sit one apart and boxes two.
 */
function flow(
  lead: string,
  pieces: readonly Piece[],
  width: number,
  ctx: PanelContext,
  gap = 2,
): Line[] {
  const { skin } = ctx
  const lines: Line[] = []
  let r = new Row(width, skin, ctx.pointer).text(lead.padEnd(LEAD), skin.hint)
  let used = LEAD
  let fresh = true
  for (const piece of pieces) {
    if (!fresh && used + gap + piece.width > width) {
      lines.push(r.build())
      r = new Row(width, skin, ctx.pointer).space(LEAD)
      used = LEAD
      fresh = true
    }
    if (!fresh) r.space(gap)
    piece.draw(r)
    used += (fresh ? 0 : gap) + piece.width
    fresh = false
  }
  lines.push(r.build())
  return lines
}

/** Lines drawn four columns narrower, moved four in: under a device's name. */
function indented(lines: readonly Line[]): Line[] {
  return lines.map((line) => ({ text: `    ${line.text}`, hits: shift(line.hits, 0, 4) }))
}

/**
 * What kind of device a label names, where it says. The label is what the
 * page suggested from the browser (`deviceWord`), or what somebody typed over
 * it, so a name that says nothing about a kind gets none rather than a guess.
 */
export function kindOf(label: string): string | null {
  if (/iphone|android|phone|pixel|galaxy/i.test(label)) return 'phone'
  if (/ipad|tablet/i.test(label)) return 'tablet'
  if (/\bmac|windows|linux|chromebook|laptop|desktop|\bpc\b/i.test(label)) return 'computer'
  return null
}

/** How long is left, in the window's own plain words. */
export function left(seconds: number): string {
  if (seconds <= 0) return 'expired'
  if (seconds < 60) return `${seconds}s left`
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} left`
}

/**
 * A sentence as lines that fit, broken on spaces.
 *
 * Wrapped rather than cut, because the sentences on this panel are the ones
 * that may never say only the comfortable half: a LAN warning truncated at
 * *anybody on the same* is a warning that stopped being one.
 */
export function wrap(said: string, width: number): string[] {
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
