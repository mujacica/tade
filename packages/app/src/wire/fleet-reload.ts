import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { printable } from '@tade/core'
import type { Answer, Held, Remote, RemoteLink } from '@tade/remotes-core'
import type { MachineAnswer, OrchestratorStanding } from '@tade/web'
import { runningCheckout } from '@tade/workbench/programs'
import {
  type Cause,
  type Checked,
  causesOf,
  checkedSaid,
  type FleetFacts,
  factsOf,
  together,
} from '../fleet-due.ts'
import { versusHere } from '../machine-there.ts'
import type { Ui } from '../screen.ts'
import { why } from './context.ts'
import { checkoutAt } from './fleet-checkout.ts'

// Reload, every machine at once: the strip's reload, `/reload` and
// `tade_reload` start this window again *and* the Tade on every machine this
// one is an owner of — each first moved to the version this one runs where it
// is behind, by its own `tade host upgrade` in a terminal over the link, then
// started again through its own door (`/api/restart`), which a `tade serve`
// answers by asking its unit to restart (`serve-restart.ts`) and a window by
// reloading. Agents survive as they do here: a machine whose lanes would stop
// is not restarted, and that is said.
//
// **A checkout moves by commit.** A machine that runs Tade from a checkout
// says which commit (`MachineAnswer.checkout`), and where this one does too,
// its version says nothing: it is moved to this machine's HEAD — handed that
// commit over the link first (`git push`, into a ref of Tade's own), because
// this machine's branch is often ahead of the upstream both follow — then
// `tade host upgrade --commit` there fast-forwards, installs where the
// lockfile moved, and restarts. Only forward: one that is not behind HEAD here
// is restarted on what it has, and that is said.
//
// **Never silent.** Each step is said as it happens, machine by machine, in
// the strip and the conversation — which the phone reads too — and one that
// cannot be reached, refuses or does not come back is said in its own words.
// Every wait has a deadline; this window reloads at the end whatever came of
// the others, because a reload pressed is a reload owed here too.
//
// **Checked after.** What was reloaded is written in this home
// (`reload-check.json`) before this window goes, and the window that comes
// back reads it once, waits until each machine has answered again and its
// orchestrator has settled, and says whether the conversation is one across
// them and whether any orchestrator reports a sign-in or model problem
// (`fleet-due.ts`'s `checkedSaid`).
//
// **And offered when it is due.** On the beat, each machine's answer is
// compared with the last one this window heard: where a change there means a
// restart would bring the two orchestrators together, and they are apart, it
// is said once per cause — after it has stood `SETTLE_MS`, so what settles by
// itself (a `/login` there restarts its own orchestrator) is never said — and
// the strip's reload chip stays up while it stands (`due`).

/** How long one machine is given to come back from its restart. */
const BACK_MS = 180_000
/** How often a machine coming back is looked at. */
const POLL_MS = 500
/** How long asking a machine what it is may take. */
const ASK_MS = 10_000
/** How long a machine that `tade host upgrade` may have restarted is watched for going. */
const UPGRADED_MS = 15_000
/** How long the check after a reload waits for everything to settle before saying what it found. */
const CHECK_MS = 150_000
/** How often a machine is asked again while the check waits on it. */
const CHECK_ASK_MS = 5_000
/** How long a cause must stand, apart, before it is said. */
export const SETTLE_MS = 90_000
/** What is kept across this window's reload, for the one that comes back to check. */
export const CHECK_FILE = 'reload-check.json'

/** The far side's door that starts its Tade again (`@tade/web`'s `restarted.ts`). */
const RESTART_DOOR = '/api/restart'

/** This machine's Tade checkout, as a reload of a checkout there needs it (`fleet-checkout.ts`). */
export interface CheckoutHere {
  /** The commit its HEAD is at now, whole; null where it is no checkout, or git does not answer. */
  head(): Promise<string | null>
  /** Whether `commit` is `head` or before it here: false where this machine has not got it. */
  behind(commit: string, head: string): Promise<boolean>
  /** Hand `commit` to the repository at `root` there; null where it went, why not otherwise. */
  hand(link: RemoteLink, remote: Remote, root: string, commit: string): Promise<string | null>
}

