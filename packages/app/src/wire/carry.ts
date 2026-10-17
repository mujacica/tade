import type { Config } from '@tade/core'
import type { Remote, RemoteLink } from '@tade/remotes-core'
import {
  CarryRefused,
  type Checklist,
  carriedLine,
  carryTo,
  checklistOf,
  harnessesInUse,
  type Setup,
  setupOf,
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
// **What a press does** (Settings › Remotes): send the keys, after
// `KEYS_TO_REMOTE` was said and the button pressed twice; send this machine's
// value over one that machine changed itself; sign a harness in there, in a
// terminal the person types into, over the link; or carry again now. Each
// carry that sent anything is written down here as `remote_carried` — counts,
// and the paths a press sent, never a value; that machine writes its own.
//
// **Nothing waits on it.** A carry is a call over the link with a deadline,
// started from the beat and never awaited by anything that draws, one at a
// time per remote; what it answered is held, with when, and drawn from there.

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
  private readonly busy = new Set<string>()
  private readonly owed = new Set<string>()
  /** What each remote's last carry could not do, so it is said in the strip once and not hourly. */
  private readonly troubled = new Map<string, string>()
  /** The config last carried from, by identity: `Settings.use` hands a new one on every change. */
  private config: Config | null = null

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
      if (held === null || !held.live || this.busy.has(name)) continue
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
  async carry(
    name: string,
    opts: { keys: boolean; force?: readonly string[] },
  ): Promise<Checklist | null> {
    const held = this.deps.reach(name)
    if (held === null || this.busy.has(name)) return null
    this.busy.add(name)
    this.deps.draw()
    try {
      const setup = await setupOf(this.deps.home, this.deps.configPath, this.deps.secrets())
      const { list, refused } = await this.answer(name, held, setup, opts)
      this.kept.set(name, { list, at: this.deps.now() })
      this.troubles(name, refused ? list.unreached : null)
      if (list.unreached === null && (list.written > 0 || opts.keys || changedAny(list))) {
        await this.deps.log(carriedLine(name, 'window', list)).catch((err: unknown) => {
          // It landed there; only this machine's record of it did not.
          this.deps.said(null, `Carried to ${name}, and not written down here: ${String(err)}`)
        })
      }
      return list
    } finally {
      this.busy.delete(name)
      this.deps.draw()
    }
  }

  private async answer(
    name: string,
    held: { link: RemoteLink; remote: Remote },
    setup: Setup,
    opts: { keys: boolean; force?: readonly string[] },
  ): Promise<{ list: Checklist; refused: boolean }> {
    const inUse = harnessesInUse(this.deps.config())
    const base = { remote: name, setup, inUse, now: this.deps.now() }
    try {
      const answer = await carryTo(held.link, held.remote, setup, {
        from: this.deps.from(),
        ...opts,
      })
      return { list: checklistOf({ ...base, answer, unreached: null }), refused: false }
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
    } else if (verb === 'ours') {
      const list = await this.carry(name, { keys: false, force: [what] })
      this.deps.said(
        list === null ? null : `Sent this machine’s ${what} to ${name}.`,
        list?.unreached ?? null,
      )
    } else if (verb === 'sign-in') {
      await this.signIn(name, rest[0] ?? '', rest[1] ?? '')
    }
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
  shown(
    remotes: readonly { name: string; address: string; link: string; live: boolean }[],
  ): RemoteShown[] {
    return remotes.map((one) => {
      const kept = this.kept.get(one.name)
      return {
        ...one,
        list: kept?.list ?? null,
        at: kept?.at ?? null,
        busy: this.busy.has(one.name),
      }
    })
  }
}

/** Whether a carry changed anything there — a line's worth of news here. */
function changedAny(list: Checklist): boolean {
  return list.refused.length > 0 || list.theirs.length > 0
}
