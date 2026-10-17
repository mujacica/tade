import { duration, KEYS_TO_REMOTE, TALK_TO_REMOTE } from '@tade/core'
// Type-only, so the pure panel model never loads what makes a checklist.
import type { Checklist } from '@tade/workbench/carry'
import type { Hit } from '../../hits.ts'
import { lookSaid, type MachineAbout } from '../../machine-there.ts'
import type { Machine } from '../../machines.ts'
import type { Look } from '../../skin.ts'
import { blank, Row } from '../../ui.ts'
import { cap, padTo, withFocus, wrapTo } from '../cells.ts'
import type { PanelContext } from '../context.ts'
import { type PanelOutcome, stay } from '../outcome.ts'
import type { SettingsPanel } from './state.ts'

// The Remotes page: each other machine's Tade this one is an owner of, and
// what became of this one's setup there — what was carried and is kept in
// step, what applies only when Tade next starts there, what that machine
// changed itself, what waits on a press, whether its tab here takes a message,
// and each harness's own sign-in there (`@tade/workbench/carry`'s checklist,
// the one `tade remote add` ends with).
//
// **And how each one stands as a machine** (`connection`): when it was last
// heard from and what asking it costs there and back, the Tade it runs, its
// public name's certificate, its own problems and warnings, and its schedules
// and watches with their last looks — out of what it said asked as its owner
// (`machine-there.ts`). A machine that stopped answering is drawn as of its
// last answer, never as one with nothing wrong.
//
// **And moving a project there** (`moves`, REMOTE-TADE.md §9.2): each project
// here with the one press that is next — open it there, hand its work over,
// close it here — which is the whole guided flow, because the steps are only
// ever taken in that order and each is a press somebody can see the result of.
//
// A category only while there is a remote: a page that says "none" to
// everybody who never added one is a page in every picture of Settings.

/** The Remotes page's id among the categories. */
export const REMOTES = 'remotes'

/** One remote, as the page draws it. */
export interface RemoteShown {
  name: string
  /** Where ssh reaches it. */
  address: string
  /** How its link stands, in a few words: `linked`, `down · …`, `signed out there · …`. */
  link: string
  live: boolean
  /** The last carry's checklist, or null before anything answered. */
  list: Checklist | null
  /** When that answer came, in this machine's clock. */
  at: number | null
  /** A carry or a press is under way. */
  busy: boolean
  /** The machine as this window folds it — its link, its detail — or null before anything was held. */
  machine: Machine | null
  /** Each project here, as moving it to this machine stands (`wire/moves.ts`). */
  moves?: readonly ProjectMove[]
}

/** One project here, as moving it to one machine stands: what it says, and the one press that is next. */
export interface ProjectMove {
  project: string
  /** Where it is there, and what of it is still here. */
  said: string
  /** Open it there, hand its work over, or close it here — or nothing while a press is under way. */
  next: 'open' | 'hand' | 'close' | null
}

/** What each step's press says, and what closing says between its two presses. */
const MOVE_LABELS = {
  open: (machine: string) => `Open it on ${machine}`,
  hand: () => 'Hand its work over',
  close: () => 'Close it here…',
} as const

/** Said between the two presses that close a project here, because that is the one that takes it away. */
export const CLOSE_AFTER_MOVE =
  'Closing keeps everything here — the folder, its branches, its tasks and their conversations — and opening the same path again brings it all back.'

/**
 * One thing that can be pressed on the page: `remote:<verb>:<remote>:<rest>`.
 * `keys` is asked twice, because it sends credentials to another machine, and
 * `talk` too, because it lets what is typed elsewhere reach a model there.
 */
export interface RemoteAction {
  id: string
  label: string
  remote: string
  /** What it says between the two presses, where it is asked twice. */
  again?: string
}

/** The presses asked twice: what each means is said between the two. */
const TWICE: readonly string[] = ['keys', 'talk', 'move-close']

/** The account a sign-in is for, as an id carries it: empty for the harness's own. */
function signInId(remote: string, one: { harness: string; account: string | null }): string {
  return `remote:sign-in:${remote}:${one.harness}:${one.account ?? ''}`
}

/** Everything on the page the keyboard can be on, in drawing order. */
export function remoteActions(remotes: readonly RemoteShown[]): RemoteAction[] {
  const actions: RemoteAction[] = []
  for (const remote of remotes) {
    const list = remote.list
    const at = remote.name
    for (const one of list?.theirs ?? []) {
      actions.push({
        id: `remote:ours:${at}:${one.what}`,
        label: 'Send this machine’s',
        remote: at,
      })
    }
    if ((list?.waiting.length ?? 0) > 0 && list?.unreached === null) {
      actions.push({
        id: `remote:keys:${at}`,
        label: 'Send them…',
        remote: at,
        again: 'Press again to send',
      })
    }
    if (list?.talk === 'off' && list.unreached === null) {
      actions.push({
        id: `remote:talk:${at}`,
        label: 'Turn it on…',
        remote: at,
        again: 'Press again to turn on',
      })
    }
    for (const one of list?.signIns ?? []) {
      if (one.told && !one.signedIn) {
        actions.push({ id: signInId(at, one), label: 'Sign in…', remote: at })
      }
    }
    for (const one of remote.moves ?? []) {
      if (one.next === null) continue
      actions.push({
        id: `remote:move-${one.next}:${at}:${one.project}`,
        label: MOVE_LABELS[one.next](at),
        remote: at,
        ...(one.next === 'close' ? { again: 'Press again to close it here' } : {}),
      })
    }
    actions.push({ id: `remote:again:${at}`, label: 'Carry again', remote: at })
  }
  return actions
}

