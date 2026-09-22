import { visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import type { Hit } from '../../hits.ts'
import { blank, type Pointer, Row } from '../../ui.ts'
import { cap, padTo } from '../cells.ts'
import type { PanelContext } from '../context.ts'
import { type ExtensionEntry, watchControl } from './state.ts'

// Everything the right-hand side of the Extensions page says, as lines.
//
// Apart from the drawing that frames it because it is the longer half: a page
// that says only what something *is* is how an extension with eight tools gets
// taken for the one watch it happens to show.

/**
 * What a command like `npx -y …` does, said once beside it.
 *
 * A reading of what somebody wrote, not a refusal: their command is theirs.
 * The catalogue ships none of these, which is why this only ever appears
 * beside one a person wrote themselves.
 */
export const FETCHES = 'fetches code from the network at every start'

/** What the Extensions panel draws from, and nothing more: the app counts lines with it too. */
export type ExtensionFacts = Pick<
  PanelContext,
  'skin' | 'extensions' | 'written' | 'harnessExtensions' | 'servers' | 'project' | 'date'
>

/** A line of the right-hand side, and whether the control the keyboard is on is on it. */
export interface Told {
  text: string
  hits: Hit[]
  on?: boolean
}

/**
 * Everything the right-hand side says about what you are on: what it is for in
 * the work you do, what it needs, what you can press, what it can be given,
 * every tool with what each is for, and what it offers to watch.
 */
export function extensionBody(
  facts: ExtensionFacts,
  here: ExtensionEntry | null,
  form: number,
  pointer: Pointer,
  focused: string | null,
): Told[] {
  const { skin } = facts
  const lines: Told[] = []
  const row = () => new Row(form, skin, pointer)
  const control = (id: string) => ({ kind: 'control' as const, id })
  const plain = (text: string) => text
  const wrap = (text: string, indent: number, tone: (text: string) => string = skin.hint) => {
    for (const piece of wrapTextWithAnsi(text, Math.max(10, form - indent - 1))) {
      lines.push(row().space(indent).text(piece, tone).build())
    }
  }
  const heading = (title: string, note = '') => {
    const room = Math.max(0, form - visibleWidth(title) - 4)
    lines.push(
      row()
        .space()
        .text(title, skin.label)
        .text(note ? `  ${cap(note, room)}` : '', skin.hint)
        .build(),
    )
  }
  /** Buttons over as many rows as they need, with a blank row between two of them. */
  const buttons = (
    items: readonly { id: string; label: string; look?: 'attention' | 'danger' | 'primary' }[],
  ) => {
    let current = row().space()
    let holds: string[] = []
    let first = true
    const put = () => {
      if (!first) lines.push(blank(form))
      lines.push({ ...current.build(), on: focused !== null && holds.includes(focused) })
      first = false
      holds = []
    }
    for (const item of items) {
      if (current.used + visibleWidth(item.label) + 5 > form && current.used > 1) {
        put()
        current = row().space()
      }
      current.button(item.label, control(item.id), item.look).space()
      holds.push(item.id)
    }
    if (items.length > 0) put()
  }

  if (!here) {
    // Nothing loaded is worth saying; nothing matched is already said at the
    // head, in the words that were typed, and saying it twice on one page is
    // how a page comes to read as padded.
    if (facts.extensions.length === 0) {
      lines.push(row().space().text('No extensions are loaded.', skin.hint).build())
    }
    return lines
  }

  if (here.kind === 'written') {
    wrap('Tools Tade wrote for itself. One you turn on loads at the next start.', 1)
    lines.push(blank(form))
    for (const tool of facts.written) {
      const title = row()
        .space()
        .text(tool.on ? skin.done('●') : skin.hint('○'))
        .space()
        .text(tool.name, tool.on ? skin.you : skin.hint)
        .text(tool.on ? '  on' : '  off', skin.hint)
      title.right((r) =>
        r
          .button('Read', control(`read:${tool.name}`))
          .space()
          .button(
            tool.on ? 'Turn off' : 'Turn on',
            control(`toggle:${tool.name}`),
            tool.on ? undefined : 'primary',
          )
          .space(),
      )
      lines.push({
        ...title.build(),
        on: focused === `read:${tool.name}` || focused === `toggle:${tool.name}`,
      })
      if (tool.why) wrap(tool.why, 3)
      lines.push(blank(form))
    }
    return lines
  }

  if (here.kind === 'harness') {
    wrap('What each harness loads by itself. Listed only — not Tade’s to change.', 1)
    lines.push(blank(form))
    for (const piece of facts.harnessExtensions) {
      lines.push(row().space().text(piece.name).text(`  ${piece.where}`, skin.hint).build())
    }
    return lines
  }

  if (here.kind === 'servers') {
    wrap('Tool servers Tade knows about, none of them on. Turning one on is yours.', 1)
    for (const server of facts.servers) {
      lines.push(blank(form))
      const title = row()
        .space()
        .text('○', skin.hint)
        .space()
        // The room the buttons pinned at the right need, measured before the
        // name is cut: a row that does not fit drops its right-hand group,
        // and the button that turns a server on is not one to lose.
        .text(cap(server.title, Math.max(8, form - (server.install ? 36 : 22))), skin.you)
        .text(`  ${server.name}`, skin.hint)
      title.right((r) => {
        // The line that installs it is run in a lane you are looking at, and
        // never behind a spinner.
        if (server.install) r.button('Install…', control(`install:${server.name}`)).space()
        r.button('Turn on', control(`server:${server.name}`), 'primary').space()
      })
      lines.push({
        ...title.build(),
        on: focused === `server:${server.name}` || focused === `install:${server.name}`,
      })
      wrap(server.description, 3)
      wrap(server.how, 3, skin.hint)
      if (server.needs) wrap(server.needs, 3, skin.waiting)
      if (server.fetches) wrap(FETCHES, 3, skin.waiting)
      if (server.install) wrap(`install: ${server.install}`, 3, skin.hint)
      if (server.note) wrap(server.note, 3, skin.hint)
    }
    return lines
  }

  const view = facts.extensions.find((one) => one.name === here.id)
  if (!view) return lines

  wrap(view.description, 1, plain)
  const trouble = view.state === 'needs setup' || view.state === 'broken'
  if (trouble && view.problem) {
    lines.push(blank(form))
    for (const [index, piece] of wrapTextWithAnsi(view.problem, Math.max(10, form - 4)).entries()) {
      lines.push(
        row()
          .space()
          .text(index === 0 ? '▲' : ' ', view.state === 'broken' ? skin.bad : skin.waiting)
          .space()
          .text(piece, view.state === 'broken' ? skin.bad : skin.waiting)
          .build(),
      )
    }
  }
  if (view.state === 'off') {
    lines.push(blank(form))
    wrap(
      view.source === 'yours'
        ? 'Off, so it was never imported — there is nothing more to say until it is on.'
        : 'Off. Turning it on takes effect at the next start.',
      1,
    )
  }
  if (view.unknownSettings.length > 0) {
    lines.push(blank(form))
    wrap(
      `Not read: extensions.${view.name}.${view.unknownSettings.join(`, extensions.${view.name}.`)}`,
      1,
      skin.bad,
    )
  }

  // What can be done from here, in the order `extensionControls` walks them:
  // what it is for first, and turning it off at the end.
  const items: { id: string; label: string; look?: 'attention' | 'danger' | 'primary' }[] = []
  if (view.configurable && view.state !== 'broken' && view.state !== 'off') {
    items.push({
      id: `setup:${view.name}`,
      label: view.state === 'needs setup' ? 'Set up…' : 'Settings…',
      ...(view.state === 'needs setup' ? { look: 'attention' as const } : {}),
    })
  }
  if (view.state === 'ready') {
    items.push(
      ...view.actions.map((action) => ({
        id: `action:${view.name}:${action.id}`,
        label: action.title,
      })),
    )
  }
  if (view.server?.install && view.state !== 'ready') {
    items.push({ id: `install:${view.server.name}`, label: 'Install…' })
  }
  if (view.folder) items.push({ id: `folder:${view.name}`, label: 'Open folder' })
  if (view.state !== 'broken')
    items.push({ id: `toggle:${view.name}`, label: view.state === 'off' ? 'Turn on' : 'Turn off' })
  if (items.length > 0) {
    lines.push(blank(form))
    buttons(items)
  }

  // What it is for, in the work somebody actually does.
  if (view.workflow.length > 0) {
    lines.push(blank(form))
    heading('HOW IT IS USED')
    for (const line of view.workflow) {
      const pieces = wrapTextWithAnsi(line, Math.max(10, form - 5))
      pieces.forEach((piece, index) => {
        lines.push(
          row()
            .space()
            .text(index === 0 ? '·' : ' ', skin.hint)
            .space()
            .text(piece, plain)
            .build(),
        )
      })
    }
  }

  // Every tool, with what each is for. The header used to say "8 tools" and
  // never which, which is how a page can be read as saying an extension does
  // one thing.
  if (view.tools.length > 0) {
    lines.push(blank(form))
    heading('TOOLS')
    const named = Math.min(22, Math.max(10, Math.floor(form / 3)))
    for (const tool of view.tools) {
      // Who may call it, said only where it is not both: anything that changes
      // something outside a project is the orchestrator's alone.
      const only = tool.for.length === 1 ? `${tool.for[0]} only` : ''
      // The gap the pinned note needs, and the column it ends on: a row that
      // does not fit drops its right-hand group, and a tool whose audience
      // quietly disappeared is worse than one line less of what it does.
      const room = Math.max(4, form - 1 - named - (only ? visibleWidth(only) + 2 : 0))
      const line = row()
        .space()
        .text(padTo(cap(tool.name, named), named), skin.you)
      line.text(cap(tool.summary, room), skin.hint)
      // What the server itself calls it, so a person reading its own
      // documentation can tell which tool this is.
      const theirs = view.server?.theirs[tool.name]
      if (only) line.right((r) => r.text(only, skin.hint).space())
      else if (theirs && theirs !== tool.name) {
        line.right((r) => r.text(theirs, skin.hint).space())
      }
      lines.push(line.build())
    }
  }

  // What it offers to watch: a schedule like any other, once it is on.
  const watches = view.state === 'broken' ? [] : view.watches
  if (watches.length > 0) {
    lines.push(blank(form))
    heading('WATCHES', 'none on until you turn one on')
    for (const watch of watches) {
      const id = watchControl(view.name, watch)
      const every = `  every ${watch.every}`
      const press = id ? (watch.on ? 'Show' : `Watch ${watch.project ?? ''}`) : ''
      // What is pinned at the right, measured before the name is cut: a row
      // that does not fit drops its right-hand group, and the button that
      // turns a watch on is not something to lose to a long title.
      const pinned =
        (watch.on ? visibleWidth(`on in ${watch.project ?? ''}  `) : 0) +
        (press ? visibleWidth(press) + 4 : visibleWidth('open a project to watch it')) +
        2
      const title = row()
        .space()
        .text('◎', watch.on ? skin.done : skin.hint)
        .space()
        .text(cap(watch.title, Math.max(8, form - 3 - visibleWidth(every) - pinned)), skin.you)
        .text(every, skin.hint)
      title.right((r) => {
        if (watch.on) r.text(`on in ${watch.project ?? ''}  `, skin.done)
        if (press) {
          r.button(press, control(id as string))
        } else {
          r.text('open a project to watch it', skin.hint)
        }
        r.space()
      })
      lines.push({ ...title.build(), on: id !== null && id === focused })
      wrap(watch.means, 3)
    }
  }

  // What it can be given, and where each one stands. A credential is one of
  // them, drawn as itself — except where the shell beats it, which is the one
  // thing about a key that cannot be read off the page.
  if (view.options.length > 0) {
    lines.push(blank(form))
    heading(
      'OPTIONS',
      view.configurable ? (view.state === 'needs setup' ? 'Set up…' : 'Settings…') : '',
    )
    const named = Math.min(20, Math.max(8, Math.floor(form / 3)))
    for (const option of view.options) {
      // A variable in the shell wins over what is written, so where there is
      // one that is what is said: the value beside it would not be the one in
      // use. Anything else is what it is, and nothing is a place any more.
      const value =
        option.secret && option.have.startsWith('$')
          ? `from ${option.have}`
          : option.value || (option.secret && view.configurable ? 'not set — Set up…' : 'not set')
      const set = option.value !== '' || (option.secret && option.have !== '')
      lines.push(
        row()
          .space()
          .text(padTo(cap(option.label, named - 1), named))
          .text(cap(value, Math.max(4, form - named - 3)), set ? skin.you : skin.hint)
          .build(),
      )
    }
  }

  // What is true of a server and of nothing else: where it is, when anybody
  // last asked it what it offers, and what of that Tade will not hand on. A
  // server that is off was never connected, so there is none of it to say.
  if (view.server) {
    lines.push(blank(form))
    heading('THE SERVER')
    wrap(view.server.how, 1, skin.hint)
    // When it was asked, as a person reads a time — and as it was written
    // down where that cannot be read, rather than a guess at what it meant.
    const at = Date.parse(view.server.asked ?? '')
    const asked = Number.isNaN(at) ? view.server.asked : facts.date(at)
    wrap(
      view.server.on
        ? asked
          ? `last asked ${asked}`
          : 'never asked what it offers'
        : 'off — never connected',
      1,
      skin.hint,
    )
    if (view.server.fetches) wrap(FETCHES, 1, skin.waiting)
    if (view.server.install) wrap(`install: ${view.server.install}`, 1, skin.hint)
    if (view.server.note) wrap(view.server.note, 1, skin.hint)
    for (const dropped of view.server.dropped) {
      wrap(`${dropped.name} is not offered: ${dropped.why}`, 1, skin.waiting)
    }
  }

  if (view.folder) {
    lines.push(blank(form))
    wrap(`Yours, from ${view.folder}`, 1)
  }
  return lines
}