export interface FleetReloadDeps {
  home: string
  /** The remotes this machine's config names, in its order. */
  names(): readonly string[]
  /** The link that holds a remote, and whether it is up. */
  reach(name: string): { link: RemoteLink; remote: Remote; live: boolean } | null
  /** What the link holds of it: its state and the cursor whose epoch a restart moves. */
  held(name: string): Held | null
  /** Its last answer to what it is, and when it came in this machine's clock. */
  answer(name: string): { answer: MachineAnswer | null; at: number | null } | null
  /** Ask it what it is, now. */
  ask(name: string): Promise<void>
  /** The hub this machine's conversation is one with, by its name here; null where none is named. */
  hub(): string | null
  /** The hub the last exchange was the same conversation with (`FleetConversation.oneWith`). */
  oneWith(): string | null
  /** How the orchestrator here stands. */
  here(): OrchestratorStanding
  /** The Tade this window runs. */
  version(): string
  /**
   * This machine's Tade checkout: absent, the one this window runs from
   * (`runningCheckout`), which for an install is none, and machines are then
   * moved by version alone.
   */
  checkout?: CheckoutHere
  /** This machine in a sentence: `this Mac`. */
  hereName: string
  /** A terminal over the window, which a person sees: an update there runs in one. */
  onScreenWith(flow: (ui: Ui) => Promise<void>): Promise<void>
  /** Start this window again; absent, nothing could (a test, or `tade serve`). */
  reloadHere?: () => Promise<void>
  /** Said in the strip and the conversation, and drawn. */
  say(text: string): void
  now(): number
  wait?: (ms: number) => Promise<void>
  /** How long each wait is given: a test's are short. */
  times?: Partial<{ back: number; poll: number; upgraded: number; check: number; settle: number }>
}

/** How one machine's part of a reload ended. */
interface Outcome {
  name: string
  /** It is running the Tade it was moved to, started again. */
  back: boolean
  said: string
}

export class FleetReload {
  private readonly deps: FleetReloadDeps
  private readonly checkout: CheckoutHere
  private going: Promise<void> | null = null
  /** One terminal in front at a time: updates there run one after another. */
  private screen: Promise<unknown> = Promise.resolve()
  /** Each machine's facts as last heard, and when that answer came. */
  private readonly seen = new Map<string, { facts: FleetFacts; at: number | null }>()
  /** Causes heard, not yet said: said once they have stood `settle`, apart. */
  private readonly pending = new Map<string, { cause: Cause; at: number }>()
  /** Causes said, by key: never said again in this window. */
  private readonly said = new Set<string>()
  /** Causes said that still stand: what the strip's reload chip is up for. */
  private readonly standing = new Map<string, Cause>()
  /** The check after a reload, read from the file the last window left. */
  private check: { machines: readonly string[]; since: number; asked: Map<string, number> } | null =
    null
  private recalled = false

  constructor(deps: FleetReloadDeps) {
    this.deps = deps
    this.checkout = deps.checkout ?? checkoutAt(runningCheckout()?.root ?? null)
  }

  /** The reload a cause is due for, as the strip's chip and `tade_updates` say it; null for none. */
  due(): string | null {
    return [...this.standing.values()][0]?.said ?? null
  }

  /** Whether a reload of every machine is going now. */
  get busy(): boolean {
    return this.going !== null
  }

  /** The one press: every owner-linked machine, then this window. A second press waits on the first. */
  reload(): Promise<void> {
    if (this.going !== null) {
      this.deps.say('Already reloading every machine: each one is said here as it comes back.')
      return this.going
    }
    this.going = this.run().finally(() => {
      this.going = null
    })
    return this.going
  }