/** Carry out a press, asking twice for the ones that send keys or turn talking on. */
export function remoteChoice(panel: SettingsPanel, id: string): PanelOutcome {
  const twice = TWICE.some((verb) => id.startsWith(`remote:${verb}:`))
  if (twice && panel.confirm !== id) {
    return stay({ ...panel, confirm: id, saved: null, error: null })
  }
  return { panel: { ...panel, confirm: null }, submit: true, choice: id }
}

/** The page: one block per remote, each its checklist and the presses beside it. */
export function drawRemotes(
  panel: SettingsPanel,
  ctx: PanelContext,
  form: number,
  body: { text: string; hits: Hit[] }[],
  keepInView: (from: number, to: number) => void,
): void {
  const { skin } = ctx
  const remotes = ctx.remotes ?? []
  const actions = remoteActions(remotes)
  const focused = panel.focus === 'form' ? (actions[panel.row]?.id ?? null) : null
  const keys = withFocus(ctx.pointer, focused)
  const plain = (text: string) => text
  const named = Math.min(16, Math.max(8, form - 44))

  const say = (text: string, tone = skin.hint, indent = 3, lines = 3) => {
    for (const line of wrapTo(text, Math.max(8, form - indent - 1), lines)) {
      body.push(new Row(form, skin).space(indent).text(line, tone).build())
    }
  }
  /** A labelled line: a word for what it is, then what it says. */
  const line = (label: string, text: string, tone = plain) =>
    body.push(
      new Row(form, skin)
        .space(3)
        .text(padTo(cap(label, named), named), skin.label)
        .text(cap(text, Math.max(4, form - named - 4)), tone)
        .build(),
    )
  const buttons = (ids: readonly string[], look: Look = 'rest') => {
    const mine = actions.filter((action) => ids.includes(action.id))
    if (mine.length === 0) return
    const row = new Row(form, skin, keys).space(3 + named)
    for (const action of mine) {
      const label = panel.confirm === action.id ? (action.again ?? action.label) : action.label
      row.button(label, { kind: 'control', id: action.id }, look).space()
    }
    if (focused !== null && mine.some((action) => action.id === focused)) {
      keepInView(body.length, body.length)
    }
    body.push(row.build())
  }

  for (const remote of remotes) {
    const from = body.length
    const list = remote.list
    const at = remote.name
    body.push(
      new Row(form, skin)
        .space()
        .text(cap(at, Math.max(4, named)), skin.brand)
        .space(2)
        .text(cap(remote.link, form - named - 5), remote.live ? skin.done : skin.waiting)
        .build(),
    )
    const where = [
      `ssh ${remote.address}`,
      list?.machine ? `it calls itself ${list.machine}` : null,
      remote.busy ? 'carrying…' : remote.at === null ? null : `carried ${ctx.date(remote.at)}`,
    ].filter(Boolean)
    say(where.join(' · '))
    connection(remote, ctx, line, (text, tone) => say(text, tone, 3 + named, 3))
    if (list === null) {
      say(remote.live ? 'nothing carried yet' : 'carried once it answers', skin.hint)
    } else if (list.unreached !== null) {
      say(`○ ${list.unreached}`, skin.waiting)
    } else {
      line('Carried', `${list.carried.length} settings and files, kept in step`, skin.done)
    }
    for (const one of list?.theirs ?? []) {
      const values =
        one.theirs !== null && one.ours !== null ? ` — there ${one.theirs} · here ${one.ours}` : ''
      line('Changed there', `${one.what}${values}`, skin.waiting)
      buttons([`remote:ours:${at}:${one.what}`])
    }
    for (const one of list?.refused ?? []) line('Not taken', `${one.what}: ${one.why}`, skin.hint)
    if (list !== null && list.sent.length > 0) line('Sent', list.sent.join(', '), skin.done)
    if (list !== null && list.nextStart.length > 0) {
      line('Next start', list.nextStart.join(', '), skin.hint)
    }
    if (list !== null && list.waiting.length > 0) {
      line('On a press', list.waiting.join(', '), skin.waiting)
      buttons([`remote:keys:${at}`], 'attention')
      // Said where somebody is deciding: once they have pressed, before the
      // press that sends. Whole, however many lines that takes — the way out
      // is its last clause, so any cap drops it, and the page scrolls.
      if (panel.confirm === `remote:keys:${at}`) {
        say(KEYS_TO_REMOTE, skin.hint, 3 + named, Number.POSITIVE_INFINITY)
      }
    }
    // Listed until it is on: what is typed in its tab here goes nowhere until then.
    if (list?.talk === 'off') {
      line('Talk to Tade', 'off there: its tab here takes no message', skin.waiting)
      buttons([`remote:talk:${at}`], 'attention')
      if (panel.confirm === `remote:talk:${at}`) say(TALK_TO_REMOTE, skin.hint, 3 + named, 5)
    } else if (list?.talk === 'turning on') {
      line('Talk to Tade', 'turned on there, on your press', skin.done)
    }
    for (const one of list?.signIns ?? []) {
      const who = one.account === null ? one.harness : `${one.harness} · ${one.account}`
      const mark = one.signedIn ? `● ${one.lasts}` : one.told ? '○ not signed in' : `· ${one.lasts}`
      line(who, mark, one.signedIn ? skin.done : one.told ? skin.waiting : skin.hint)
      buttons([signInId(at, one)])
    }
    if (list !== null && list.here.length > 0) {
      line('This machine’s', list.here.map((one) => one.what).join(', '), skin.hint)
    }
    for (const one of remote.moves ?? []) {
      const tone = one.next === 'close' ? skin.done : one.next === null ? skin.waiting : skin.hint
      line(`Move ${one.project}`, one.said, tone)
      if (one.next === null) continue
      const id = `remote:move-${one.next}:${at}:${one.project}`
      buttons([id])
      if (panel.confirm === id) say(CLOSE_AFTER_MOVE, skin.hint, 3 + named, 3)
    }
    buttons([`remote:again:${at}`])
    body.push(blank(form))
    if (focused !== null && focused.split(':')[2] === at) keepInView(from, body.length - 1)
  }
}

