import type { Hit } from '../../hits.ts'
import type { Look } from '../../skin.ts'
import { blank, Row } from '../../ui.ts'
import { cap, padTo, withFocus, wrapTo } from '../cells.ts'
import type { PanelContext } from '../context.ts'
import { type SettingsPanel, updateActions } from './state.ts'

// The Updates page: what is installed here, what is current once somebody has
// asked, and the exact command that would move each one forward.

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
export function drawUpdates(
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
      : say(`no command · ${update.cannot}`, skin.hint, indent, 2)

  putButtons(['updates:check'], 'primary')
  // Whether the network has been asked, in as many words as that takes. That
  // it is only ever asked on a press is the button's own promise, and belongs
  // in `tade update --help` rather than under every visit to this page.
  say(look === null ? 'reading this machine…' : look.asked ? 'checked just now' : 'not asked yet')
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
  else say('✓ newest there is', skin.done)
  command(tade.update)
  putButtons(['updates:update:tade', 'updates:reload'], 'attention')
  // What reloading costs is said at the moment of reloading, by the panel that
  // asks — and that panel opens exactly when it would stop something. Four
  // lines of it here, under a button nobody has pressed, is the explanation
  // shown to everybody who came to read a version number.
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
          text: program.need.optional ? '○ not installed · optional' : '▲ not installed',
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
    // Who needs it and why nobody could say what is current are both read
    // under the one program you are on. Said under all of them, a page of
    // seven versions is a page of twenty lines of prose — and the row already
    // says `cannot tell` in the two words that matter.
    if (focused === rowId) {
      say(
        program.need.needed.map((one) => `${one.what}: ${one.why}`).join(' · '),
        skin.hint,
        under,
        2,
      )
      if (look.asked && program.cannotTell && program.install) {
        say(program.cannotTell, skin.hint, under, 2)
      }
    }
    if (!program.need.inUse) say('nothing here needs it', skin.hint, under, 1)
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
