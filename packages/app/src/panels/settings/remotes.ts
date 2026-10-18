import { type ConnectSource, duration, KEYS_TO_REMOTE, TALK_TO_REMOTE } from '@tade/core'
// Type-only, so the pure panel model never loads what makes a checklist.
import type { Checklist } from '@tade/workbench/carry'
import type { Hit } from '../../hits.ts'
import { type ConnectShown, lookSaid, type MachineAbout, type Versus } from '../../machine-there.ts'
import type { Machine } from '../../machines.ts'
import type { Look } from '../../skin.ts'
import { blank, Row } from '../../ui.ts'
import { widthOf } from '../../width.ts'
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
// last answer, never as one with nothing wrong. Under its public name, the
// records that name needs, as that machine's own look found them when this
// page was opened or Look again was pressed (`records`) — always as of when,
// because a look at DNS is a moment.
//
// **And moving a project there** (`moves`, REMOTE-TADE.md §9.2): each project
// here with the one press that is next — open it there, hand its work over,
// close it here — which is the whole guided flow, because the steps are only
// ever taken in that order and each is a press somebody can see the result of.
// Folded under one line per machine, opened on a press: a row for each project
// that machine already holds, and the ones it does not hold under one more
// line of their own, because a row per project here under every machine is a
// page as long as the projects list, most of it work nobody means to move.
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
  /** Its Tade against this machine's (`versusHere`), or null where they are the same. */
  versus?: Versus | null
}

/** One project here, as moving it to one machine stands: what it says, and the one press that is next. */
export interface ProjectMove {
  project: string
  /** That machine holds a project that is this one's repository. */
  there: boolean
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
  /** What a fold's press says while what it opens is open. */
  shut?: string
  /** The folds it is drawn inside: drawn, and walked, only while every one is open. */
  under?: readonly string[]
}

/** The presses asked twice: what each means is said between the two. */
const TWICE: readonly string[] = ['keys', 'talk', 'move-close']

/** A fold on the page: a machine's Move rows, and the projects not on it yet under them. */
const foldOf = (remote: string, what: 'moves' | 'not-there') => `remote:fold:${remote}:${what}`

/** The presses drawn, which are the ones the keyboard walks: none inside a fold that is shut. */
export function remotePresses(
  actions: readonly RemoteAction[],
  panel: SettingsPanel,
): RemoteAction[] {
  return actions.filter((one) => (one.under ?? []).every((fold) => panel.opened.includes(fold)))
}

/** A press on one step of connecting a source on a remote. */
function connectId(remote: string, source: ConnectSource, act: 'make' | 'install'): string {
  return `remote:connect:${remote}:${source}:${act}`
}

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
    if (remote.live && remote.machine?.detail.about?.public != null) {
      const label = remote.machine.detail.recordsLooking ? 'Looking…' : 'Look again'
      actions.push({ id: `remote:records:${at}`, label, remote: at })
      // Each step of connecting each source there that offers one press, in order.
      for (const one of remote.machine.detail.connects) {
        for (const step of one.seen?.steps ?? []) {
          if (step.press === null) continue
          actions.push({
            id: connectId(at, one.source, step.press.act),
            label: step.press.label,
            remote: at,
          })
        }
      }
    }
    // Behind this machine, or behind what its own check says is out: upgraded
    // there by its own `tade host upgrade`, in a terminal over the link.
    const about = remote.machine?.detail.about ?? null
    if (remote.live && about !== null && (remote.versus?.behind === true || about.newer !== null)) {
      actions.push({ id: `remote:upgrade:${at}`, label: 'Upgrade Tade there', remote: at })
    }
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
    const moves = remote.moves ?? []
    if (moves.length > 0) {
      const folded = foldOf(at, 'moves')
      actions.push({ id: folded, label: 'Show', shut: 'Hide', remote: at })
      const move = (one: ProjectMove, under: readonly string[]) => {
        if (one.next === null) return
        actions.push({
          id: `remote:move-${one.next}:${at}:${one.project}`,
          label: MOVE_LABELS[one.next](at),
          remote: at,
          under,
          ...(one.next === 'close' ? { again: 'Press again to close it here' } : {}),
        })
      }
      for (const one of moves.filter((one) => one.there)) move(one, [folded])
      if (moves.some((one) => !one.there)) {
        const notThere = foldOf(at, 'not-there')
        actions.push({
          id: notThere,
          label: 'Open one there…',
          shut: 'Hide',
          remote: at,
          under: [folded],
        })
        for (const one of moves.filter((one) => !one.there)) move(one, [folded, notThere])
      }
    }
    actions.push({ id: `remote:again:${at}`, label: 'Carry again', remote: at })
  }
  return actions
}

