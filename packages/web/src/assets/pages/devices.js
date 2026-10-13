// This device and the others: its own credential, its notifications, and every
// device that has been let in.

import { el, into, keyed, skeleton, textIn } from '../dom.js'
import { ageSaid, count, untilSaid } from '../figures.js'
import { NOT_OFFERED, OFF, ON, PUSH_SAID, pushState, subscribe, unsubscribe } from '../push.js'
import { dl, dlIn, sayIn, section } from '../rows.js'
import { troubleOf, UNKNOWN_TROUBLE } from '../trouble.js'
import { answerIn, panel } from '../ui.js'

/* ── this device, and the others ───────────────────────────────────────────── */

/**
 * What this browser's own credential is, and every device that has been let in.
 *
 * **The whole list is here on purpose.** Nothing on this machine is contained —
 * an agent runs as you and can append to the paired-device list — so seeing
 * every device there is, is the mitigation, and disconnecting one needs no
 * network at all. That is said here because this is the page somebody reads it
 * on, and it is the page's own sentence about its own list rather than a second
 * copy of the domain's.
 */
export function devicesScreen(ctx) {
  const node = el('div')
  // The page bar, with signing this device out at its end: an act on the
  // page's own subject, where every screen keeps what may be done here.
  const top = section('DEVICES', { top: true })
  const out = el('button', {
    class: 'press quietly small',
    text: 'Sign this device out',
    attrs: { type: 'button' },
  })
  into(top.tools, out)
  const mine = section('THIS DEVICE')
  const facts = dl()
  const noSession = el('p', { class: 'unknown' })
  const said = el('p', { attrs: { role: 'status' } })
  into(mine.body, said, facts, noSession)

  // **The notifications control, and it is on this screen because this is the
  // screen about this device.** The permission belongs to the phone, not to
  // the machine, and `pushState` reads the phone's own answer rather than a
  // row in a file — so a permission somebody took back in their browser's
  // settings draws as blocked here instead of as on.
  const telling = section('NOTIFICATIONS', {
    hint: 'A count of what wants you and nothing else — no project, no task, no title — unless details are turned on at the machine. Relayed by your browser’s push service, which cannot read it; sent only while Tade’s window is open and the machine awake, and never caught up.',
  })
  const tellingSaid = el('p', { attrs: { role: 'status' } })
  const tell = el('button', { class: 'press' })
  into(telling.body, tellingSaid, tell)
  /** What the *phone* says, which is the one thing this screen cannot derive. */
  let standing = null
  /**
   * What the machine was offering when the phone was last asked.
   *
   * Kept so that `update` can tell *the machine changed its mind* from *this
   * is the fourth paint of the same second*: asking the browser costs a
   * `getRegistration` and a `getSubscription`, which is not a thing to do four
   * times a second, and not asking at all would leave the control absent for
   * as long as the screen stays open after somebody turns notifications on.
   */
  let asked = null
  const askPhone = async () => {
    asked = JSON.stringify(ctx.shell()?.notifying ?? null)
    standing = await pushState(ctx.shell())
    drawTelling()
  }
  const drawTelling = () => {
    // Hidden rather than drawn as unavailable while the machine is not
    // offering it: a control for a thing nobody turned on costs a section to
    // say nothing. The same decision the window makes about its own away
    // panel.
    telling.node.hidden = standing === null || standing === NOT_OFFERED
    textIn(tellingSaid, standing === null ? 'asking…' : (PUSH_SAID[standing] ?? ''))
    tell.hidden = standing !== ON && standing !== OFF
    textIn(tell, standing === ON ? 'Stop telling this device' : 'Tell this device')
  }
  drawTelling()
  void askPhone()

  tell.addEventListener('click', async () => {
    tell.disabled = true
    // **The press is what raises the browser's prompt**, and it has to be this
    // handler: a prompt that is not a direct answer to a gesture is refused by
    // every browser that implements this, silently.
    standing = standing === ON ? await unsubscribe(ctx.ask) : await subscribe(ctx.shell(), ctx.ask)
    tell.disabled = false
    drawTelling()
  })

  const others = section('PAIRED', {
    hint: 'Every device let in is listed here; disconnecting one is done at the machine and needs no network. Nothing on that machine is contained: anything there runs as you.',
  })
  const list = panel('ul', 'rows')
  const loading = skeleton(2)
  into(others.body, list, loading)
  // The device list is not on the stream — letting a phone in or disconnecting
  // one is not a projection change — so it is asked for when this screen
  // opens, which is the only moment anybody is reading it.
  void ctx.freshen()

  out.addEventListener('click', async () => {
    out.disabled = true
    const who = ctx.session()
    if (who === null) {
      textIn(said, 'this device has no session to sign out')
      out.disabled = false
      return
    }
    const answer = await ctx.ask('DELETE', `/api/devices/${encodeURIComponent(who.device)}`, {})
    if (answer.status === 200) {
      ctx.go('/pair', { replace: true })
      return
    }
    out.disabled = false
    answerIn(said, '', troubleOf(answer) ?? UNKNOWN_TROUBLE)
  })

  into(node, top.node, mine.node, telling.node, others.node)

  return {
    node,
    update(view) {
      const who = ctx.session()
      const until = who === null ? null : untilSaid(who.until, view.asOf)
      dlIn(facts, [
        ['this device', who === null ? null : who.label],
        ['may read', who === null ? null : readsSaid(who.reads)],
        ['may do', who === null ? null : who.scopes.join(', ')],
        ['session runs out', until === null ? null : `in ${until}`],
      ])
      sayIn(noSession, who === null ? '— could not read this device’s own session' : null)
      // The machine's half arrives on `/api/devices`, which `freshen` asks
      // again when this screen opens — so somebody who turns notifications on
      // at the machine and reloads the phone gets the control, and nobody
      // pays for a round trip per paint.
      if (asked !== JSON.stringify(ctx.shell()?.notifying ?? null)) void askPhone()
      const rows = ctx.devices()
      loading.hidden = rows !== null
      keyed(
        list,
        rows ?? [],
        (one) => one.device,
        createDeviceRow,
        (one, row) => fillDeviceRow(one, row, view),
      )
      textIn(others.figure, rows === null ? '' : count(rows.length))
      textIn(top.figure, rows === null ? '' : count(rows.length))
    },
  }
}

/** What a device was granted, in words, with the floor said rather than left blank. */
function readsSaid(reads) {
  return reads.length === 0 ? 'names and counts' : reads.join(', ')
}

function createDeviceRow() {
  const node = el('li')
  const body = el('div')
  const name = el('span', { class: 'name' })
  const aside = el('span', { class: 'aside' })
  into(body, el('span', { class: 'glyph', text: '⌸' }), name, aside)
  return into(node, body)
}

function fillDeviceRow(node, device, view) {
  const [body] = node.children
  const [, name, aside] = body.children
  textIn(name, `${device.label}${device.you ? ' · this one' : ''}`)
  const age = ageSaid(device.pairedAt, view.asOf, view.frozen)
  textIn(aside, age === null ? '' : `paired ${age} ago`)
}