  private async run(): Promise<void> {
    const names = this.deps.names()
    const here = this.deps.hereName
    if (names.length > 0) {
      this.deps.say(
        `Reloading every machine: ${names.join(' and ')} first, then ${here}. Agents keep working.`,
      )
      const outcomes = await Promise.all(names.map((name) => this.one(name)))
      // What was due is what this press answered.
      this.standing.clear()
      this.pending.clear()
      const back = outcomes.filter((one) => one.back).map((one) => one.name)
      if (back.length > 0) {
        await this.keepCheck(back).catch((err: unknown) =>
          this.deps.say(
            `The check after the reload could not be written down, so ${here} will not say whether the conversation is shared: ${why(err)}`,
          ),
        )
      }
    }
    if (this.deps.reloadHere === undefined) return
    this.deps.say(`${here} reloads now.`)
    await this.deps.reloadHere()
  }

  /** One machine moved forward where it is behind, and started again: what it came to, said. */
  private async one(name: string): Promise<Outcome> {
    const outcome = await this.reloadThere(name).catch(
      (err: unknown): Outcome => ({
        name,
        back: false,
        said: `${name} was not reloaded: ${printable(why(err))}`,
      }),
    )
    this.deps.say(outcome.said)
    return outcome
  }

  private async reloadThere(name: string): Promise<Outcome> {
    const reach = this.deps.reach(name)
    if (reach === null || !reach.live) {
      const link = this.deps.held(name)?.link
      const said =
        link?.kind === 'down' || link?.kind === 'ended' ? `: ${printable(link.said)}` : ''
      return {
        name,
        back: false,
        said: `${name} could not be reached, so it was not reloaded${said}`,
      }
    }
    const epoch = this.epochOf(name)
    await this.asked(name)
    const told = this.deps.answer(name)?.answer ?? null
    const there = told?.version ?? null
    const mine = this.deps.version()
    const checkout = told?.checkout ?? null
    const head = checkout === null ? null : await this.headHere()
    // The commit it should come back on: null where it is moved by version, or not at all.
    let expected: string | null = null
    if (checkout !== null && head !== null) {
      const moved = await this.forward(name, reach, checkout, head)
      if (typeof moved !== 'string') return moved
      if (moved !== 'as it is') expected = head
      if (
        moved === 'moved' &&
        (await this.cameBack(name, epoch, this.time('upgraded', UPGRADED_MS))) === 'back'
      ) {
        return this.backOn(name, expected)
      }
    } else {
      const versus = there === null ? null : versusHere(there, mine, this.deps.hereName)
      if (versus?.behind) {
        const words = ['host', 'upgrade', '--yes', '--to', mine]
        const updated = await this.update(name, reach, words, {
          going: `${name} runs Tade ${there}: updating it to ${mine} first.`,
          cannot: `${name} runs Tade ${there} and cannot be updated from here (its link opens no terminal): it is restarted on what it has — run \`tade host upgrade\` there.`,
          title: `Tade on ${name}, moved to ${mine} and restarted`,
          to: mine,
        })
        if (updated !== null && updated !== 'cannot') return updated
        // `tade host upgrade` restarts a service it can: watched for, so it is not restarted twice.
        if (
          updated === null &&
          (await this.cameBack(name, epoch, this.time('upgraded', UPGRADED_MS))) === 'back'
        ) {
          return this.backOn(name, null)
        }
      }
    }
    let answer: Answer
    try {
      answer = await reach.link.call(reach.remote, RESTART_DOOR, { stops: 0 })
    } catch (err) {
      return {
        name,
        back: false,
        said: `${name} could not be asked to restart: ${printable(why(err))}`,
      }
    }
    const refused = restartRefused(name, answer)
    if (refused !== null) return { name, back: false, said: refused }
    this.deps.say(`${name} is restarting.`)
    const came = await this.cameBack(name, epoch, this.time('back', BACK_MS))
    if (came !== 'back') {
      const minutes = Math.round(this.time('back', BACK_MS) / 60_000)
      return {
        name,
        back: false,
        said: `${name} has not come back ${minutes > 0 ? `in ${minutes} minutes` : 'in time'} after its restart: look at it there (\`tade host service\` says how its service stands)`,
      }
    }
    return this.backOn(name, expected)
  }

