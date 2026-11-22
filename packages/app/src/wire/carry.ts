import {
  type CarryLine,
  type Config,
  conflictSays,
  type HandEdit,
  type SettingConflict,
  stampText,
} from '@tade/core'
import type { Remote, RemoteLink } from '@tade/remotes-core'
import {
  type CarryPress,
  CarryRefused,
  type Checklist,
  carriedLine,
  carryTo,
  checklistOf,
  clockOf,
  editsOf,
  harnessesInUse,
  type Setup,
  setupOf,
  type TakenWrite,
  takeBack,
} from '@tade/workbench/carry'
import type { RemoteShown } from '../panels/settings/remotes.ts'
import type { Ui } from '../screen.ts'

// This machine's setup kept in step on every remote it is an owner of, from
// the window (`@tade/workbench/carry` is the shared half; `tade remote add`
// does the first carry from a shell).
//
// **When it carries, by itself**: when a link comes up, when the config this
// window holds changed — a setting written here, or the file edited by hand —
// and once an hour while a link is up, which is what picks up a persona or a
// template made in the meantime. Only what is `kept`: keys go only on a press.
//
// **Both ways.** What comes back newer is settled here as that machine settled
// what it was sent (`takeBack`) and written through this window's own door
// with the stamp it came with, so it is not carried back as news; a change
// both made apart is written down here too (`settings_conflict`) and said
// once, and a peer's change to what widens agents here is said whenever it
// lands — or why it did not. An edit to the file since its newest line is
// written down first, as somebody's here (`by: file`), so its stamp is now.
//
// **What a press does** (Settings › Remotes): send the keys, after
// `KEYS_TO_REMOTE` was said and the button pressed twice; turn talking to Tade
// from here on there, after `TALK_TO_REMOTE` was said and pressed twice too;
// send this machine's value over one that machine changed itself; sign a
// harness in there, in a terminal the person types into, over the link; or
// carry again now. Each
// carry that sent anything is written down here as `remote_carried` — counts,
// and the paths a press sent, never a value; that machine writes its own.
//
// **Nothing waits on it.** A carry is a call over the link with a deadline,
// started from the beat and never awaited by anything that draws, one at a
// time per remote; what it answered is held, with when, and drawn from there.
// A press while one is in flight waits for it and then makes its own, because
// the button is drawn under "carrying…" too, and a press that came to nothing
// would say nothing.

/** How long a remote kept in step goes before it is carried to again anyway. */
const AGAIN_MS = 60 * 60_000

export interface CarriesDeps {
  home: string
  configPath: string
  config: () => Config
  /** The link that holds a remote and the remote as it was opened, or null for none held. */
  reach: (name: string) => { link: RemoteLink; remote: Remote; live: boolean } | null
  /** Paths the loaded extensions declared as keys, whatever they are called. */
  secrets: () => ReadonlySet<string>
  /** What this machine calls itself there. */
  from: () => string
  log: (line: ReturnType<typeof carriedLine>) => Promise<void>
  /**
   * What a terminal changed in the config while this window held the journal,
   * written down by the window's own append (`Settings.fold`) — awaited before
   * a carry reads a single line, so a setting set from a shell for the first
   * time is never carried with no stamp ahead of its line.
   */
  fold: () => Promise<void>
  /** Every `config_changed` line here, oldest first: what each setting's stamp is read from. */
  lines: () => Promise<readonly CarryLine[]>
  /** Write down settings edited by hand since their newest line, as somebody's here. */
  found: (edits: readonly HandEdit[]) => Promise<void>
  /** Write one setting that came back newer, through this window's own door, with its register. Throws the reason. */
  take: (write: TakenWrite, from: string) => Promise<void>
  /** Write down a change both machines made apart, and whose stood. */
  conflicted: (conflict: SettingConflict, other: string) => Promise<void>
  /** A terminal the person types into, over the window, for a sign-in there. */
  onScreenWith: (flow: (ui: Ui) => Promise<void>) => Promise<void>
  /** Said on the Settings page, where the press was. */
  said: (text: string | null, error: string | null) => void
  /** Said in the strip: a carry nobody pressed for that could not be made, once per trouble. */
  say: (said: string) => void
  draw: () => void
  now: () => number
}