/** How many of a machine's problems, warnings and schedules the page lists before it counts the rest. */
const LISTED = 4

/**
 * How one remote stands as a machine: heard from, the round trip, its Tade, its
 * public name, its problems and warnings, its schedules and their last looks.
 * Every figure is as of its last answer, and says so while its link is down.
 */
function connection(
  remote: RemoteShown,
  ctx: PanelContext,
  line: (label: string, text: string, tone?: (text: string) => string) => void,
  /** Wrapped under a line's own column, as much of it as three rows hold. */
  under: (text: string, tone: (text: string) => string) => void,
): void {
  const { skin } = ctx
  const machine = remote.machine
  if (machine === null) return
  const detail = machine.detail
  const about = detail.about
  const asOf = machine.asOf === null ? null : ctx.now - machine.asOf
  const heard =
    asOf === null
      ? 'not heard from yet'
      : machine.link === 'live'
        ? `${duration(asOf)} ago`
        : `as of ${ctx.date(machine.asOf ?? 0)}, ${duration(asOf)} ago`
  const trip =
    about?.roundTrip === null || about === null ? '' : ` · ${about.roundTrip} ms there and back`
  line('Heard', `${heard}${trip}`, machine.link === 'live' ? skin.done : skin.waiting)
  if (about === null) {
    if (detail.aboutSaid !== null) under(detail.aboutSaid, skin.hint)
    return
  }
  const stale = machine.link === 'live' ? '' : ` · as of ${ctx.date(about.at)}`
  line(
    'Tade',
    `${about.version}${about.newer ? ` · ${about.newer}` : ''}${stale}`,
    about.newer ? skin.waiting : (text) => text,
  )
  if (detail.aboutSaid !== null) under(detail.aboutSaid, skin.hint)
  if (about.public !== null) publicLines(about, line, under, skin)
  const problems = [...about.problems.map((one) => one.said), ...detail.warnings]
  line(
    'Problems',
    problems.length === 0 ? 'none it knows of' : `${problems.length}`,
    problems.length === 0 ? skin.done : skin.waiting,
  )
  for (const said of problems.slice(0, LISTED)) under(`· ${said}`, skin.hint)
  if (problems.length > LISTED) under(`and ${problems.length - LISTED} more`, skin.hint)
  const schedules = about.schedules
  line('Schedules', schedules.length === 0 ? 'none' : `${schedules.length}`, skin.hint)
  for (const one of schedules.slice(0, LISTED)) {
    const look = one.watch?.looks[0]
    const mark = one.paused ? '‖' : one.kind === 'watch' ? '◎' : '↻'
    const said = [`${mark} ${one.name} in ${one.project}`, one.when, lookSaid(one, ctx.date)]
    under(said.filter(Boolean).join(' · '), look?.problem ? skin.waiting : skin.hint)
  }
  if (schedules.length > LISTED) under(`and ${schedules.length - LISTED} more`, skin.hint)
}

/** Its public name, and what the certificate look and the version said of it, loudest first. */
function publicLines(
  about: MachineAbout,
  line: (label: string, text: string, tone?: (text: string) => string) => void,
  under: (text: string, tone: (text: string) => string) => void,
  skin: PanelContext['skin'],
): void {
  const shown = about.public
  if (shown === null) return
  const loud = shown.health.some((one) => one.loud) || !shown.up
  line(
    'Public name',
    `${shown.name}${shown.up ? '' : ' · not listening'}`,
    loud ? skin.waiting : skin.done,
  )
  for (const one of shown.health) under(one.said, one.loud ? skin.waiting : skin.hint)
}