  /** This machine's HEAD, where it runs from a checkout; null where it does not, or git did not say. */
  private async headHere(): Promise<string | null> {
    // A git that throws is said by `one`, as why this machine was not reloaded.
    return await this.checkout.head()
  }

  /**
   * A checkout there moved to this machine's HEAD: handed the commit, then
   * fast-forwarded and restarted by its own `tade host upgrade --commit`.
   * `moved` where that ran, `already` where it is on HEAD, `as it is` where it
   * is not behind HEAD here or cannot be moved from here — each then restarted
   * through its door; how it ended where it went wrong.
   */
  private async forward(
    name: string,
    reach: { link: RemoteLink; remote: Remote },
    checkout: { root: string; commit: string },
    head: string,
  ): Promise<Outcome | 'moved' | 'already' | 'as it is'> {
    if (checkout.commit === head) return 'already'
    const here = this.deps.hereName
    const from = checkout.commit.slice(0, 9)
    const to = head.slice(0, 9)
    if (!(await this.checkout.behind(checkout.commit, head))) {
      this.deps.say(
        `${name} runs from ${from}, which is not behind ${here}’s ${to}: a checkout only moves forward, so it is restarted on what it has.`,
      )
      return 'as it is'
    }
    this.deps.say(`${name} runs from ${from}: moving it to ${here}’s ${to} first.`)
    const words = ['host', 'upgrade', '--yes', '--commit', head]
    // Asked before anything is handed: a commit pushed there that nothing moves to is clutter.
    if (!reach.link.capabilities.terminals) {
      this.deps.say(
        `${name} cannot be moved from here (its link opens no terminal): it is restarted on what it has — run \`tade ${words.join(' ')}\` there.`,
      )
      return 'as it is'
    }
    const failed = await this.checkout
      .hand(reach.link, reach.remote, checkout.root, head)
      .catch((err: unknown) => why(err))
    if (failed !== null) {
      return {
        name,
        back: false,
        said: `${to} could not be handed to ${name}, so it was not restarted: ${printable(failed)}`,
      }
    }
    const updated = await this.update(name, reach, words, {
      going: null,
      cannot: null,
      title: `Tade on ${name}, moved to ${to} and restarted`,
      to,
    })
    return updated === null ? 'moved' : updated === 'cannot' ? 'as it is' : updated
  }

  /**
   * Its Tade moved forward by its own `tade host upgrade` with `words`, in a
   * terminal over this window that the person sees. Null where that went, so
   * the restart follows; `cannot` where its link opens no terminal; otherwise
   * how it ended.
   */
  private async update(
    name: string,
    reach: { link: RemoteLink; remote: Remote },
    words: readonly string[],
    said: { going: string | null; cannot: string | null; title: string; to: string },
  ): Promise<Outcome | 'cannot' | null> {
    const terminal = reach.link.terminal(reach.remote, words)
    if (terminal === null) {
      if (said.cannot !== null) this.deps.say(said.cannot)
      return 'cannot'
    }
    if (said.going !== null) this.deps.say(said.going)
    let code = 0
    const before = this.screen
    const turn = (async () => {
      await Promise.allSettled([before])
      await this.deps.onScreenWith(async (ui) => {
        ui.say(`  ${said.title}: \`tade ${words.join(' ')}\` there.`)
        code = await ui.run(`Tade on ${name}`, terminal.command, terminal.args, {})
      })
    })()
    this.screen = turn
    await turn
    if (code !== 0) {
      return {
        name,
        back: false,
        said: `${name}’s update to ${said.to} did not work (exit ${code}), so it was not restarted: what it printed is in its terminal`,
      }
    }
    return null
  }