interface Kept {
  list: Checklist
  at: number
}

export class Carries {
  private readonly deps: CarriesDeps
  private readonly kept = new Map<string, Kept>()
  /** Each remote's last carry asked for, in flight or queued: its turn, ended when it is. */
  private readonly running = new Map<string, Promise<void>>()
  private readonly owed = new Set<string>()
  /** What each remote's last carry could not do, so it is said in the strip once and not hourly. */
  private readonly troubled = new Map<string, string>()
  /** The config last carried from, by identity: `Settings.use` hands a new one on every change. */
  private config: Config | null = null
  /** What was said in the strip about a setting that came back, so a carry an hour later is not news again. */
  private readonly told = new Set<string>()

  constructor(deps: CarriesDeps) {
    this.deps = deps
  }

  /** A link came up: carry to it on the next beat. */
  up(name: string): void {
    this.owed.add(name)
  }

  /** The config file moved under the window: carry to every live remote. */
  moved(): void {
    this.config = null
  }

  /** A remote is gone: what was held for it goes with it. */
  forget(name: string): void {
    this.kept.delete(name)
    this.owed.delete(name)
    this.troubled.delete(name)
  }

  /** The window's beat: what is owed, carried. Returns at once. */
  beat(names: readonly string[]): void {
    const config = this.deps.config()
    const changed = this.config !== config
    this.config = config
    const now = this.deps.now()
    for (const name of names) {
      const held = this.deps.reach(name)
      if (held === null || !held.live || this.running.has(name)) continue
      const kept = this.kept.get(name)
      const due = kept === undefined || now - kept.at >= AGAIN_MS
      if (!changed && !due && !this.owed.has(name)) continue
      this.owed.delete(name)
      void this.carry(name, { keys: false })
    }
  }

  /**
   * One carry to one remote, held when it answers; the checklist, or null
   * where there was nothing to carry to. Written down where it sent anything.
   */
  async carry(name: string, opts: Omit<CarryPress, 'from'>): Promise<Checklist | null> {
    if (this.deps.reach(name) === null) return null
    // A turn only ever resolves: what a carry threw is its own caller's, and
    // the one queued behind it still goes.
    let ended = () => {}
    const turn = new Promise<void>((done) => {
      ended = done
    })
    const before = this.running.get(name)
    this.running.set(name, turn)
    this.deps.draw()
    try {
      await before
      return await this.once(name, opts)
    } finally {
      ended()
      if (this.running.get(name) === turn) this.running.delete(name)
      this.deps.draw()
    }
  }

  /** One carry, once whatever was in flight to that remote has answered. */
  private async once(name: string, opts: Omit<CarryPress, 'from'>): Promise<Checklist | null> {
    const held = this.deps.reach(name)
    if (held === null) return null
    const secrets = this.deps.secrets()
    // The spool first: a terminal's change folded on the beat beside this
    // carry would otherwise reach the file before its line reaches the
    // journal, and go out as a value nobody stamped — which loses to every
    // change anywhere, however much later it was made.
    await this.deps.fold().catch((err: unknown) => {
      this.deps.say(
        `A terminal's change to the config may be carried without its stamp: ${String(err)}`,
      )
    })
    let lines = await this.deps.lines()
    const edits = await editsOf(this.deps.configPath, lines, secrets)
    if (edits.length > 0) {
      await this.deps.found(edits)
      lines = await this.deps.lines()
    }
    const setup = await setupOf(this.deps.home, this.deps.configPath, secrets, lines)
    const { list, refused } = await this.answer(name, held, setup, opts)
    this.kept.set(name, { list, at: this.deps.now() })
    this.troubles(name, refused ? list.unreached : null)
    const pressed = opts.keys || opts.talk === true
    if (list.unreached === null && (list.written > 0 || pressed || changedAny(list))) {
      await this.deps.log(carriedLine(name, 'window', list)).catch((err: unknown) => {
        // It landed there; only this machine's record of it did not.
        this.deps.said(null, `Carried to ${name}, and not written down here: ${String(err)}`)
      })
    }
    return list
  }

