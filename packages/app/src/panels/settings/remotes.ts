import { KEYS_TO_REMOTE } from '@tade/core'
// Type-only, so the pure panel model never loads what makes a checklist.
import type { Checklist } from '@tade/workbench/carry'
import type { Hit } from '../../hits.ts'
import type { Look } from '../../skin.ts'
import { blank, Row } from '../../ui.ts'
import { cap, padTo, withFocus, wrapTo } from '../cells.ts'
import type { PanelContext } from '../context.ts'
import { type PanelOutcome, stay } from '../outcome.ts'
import type { SettingsPanel } from './state.ts'

// The Remotes page: each other machine's Tade this one is an owner of, and
// what became of this one's setup there — what was carried and is kept in
// step, what that machine changed itself, what waits on a press, and each
// harness's own sign-in there (`@tade/workbench/carry`'s checklist, the one
// `tade remote add` ends with).
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
}

/**
 * One thing that can be pressed on the page: `remote:<verb>:<remote>:<rest>`.
 * `keys` is asked twice, because it sends credentials to another machine.
 */
export interface RemoteAction {
  id: string
  label: string
  remote: string
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
    for (const one of list?.theirs ?? []) {
      actions.push({
        id: `remote:ours:${at}:${one.what}`,
        label: 'Send this machine’s',
        remote: at,
      })
    }
    if ((list?.waiting.length ?? 0) > 0 && list?.unreached === null) {
      actions.push({ id: `remote:keys:${at}`, label: 'Send them…', remote: at })
    }
    for (const one of list?.signIns ?? []) {
      if (one.told && !one.signedIn) {
        actions.push({ id: signInId(at, one), label: 'Sign in…', remote: at })
      }
    }
    actions.push({ id: `remote:again:${at}`, label: 'Carry again', remote: at })
  }
  return actions
}

/** Carry out a press, asking twice for the one that sends keys. */
export function remoteChoice(panel: SettingsPanel, id: string): PanelOutcome {
  if (id.startsWith('remote:keys:') && panel.confirm !== id) {
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
      const label = panel.confirm === action.id ? 'Press again to send' : action.label
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
    if (list !== null && list.waiting.length > 0) {
      line('On a press', list.waiting.join(', '), skin.waiting)
      buttons([`remote:keys:${at}`], 'attention')
      // Said where somebody is deciding: once they have pressed, before the
      // press that sends.
      if (panel.confirm === `remote:keys:${at}`) say(KEYS_TO_REMOTE, skin.hint, 3 + named, 4)
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
    buttons([`remote:again:${at}`])
    body.push(blank(form))
    if (focused !== null && focused.split(':')[2] === at) keepInView(from, body.length - 1)
  }
}