  /** It answered again after coming back: which Tade it runs now — and on which commit, where one was expected — said. */
  private async backOn(name: string, expected: string | null): Promise<Outcome> {
    await this.asked(name)
    const told = this.deps.answer(name)?.answer ?? null
    const now = told?.version ?? null
    if (expected !== null) {
      const on = told?.checkout?.commit ?? null
      if (on !== expected) {
        return {
          name,
          back: true,
          said: `${name} is back, on ${on?.slice(0, 9) ?? 'a commit it did not say'} rather than ${this.deps.hereName}’s ${expected.slice(0, 9)}: its update did not move it`,
        }
      }
      return {
        name,
        back: true,
        said: `${name} is back on ${expected.slice(0, 9)}, Tade ${now ?? 'a version it did not say'}.`,
      }
    }
    const mine = this.deps.version()
    const versus = now === null ? null : versusHere(now, mine, this.deps.hereName)
    if (versus?.behind) {
      return {
        name,
        back: true,
        said: `${name} is back, still on Tade ${now}, ${versus.said}: its update did not move it`,
      }
    }
    return {
      name,
      back: true,
      said: `${name} is back on Tade ${now ?? 'a version it did not say'}.`,
    }
  }

  /** Whether it went and came back, by its server lifetime moving, within `ms`. */
  private async cameBack(name: string, epoch: string | null, ms: number): Promise<'back' | 'not'> {
    const deadline = this.deps.now() + ms
    for (;;) {
      const held = this.deps.held(name)
      const live = held?.link.kind === 'live'
      const moved = (held?.cursor?.epoch ?? null) !== epoch
      if (live && moved) return 'back'
      if (this.deps.now() >= deadline) return 'not'
      await this.pause(this.time('poll', POLL_MS))
    }
  }

  private epochOf(name: string): string | null {
    return this.deps.held(name)?.cursor?.epoch ?? null
  }