  private async answer(
    name: string,
    held: { link: RemoteLink; remote: Remote },
    setup: Setup,
    opts: Omit<CarryPress, 'from'>,
  ): Promise<{ list: Checklist; refused: boolean }> {
    const inUse = harnessesInUse(this.deps.config())
    const base = { remote: name, setup, inUse, now: this.deps.now() }
    try {
      const me = this.deps.from()
      const answer = await carryTo(held.link, held.remote, setup, { from: me, ...opts })
      const took = await this.takeBack(name, setup, answer, me)
      return { list: checklistOf({ ...base, answer, unreached: null, me, took }), refused: false }
    } catch (err) {
      const said = err instanceof Error ? err.message : String(err)
      // Not reaching it is the link's news, said as the link goes down; a
      // remote that answered and said no is this carry's, and is said here.
      return {
        list: checklistOf({ ...base, answer: null, unreached: said }),
        refused: err instanceof CarryRefused,
      }
    }
  }

  /**
   * What came back newer, written here; the carry's conflicts written down;
   * and each said in the strip once — a conflict, a change to what widens
   * agents that landed, and one that did not, with why.
   */
  private async takeBack(
    name: string,
    setup: Setup,
    answer: Parameters<typeof takeBack>[1],
    me: string,
  ): Promise<{ taken: string[]; failed: { what: string; why: string }[] }> {
    const back = takeBack(setup, answer, me, this.deps.now())
    const taken: string[] = []
    const failed: { what: string; why: string }[] = []
    for (const one of back.writes) {
      try {
        await this.deps.take(one, name)
        taken.push(one.path)
      } catch (err) {
        failed.push({ what: one.path, why: err instanceof Error ? err.message : String(err) })
      }
    }
    for (const one of back.conflicts) {
      if (failed.some((each) => each.what === one.path)) continue
      const key = `conflict ${one.path} ${stampOf(one.kept.at)} ${stampOf(one.lost.at)}`
      if (this.told.has(key)) continue
      this.told.add(key)
      // Said either way; where the line would not go in, that is said too,
      // because the line is the only place the value that lost is kept.
      const unwritten = await this.deps.conflicted(one, name).then(
        () => '',
        (err: unknown) =>
          ` It is not written down here: ${err instanceof Error ? err.message : String(err)}`,
      )
      this.deps.say(`Changed on both ${name} and here: ${conflictSays(one, clockOf)}${unwritten}`)
    }
    for (const one of back.landed) {
      if (!taken.includes(one.path)) continue
      this.deps.say(
        `${name} changed ${one.path} to ${one.now || 'nothing'} (${one.by} there): applied here.`,
      )
    }
    for (const one of back.refused) {
      const key = `refused ${name} ${one.what} ${one.why}`
      if (this.told.has(key)) continue
      this.told.add(key)
      this.deps.say(`Not taken from ${name}: ${one.what} — ${one.why}.`)
    }
    return { taken, failed }
  }

  /** A carry that was refused, said once for as long as it is the same trouble. */
  private troubles(name: string, unreached: string | null): void {
    if (unreached === null) this.troubled.delete(name)
    else if (this.troubled.get(name) !== unreached) {
      this.troubled.set(name, unreached)
      this.deps.say(`Nothing could be carried to ${name}: ${unreached}`)
    }
  }

  /** A press on the Remotes page: `remote:<verb>:<remote>:<rest>`. */
  async action(id: string): Promise<void> {
    const [, verb, name = '', ...rest] = id.split(':')
    const what = rest.join(':')
    if (verb === 'again') {
      const list = await this.carry(name, { keys: false })
      this.deps.said(list === null ? null : `Carried to ${name}.`, list?.unreached ?? null)
    } else if (verb === 'keys') {
      const list = await this.carry(name, { keys: true })
      this.deps.said(
        list === null ? null : `Sent to ${name}: ${list.sent.join(', ') || 'nothing new'}.`,
        list?.unreached ?? null,
      )
    } else if (verb === 'talk') {
      const list = await this.carry(name, { keys: false, talk: true })
      if (list === null) this.deps.said(null, null)
      else this.deps.said(...talkPressed(name, list))
    } else if (verb === 'ours') {
      const list = await this.carry(name, { keys: false, force: [what] })
      this.deps.said(
        list === null ? null : `Sent this machine’s ${what} to ${name}.`,
        list?.unreached ?? null,
      )
    } else if (verb === 'sign-in') {
      await this.signIn(name, rest[0] ?? '', rest[1] ?? '')
    } else if (verb === 'upgrade') {
      await this.upgrade(name)
    }
  }