/**
 * Carry out a press, asking twice for the ones that send keys or turn talking
 * on; a fold's press opens or shuts it, and is the page's alone.
 */
export function remoteChoice(panel: SettingsPanel, id: string): PanelOutcome {
  if (id.startsWith('remote:fold:')) {
    const open = panel.opened.includes(id)
    const opened = open ? panel.opened.filter((one) => one !== id) : [...panel.opened, id]
    return stay({ ...panel, opened, confirm: null })
  }
  const twice = TWICE.some((verb) => id.startsWith(`remote:${verb}:`))
  if (twice && panel.confirm !== id) {
    return stay({ ...panel, confirm: id, saved: null, error: null })
  }
  return { panel: { ...panel, confirm: null }, submit: true, choice: id }
}

/** A label's column, the gap after it included. */
const LABEL = 16
/** The fewest columns what a label says is given beside it: short of that, it goes under it. */
const BESIDE = 24
/** How far in what a label says goes, where it goes under the label. */
const UNDER = 5
/** The fewest columns anything is wrapped to: past that it goes in less, never past the edge. */
const NARROWEST = 8
/** What a button adds to its label: `[ label ]`. */
const BUTTON = 4

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
  const actions = remotePresses(remoteActions(remotes), panel)
  const focused = panel.focus === 'form' ? (actions[panel.row]?.id ?? null) : null
  const keys = withFocus(ctx.pointer, focused)
  const plain = (text: string) => text
  // What a label says goes beside it where that leaves it room, and under it
  // where it does not — the one shape that runs past the edge at no width.
  const named = LABEL
  const stacked = form - 3 - named < BESIDE
  const deep = stacked ? UNDER : 3 + named
  /** Never so far in that fewer than `NARROWEST` columns are left to say anything in. */
  const inset = (indent: number) => Math.max(1, Math.min(indent, form - NARROWEST - 1))

  const say = (text: string, tone = skin.hint, indent = 3, lines = 3) => {
    const at = inset(indent)
    for (const line of wrapTo(text, Math.max(1, form - at - 1), lines)) {
      body.push(new Row(form, skin).space(at).text(line, tone).build())
    }
  }
  /** A labelled line: a word for what it is, then what it says — beside it, or under it. */
  const line = (label: string, text: string, tone = plain) => {
    const row = new Row(form, skin).space(3)
    if (!stacked) {
      row.text(padTo(cap(label, named - 1), named), skin.label)
      body.push(row.text(cap(text, form - 3 - named - 1), tone).build())
      return
    }
    body.push(row.text(cap(label, form - 4), skin.label).build())
    const at = inset(deep)
    body.push(
      new Row(form, skin)
        .space(at)
        .text(cap(text, form - at - 1), tone)
        .build(),
    )
  }
  /** What a press says now: asked once, a fold open, or its own label. */
  const labelOf = (action: RemoteAction) =>
    panel.confirm === action.id
      ? (action.again ?? action.label)
      : panel.opened.includes(action.id)
        ? (action.shut ?? action.label)
        : action.label
  /** A press, its label cut to the room left, short of the last column as the text is. */
  const press = (row: Row, action: RemoteAction, look: Look) => {
    const label = cap(labelOf(action), Math.max(1, form - row.used - BUTTON - 1))
    row.button(label, { kind: 'control', id: action.id }, look).space()
  }
  const pushed = (row: Row, ids: readonly string[]) => {
    if (focused !== null && ids.includes(focused)) keepInView(body.length, body.length)
    body.push(row.build())
  }
  const buttons = (ids: readonly string[], look: Look = 'rest') => {
    const mine = actions.filter((action) => ids.includes(action.id))
    if (mine.length === 0) return
    const row = new Row(form, skin, keys).space(inset(deep))
    for (const action of mine) press(row, action, look)
    pushed(row, ids)
  }
  /** A name with its one press beside it, or under it where there is no room beside. */
  const pressNamed = (label: string, id: string) => {
    const action = actions.find((one) => one.id === id)
    if (action === undefined) return
    if (stacked) {
      body.push(
        new Row(form, skin)
          .space(3)
          .text(cap(label, form - 4), skin.label)
          .build(),
      )
      buttons([id])
      return
    }
    const row = new Row(form, skin, keys)
      .space(3)
      .text(padTo(cap(label, named - 1), named), skin.label)
    press(row, action, 'rest')
    pushed(row, [id])
  }

  // Said where somebody is deciding: once they have pressed, before the press
  // that does it. Whole, however many lines that takes — the way out is each
  // one's last clause, so any cap drops it, and the page scrolls.
  const between = (sentence: string) => say(sentence, skin.hint, deep, Number.POSITIVE_INFINITY)

  /**
   * Moving its projects there, folded under one line: a row for each project
   * it holds, then the ones it does not under a line of their own, each with
   * the one press that opens it there.
   */
  const moving = (remote: RemoteShown) => {
    const at = remote.name
    const moves = remote.moves ?? []
    if (moves.length === 0) return
    const held = moves.filter((one) => one.there)
    const notThere = moves.filter((one) => !one.there)
    const count = held.length === 0 ? 'none' : `${held.length}`
    const are = held.length > 1 ? 'are' : 'is'
    line('Move projects', `${count} of ${moves.length} here ${are} on ${at}`, skin.hint)
    buttons([foldOf(at, 'moves')])
    if (!panel.opened.includes(foldOf(at, 'moves'))) return
    for (const one of held) {
      const tone = one.next === 'close' ? skin.done : one.next === null ? skin.waiting : skin.hint
      line(`Move ${one.project}`, one.said, tone)
      if (one.next === null) continue
      const id = `remote:move-${one.next}:${at}:${one.project}`
      buttons([id])
      if (panel.confirm === id) between(CLOSE_AFTER_MOVE)
    }
    if (notThere.length === 0) return
    line('Not there yet', notThere.map((one) => one.project).join(', '), skin.hint)
    buttons([foldOf(at, 'not-there')])
    if (!panel.opened.includes(foldOf(at, 'not-there'))) return
    for (const one of notThere) {
      if (one.next === null) line(one.project, one.said, skin.waiting)
      else pressNamed(one.project, `remote:move-${one.next}:${at}:${one.project}`)
    }
  }

  for (const remote of remotes) {
    const from = body.length
    const list = remote.list
    const at = remote.name
    const head = new Row(form, skin)
      .space()
      .text(cap(at, Math.max(4, Math.min(named, form - 2))), skin.brand)
    const tone = remote.live ? skin.done : skin.waiting
    // Beside its name where it fits there whole, and under it where it does not.
    if (stacked && head.used + 2 + widthOf(remote.link) > form - 1) {
      body.push(head.build())
      say(remote.link, tone, 3, 1)
    } else {
      head.space(2)
      body.push(head.text(cap(remote.link, form - head.used - 1), tone).build())
    }
    const where = [
      `ssh ${remote.address}`,
      list?.machine ? `it calls itself ${list.machine}` : null,
      remote.busy ? 'carrying…' : remote.at === null ? null : `carried ${ctx.date(remote.at)}`,
    ].filter(Boolean)
    say(where.join(' · '))
    connection(
      remote,
      ctx,
      line,
      (text, tone) => say(text, tone, deep, 3),
      () => buttons([`remote:upgrade:${at}`]),
      // Under its public name: the records that name needs, and the press that looks again.
      () => {
        records(remote, ctx, line, (text, tone, indent = 0, lines = 4) =>
          say(text, tone, deep + indent, lines),
        )
        buttons([`remote:records:${at}`])
        // And connecting each source there, step by step, each press under its step.
        for (const one of remote.machine?.detail.connects ?? []) {
          connecting(
            remote,
            one,
            ctx,
            line,
            (text, tone) => say(text, tone, deep, 3),
            (act) => buttons(remote.live ? [connectId(at, one.source, act)] : []),
          )
        }
      },
    )
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
      if (panel.confirm === `remote:keys:${at}`) between(KEYS_TO_REMOTE)
    }
    // Listed until it is on: what is typed in its tab here goes nowhere until then.
    if (list?.talk === 'off') {
      line('Talk to Tade', 'off there: its tab here takes no message', skin.waiting)
      buttons([`remote:talk:${at}`], 'attention')
      if (panel.confirm === `remote:talk:${at}`) between(TALK_TO_REMOTE)
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
    moving(remote)
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
  /** What goes under its Tade: the press that upgrades it there. */
  underTade: () => void,
  /** What goes under its public name. */
  underPublic: () => void,
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
  const versus = remote.versus ?? null
  line(
    'Tade',
    `${about.version}${versus ? ` · ${versus.said}` : ''}${about.newer ? ` · ${about.newer}` : ''}${stale}`,
    about.newer || versus?.behind ? skin.waiting : (text) => text,
  )
  underTade()
  if (detail.aboutSaid !== null) under(detail.aboutSaid, skin.hint)
  if (about.public !== null) publicLines(about, line, under, skin)
  underPublic()
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

/**
 * Connecting one source on that machine, as its own page folds it
 * (`githubPage`, `slackPage`, `linearPage`): a line, then each step ticked or
 * not with what it says, and the one press a step offers under it — which
 * asks that machine for the word and opens the source in this machine's
 * browser. A step whose press takes what the source's own page shows the
 * person says where that goes in instead: that machine's own page, and the
 * command that serves it here (`RemoteLink.pages`). Always as of when it said
 * it.
 */
function connecting(
  remote: RemoteShown,
  one: ConnectShown,
  ctx: PanelContext,
  line: (label: string, text: string, tone?: (text: string) => string) => void,
  under: (text: string, tone: (text: string) => string) => void,
  press: (act: 'make' | 'install') => void,
): void {
  const { skin } = ctx
  const detail = remote.machine?.detail
  if (detail === undefined || (detail.about?.public == null && one.seen === null)) return
  const seen = one.seen
  if (seen === null) {
    line(one.title, one.looking ? `asking ${remote.name}…` : 'not asked yet', skin.hint)
    if (one.said !== null) under(one.said, skin.waiting)
    return
  }
  const done = seen.steps.filter((step) => step.done).length
  line(
    one.title,
    `${done} of ${seen.steps.length} done · as of ${ctx.date(seen.at)}`,
    done === seen.steps.length ? skin.done : skin.waiting,
  )
  if (one.said !== null) under(one.said, skin.waiting)
  if (seen.cannot !== null) under(seen.cannot, skin.waiting)
  for (const step of seen.steps) {
    under(
      `${step.done ? '✓' : '○'} ${step.title} — ${step.said}`,
      step.done ? skin.done : skin.hint,
    )
    if (step.pasted && !step.done) {
      under(
        `  pasted into ${remote.name}'s own page, which \`tade remote connect ${remote.name}\` opens here — never carried from here`,
        skin.hint,
      )
    }
    if (step.press !== null) press(step.press.act)
  }
}

/**
 * The records its public name needs, as its own look found them: the line
 * about the zone, then a line per record with what to add or take away under
 * it — written out whole, because a record cut to fit is a record somebody
 * types in wrong at a registrar. Always as of when that look came back.
 */
function records(
  remote: RemoteShown,
  ctx: PanelContext,
  line: (label: string, text: string, tone?: (text: string) => string) => void,
  /** Wrapped under a line's own column, `indent` further in, as much as `lines` rows hold. */
  under: (text: string, tone: (text: string) => string, indent?: number, lines?: number) => void,
): void {
  const { skin } = ctx
  const detail = remote.machine?.detail
  if (detail === undefined || (detail.about?.public == null && detail.records === null)) return
  const seen = detail.records
  const again = detail.recordsLooking ? ' · looking again…' : ''
  if (seen === null) {
    line(
      'Records',
      detail.recordsLooking ? `looking at them on ${remote.name}…` : 'not looked at yet',
      skin.hint,
    )
    if (detail.recordsSaid !== null) under(detail.recordsSaid, skin.waiting)
    return
  }
  const loud = seen.lines.some((one) => one.loud)
  line('Records', `as of ${ctx.date(seen.at)}${again}`, loud ? skin.waiting : skin.done)
  if (detail.recordsSaid !== null) under(detail.recordsSaid, skin.waiting)
  if (seen.cannot !== null) under(seen.cannot, skin.hint)
  if (seen.head !== null) under(seen.head, skin.hint, 0, 3)
  for (const one of seen.lines) {
    const mark = one.loud ? '▲' : one.state === 'right' ? '✓' : '·'
    const tone = one.loud ? skin.bad : one.state === 'right' ? skin.done : skin.hint
    under(`${mark} ${one.said}`, tone)
    const zone = [
      ...(one.add === null ? [] : [`add ${one.add}`]),
      ...one.remove.map((gone) => `remove ${gone}`),
    ]
    for (const record of zone) under(record, skin.you, 2, Number.POSITIVE_INFINITY)
  }
}