  /** Ask it what it is, within `ASK_MS`; what could not be asked is the answer held before. */
  private async asked(name: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      this.deps.ask(name),
      new Promise<void>((done) => {
        timer = setTimeout(done, ASK_MS)
        timer.unref?.()
      }),
    ]).finally(() => clearTimeout(timer))
  }

  private async keepCheck(machines: readonly string[]): Promise<void> {
    await writeFile(
      join(this.deps.home, CHECK_FILE),
      `${JSON.stringify({ at: this.deps.now(), machines })}\n`,
      { mode: 0o600 },
    )
  }

  /**
   * The beat: what the last window's reload left to check, read once, and
   * checked once everything has settled; and what each machine said since,
   * weighed for a reload due. Returns at once.
   */
  beat(): void {
    if (!this.recalled) {
      this.recalled = true
      void this.recall().catch((err: unknown) =>
        this.deps.say(`What the last reload left to check could not be read: ${why(err)}`),
      )
    }
    if (this.check !== null) this.checking()
    if (this.going === null) this.weigh()
  }

  /** The file the window before this one left, read and taken away. */
  private async recall(): Promise<void> {
    const path = join(this.deps.home, CHECK_FILE)
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    await rm(path, { force: true })
    const kept = JSON.parse(text) as { machines?: unknown }
    const machines = Array.isArray(kept.machines)
      ? kept.machines.filter((one): one is string => typeof one === 'string')
      : []
    if (machines.length === 0) return
    this.check = { machines, since: this.deps.now(), asked: new Map() }
  }

  private checking(): void {
    const check = this.check
    if (check === null) return
    const now = this.deps.now()
    const late = now - check.since >= this.time('check', CHECK_MS)
    const hub = this.deps.hub()
    const oneWith = this.deps.oneWith()
    const here = this.deps.here()
    const results: Checked[] = []
    let settled = here.state !== 'starting'
    for (const name of check.machines) {
      const got = this.deps.answer(name)
      const fresh = got?.at != null && got.at >= check.since
      const facts = fresh ? factsOf(name, got?.answer ?? null) : null
      const live = this.deps.reach(name)?.live === true
      if (facts === null || facts.orchestrator?.state === 'starting') settled = false
      // The hub's exchange is waited for only where its orchestrator came up to share:
      // one that did not start is the answer already.
      const sharing = facts?.orchestrator?.state === 'up' && facts.orchestrator.shares
      if (name === hub && sharing && facts !== null && !together(facts, hub, oneWith)) {
        settled = false
      }
      // Asked again while it is settling, rather than on the minute.
      if (live && (facts === null || !together(facts, hub, oneWith))) {
        const last = check.asked.get(name) ?? 0
        if (now - last >= CHECK_ASK_MS) {
          check.asked.set(name, now)
          void this.asked(name)
        }
      }
      results.push({
        name,
        facts,
        unreached: live || facts !== null ? null : 'its link is not up',
      })
    }
    if (!settled && !late) return
    this.check = null
    this.deps.say(checkedSaid({ name: this.deps.hereName, standing: here }, results, hub, oneWith))
  }

  /** Each machine's newest answer against the last one heard: causes kept, said once they stand. */
  private weigh(): void {
    const hub = this.deps.hub()
    // With no hub there is no one conversation for a reload to bring anybody into.
    if (hub === null) return
    const oneWith = this.deps.oneWith()
    const now = this.deps.now()
    const latest = new Map<string, FleetFacts>()
    for (const name of this.deps.names()) {
      const got = this.deps.answer(name)
      const facts = factsOf(name, got?.answer ?? null)
      if (facts === null) continue
      latest.set(name, facts)
      const was = this.seen.get(name)
      if (was !== undefined && was.at === (got?.at ?? null)) continue
      this.seen.set(name, { facts, at: got?.at ?? null })
      if (was === undefined) continue
      for (const cause of causesOf(was.facts, facts)) {
        if (!this.said.has(cause.key) && !this.pending.has(cause.key)) {
          this.pending.set(cause.key, { cause, at: now })
        }
      }
    }
    const apart = (machine: string) => {
      const facts = latest.get(machine)
      return facts === undefined || !together(facts, hub, oneWith)
    }
    for (const [key, cause] of this.standing) if (!apart(cause.machine)) this.standing.delete(key)
    for (const [key, { cause, at }] of this.pending) {
      if (!apart(cause.machine)) {
        this.pending.delete(key)
        continue
      }
      if (now - at < this.time('settle', SETTLE_MS)) continue
      this.pending.delete(key)
      this.said.add(key)
      this.standing.set(key, cause)
      this.deps.say(cause.said)
    }
  }

  private time(which: keyof NonNullable<FleetReloadDeps['times']>, otherwise: number): number {
    return this.deps.times?.[which] ?? otherwise
  }

  private pause(ms: number): Promise<void> {
    if (this.deps.wait) return this.deps.wait(ms)
    return new Promise((done) => setTimeout(done, ms))
  }
}

/** Why a machine did not start again when asked, in words; null where it is starting. */
export function restartRefused(name: string, answer: Answer): string | null {
  if (answer.status === 404) {
    return `${name} runs a Tade that cannot be restarted from here: restart it there, or update it from Settings › Remotes`
  }
  const body = answer.body as { restarting?: unknown; stops?: unknown; said?: unknown } | null
  if (answer.status !== 200 || typeof body?.restarting !== 'boolean') {
    return `${name} answered ${answer.status} when asked to restart, so it was not reloaded`
  }
  if (body.restarting) return null
  if (typeof body.said === 'string')
    return `${name} was not reloaded: ${printable(body.said).slice(0, 600)}`
  const stops = typeof body.stops === 'number' ? body.stops : 0
  return `${name} was not restarted, because ${stops} lane${stops === 1 ? '' : 's'} there would stop: agents keep working, and it reloads once nothing runs inside its Tade (or restart it there)`
}