  /**
   * That machine's Tade moved forward by its own `tade host upgrade`, in a
   * terminal over this window: the install's command and the restart are
   * shown and pressed there, as at that machine's keyboard, and nothing of it
   * runs here. Its link comes back on the restarted Tade by itself, and what
   * it is then is asked as on any link coming up.
   */
  private async upgrade(name: string): Promise<void> {
    const held = this.deps.reach(name)
    const words = ['host', 'upgrade']
    const terminal = held?.link.terminal(held.remote, words) ?? null
    if (held === null || terminal === null) {
      this.deps.said(null, `${name} cannot be upgraded from here: run \`tade host upgrade\` there`)
      return
    }
    await this.deps.onScreenWith(async (ui) => {
      ui.say(
        `  Tade on ${name}, upgraded there: what it runs and restarts is pressed in this terminal.`,
      )
      await ui.run(`Tade on ${name}`, terminal.command, terminal.args, {})
    })
    this.deps.said(
      `${name}’s upgrade ended: its link comes back on the Tade it runs now, and this page says which.`,
      null,
    )
  }

  /**
   * A harness's own sign-in on that machine, in a terminal over this window:
   * the token goes where that harness keeps it there, never through Tade. Then
   * carried again, so the page says how it stands now.
   */
  private async signIn(name: string, harness: string, account: string): Promise<void> {
    const held = this.deps.reach(name)
    const words = ['accounts', 'sign-in', harness, ...(account === '' ? [] : [account])]
    const terminal = held?.link.terminal(held.remote, words) ?? null
    if (held === null || terminal === null) {
      this.deps.said(
        null,
        `${name} cannot be signed in from here: run \`tade ${words.join(' ')}\` there`,
      )
      return
    }
    await this.deps.onScreenWith(async (ui) => {
      ui.say(`  ${harness}'s own sign-in, on ${name}: what you type goes there and nowhere else.`)
      await ui.run(`${harness} on ${name}`, terminal.command, terminal.args, {})
    })
    await this.carry(name, { keys: false })
  }

  /** Each remote as the page draws it. */
  shown(remotes: readonly Omit<RemoteShown, 'list' | 'at' | 'busy'>[]): RemoteShown[] {
    return remotes.map((one) => {
      const kept = this.kept.get(one.name)
      return {
        ...one,
        list: kept?.list ?? null,
        at: kept?.at ?? null,
        busy: this.running.has(one.name),
      }
    })
  }
}

/** What a press to turn talking on there came to, as the page says it: done, or why not. */
function talkPressed(name: string, list: Checklist): [string | null, string | null] {
  if (list.unreached !== null) return [null, list.unreached]
  if (list.talk === 'turning on') {
    return [
      `Talking to Tade is turned on on ${name}: its tab here takes a message once the link is back.`,
      null,
    ]
  }
  if (list.talk === 'on') return [`Talking to Tade is already on on ${name}.`, null]
  return [null, `${name} did not turn it on: it says nothing of talking, as an older Tade does not`]
}

/** Whether a carry changed anything there — a line's worth of news here. */
function changedAny(list: Checklist): boolean {
  return (
    list.refused.length > 0 ||
    list.theirs.length > 0 ||
    list.taken.length > 0 ||
    list.conflicts.length > 0
  )
}

/** A stamp as a key for what was said, or nothing. */
function stampOf(stamp: SettingConflict['kept']['at']): string {
  return stamp === null ? '-' : stampText(stamp)
}
