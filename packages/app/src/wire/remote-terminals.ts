import { mkdir, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { type LaneId, printable, runtimeDir } from '@tade/core'
import type { Answer, Held, Remote, RemoteLink, TerminalThere } from '@tade/remotes-core'
import { ATTACHED, type AttachedInfo, attachedFrom, nextAttached } from '@tade/workbench/attached'
import type { LaneRecord } from '@tade/workbench/registry'
import { ORCHESTRATOR_TAB, showTerminal } from '../model.ts'
import { flash, notify, type Wiring, why } from './context.ts'

// A terminal here that is an agent on another machine, and kept that way
// (REMOTE-TADE.md §3.4, §3.5): opened on enter, run again when its connection
// came back, and moved off a way that does not get through.
//
// **Opened** by asking that machine for its line (`/api/attach`) and the link
// for how to run it there, in a lane `remotes/<machine>/<n>` of this machine's
// (`workbench/src/attached.ts`) inside a small `sh` (`HOLD`): what the link
// handed over runs as it was handed over, and where it ends with a failure the
// tab stays with what it said until enter closes it.
//
// **Run again when the link comes back — and only what lost its connection.**
// `HOLD` writes how the terminal ended beside the home's other runtime files
// (`endedAt`): `lost` where it ended by the exit the link says is its
// connection going (`TerminalThere.lost`, ssh's 255), and the status
// otherwise. When a link is live again after it was not — a redial on the
// beat, or the wake after a lid was closed — every terminal to that machine
// whose wrapper says `lost` is asked for again and run again in the same lane,
// so the same tab, at its old size. Nothing else is: one the person closed is
// no lane any more, one that ended there (its agent stopped, tmux there let
// go) ended with its own status, and one whose agent that machine no longer
// has a line for is said and left. The file and not the lane's screen,
// because a screen is anything the far end drew.
//
// **Moved off a way that does not get through.** A link may hand a terminal
// back with `proving` — mosh, which with its UDP closed sits on its own
// banner rather than ending. It is given `within`, on the window's beat, and
// one that ended or whose screen still says it is waiting is told to the link
// (`attached`), which remembers it for that remote; asked again, the link
// answers another way, and that is run in the same lane and said.

/** What opening and keeping terminals there needs of the links. */
export interface RemoteTerminalDeps {
  /** The link holding a machine, and the remote as it opened it, or null where none does. */
  reach(machine: string): { link: RemoteLink; remote: Remote; live: boolean } | null
}

/** A terminal given a while to show it got through. */
interface Proving {
  machine: string
  task: string
  by: string
  until: number
  waiting: (rows: readonly string[]) => boolean
}

/** A terminal there, as that machine and the link answered, or why there is none. */
type There =
  | { terminal: TerminalThere }
  /** `answered`: that machine said so, rather than not being reached to ask. */
  | { why: string; answered: boolean }

export class RemoteTerminals {
  private readonly wire: Wiring
  private readonly deps: RemoteTerminalDeps
  /** Each link's live stretch as last seen, so its coming back is told from a frame that moved. */
  private readonly live = new Map<string, number>()
  /** Terminals given a while to get through, by lane. */
  private readonly proving = new Map<string, Proving>()
  /** Machines whose lost terminals are being run again now. */
  private readonly reopening = new Set<string>()

  constructor(wire: Wiring, deps: RemoteTerminalDeps) {
    this.wire = wire
    this.deps = deps
  }

  /** A new terminal to `task` on `machine`, put in front of the lower pane. */
  async open(machine: string, task: string): Promise<void> {
    let got: There
    try {
      got = await this.there(machine, task)
    } catch (err) {
      return this.say(`${machine}: ${printable(why(err))}`)
    }
    if ('why' in got) return this.say(got.why)
    const client = this.wire.opts.client
    const id = nextAttached(machine, client.lanes())
    try {
      await this.run(id, machine, task, got.terminal, '')
    } catch (err) {
      return this.say(`a terminal to ${machine} could not start here: ${why(err)}`)
    }
    this.front(id)
    if (got.terminal.by) flash(this.wire, `${task} on ${machine}, over ${got.terminal.by}`)
    this.wire.draw()
  }

  /**
   * A terminal in front of the lower pane, with the keyboard in it and the
   * window's room to read it: an agent's own screen is a whole screen, which
   * the pane's third of the window cuts to its last few rows. The pane's own
   * control puts it back.
   */
  front(id: string): void {
    this.wire.live?.tabsNow()
    this.wire.put({ ...showTerminal(this.wire.state, id), bottomMode: 'max' })
    this.wire.draw()
  }

  /**
   * What a link holds moved: live again after it was not — or for the first
   * time in this window, which finds what a window closed on — runs again
   * every terminal to that machine that lost its connection.
   */
  moved(name: string, held: Held): void {
    const since = held.link.kind === 'live' ? held.link.since : null
    if (since === null || since === this.live.get(name)) return
    this.live.set(name, since)
    void this.reopen(name)
  }

  /** The window's beat: a terminal past its while to get through is looked at. */
  beat(): void {
    const now = this.wire.now()
    for (const [id, one] of this.proving) {
      if (now < one.until) continue
      this.proving.delete(id)
      void this.prove(id, one)
    }
  }

  /** That machine's line for the agent, and how this link runs it there. Throws where neither could be asked. */
  private async there(machine: string, task: string): Promise<There> {
    const reach = this.deps.reach(machine)
    if (reach === null || !reach.live) {
      return {
        why: `${machine} is not linked right now, so no terminal to it can be opened`,
        answered: false,
      }
    }
    const asked = await reach.link.request(machine, '/api/attach', { task })
    const line = lineIn(asked, machine)
    if (line.why !== null) return { why: line.why, answered: true }
    const terminal = await reach.link.attach(reach.remote, line.command)
    if (terminal === null) {
      return { why: `the link to ${machine} cannot open a terminal there`, answered: false }
    }
    return { terminal }
  }

  /**
   * Run a terminal there in lane `id`, at the size and in the tab's place of
   * the lane `was` where it takes the place of one: what `said` is printed
   * first, and how it ends is written down (`HOLD`, `endedAt`).
   */
  private async run(
    id: string,
    machine: string,
    task: string,
    terminal: TerminalThere,
    said: string,
    was?: LaneRecord | null,
  ): Promise<void> {
    const ended = endedAt(this.wire.opts.home, id)
    await mkdir(dirname(ended), { recursive: true, mode: 0o700 })
    // A lane of the same name before this one may have left its word behind.
    await rm(ended, { force: true })
    await this.wire.opts.client.spawn({
      id: id as LaneId,
      task: `${ATTACHED}/${machine}`,
      kind: 'terminal',
      cwd: homedir(),
      command: '/bin/sh',
      args: [
        '-c',
        HOLD,
        'tade',
        ended,
        terminal.lost === undefined ? '' : String(terminal.lost),
        machine,
        said,
        terminal.command,
        ...terminal.args,
      ],
      title: task,
      ...(was?.spec.cols ? { cols: was.spec.cols } : {}),
      ...(was?.spec.rows ? { rows: was.spec.rows } : {}),
      // The driver gives this run a start of its own, and the tabs are in the
      // order they were opened: without the old one's it would move along the
      // row, past every tab opened after it — another machine's too.
      ...(was ? { openedAt: was.openedAt ?? was.startedAt } : {}),
    })
    if (terminal.proving === undefined) {
      this.proving.delete(id)
      return
    }
    this.proving.set(id, {
      machine,
      task,
      by: terminal.by ?? '',
      until: this.wire.now() + terminal.proving.within,
      waiting: terminal.proving.waiting,
    })
  }

  /**
   * Another terminal in the lane one was in: the same tab, where it was along
   * the row and at the size the lane last had, so the window tells it nothing
   * new — and in front again if the gap between the two took it away from there.
   *
   * Only the gap: the window giving the front to the orchestrator while the
   * lane was gone looks the same as somebody pressing its tab, so it is put
   * back only where nothing was pressed meanwhile (`presses`). A choice made
   * in the gap is the person's, and stays.
   */
  private async replace(
    one: { id: string; machine: string; task: string },
    terminal: TerminalThere,
    said: string,
  ): Promise<void> {
    const client = this.wire.opts.client
    const was = client.lane(one.id as LaneId)
    const before = this.wire.state
    if (was?.alive) await client.closeLane(one.id as LaneId)
    await this.run(one.id, one.machine, one.task, terminal, said, was)
    this.wire.live?.tabsNow()
    const now = this.wire.state
    if (
      before.bottom === one.id &&
      now.bottom === ORCHESTRATOR_TAB &&
      now.presses === before.presses
    ) {
      this.wire.put({ ...now, bottom: one.id, keyboard: before.keyboard })
    }
  }

  /** Every terminal to `machine` that lost its connection, run again, oldest first. */
  private async reopen(machine: string): Promise<void> {
    if (this.reopening.has(machine)) return
    this.reopening.add(machine)
    try {
      const home = this.wire.opts.home
      const mine = attachedFrom(this.wire.opts.client.lanes()).filter(
        (one) => one.machine === machine,
      )
      for (const one of mine) {
        let ended: Ended
        try {
          ended = await endedOf(home, one.id)
        } catch (err) {
          this.say(`whether ${nameOf(one)} on ${machine} lost its connection: ${why(err)}`)
          continue
        }
        if (ended === 'lost') await this.again(machine, one)
      }
    } finally {
      this.reopening.delete(machine)
    }
  }

  /** One terminal that lost its connection, run again where its agent is still there. */
  private async again(machine: string, one: AttachedInfo): Promise<void> {
    const name = nameOf(one)
    let got: There
    try {
      got = await this.there(machine, one.task)
    } catch (err) {
      return this.say(
        `${name} on ${machine} was not opened again: ${printable(why(err))} — it is tried when the link next comes back`,
      )
    }
    if ('why' in got) {
      // That machine has no line for it — its agent stopped there — so the
      // tab stays with how it ended, and is not asked about again.
      if (got.answered) await rm(endedAt(this.wire.opts.home, one.id), { force: true })
      return this.say(`${name} on ${machine} was not opened again: ${got.why}`)
    }
    const by = got.terminal.by ?? 'the link'
    try {
      await this.replace(one, got.terminal, `[connected to ${machine} again, over ${by}]`)
    } catch (err) {
      return this.say(`${name} on ${machine} could not be opened again here: ${why(err)}`)
    }
    flash(this.wire, `${name} on ${machine}: connected again, over ${by}`)
    this.wire.draw()
  }

  /** A terminal past its while: through, or told to the link and run another way. */
  private async prove(id: string, one: Proving): Promise<void> {
    const client = this.wire.opts.client
    const lane = client.lane(id as LaneId)
    // Closed meanwhile, or ended cleanly: nothing was learned about the way.
    if (lane?.alive !== true || lane.title !== one.task) return
    const name = nameOf(one)
    let through: boolean
    try {
      const ended = await endedOf(this.wire.opts.home, id)
      const rows = ended === null ? await client.capture(id as LaneId, lane.spec.rows ?? 24) : ''
      through = ended === null && !one.waiting(rows.split('\n'))
    } catch (err) {
      return this.say(
        `whether ${one.by} got through to ${one.machine} could not be read: ${why(err)}`,
      )
    }
    const reach = this.deps.reach(one.machine)
    if (reach === null) return
    try {
      await reach.link.attached(reach.remote, one.by, through)
    } catch (err) {
      this.say(`what came of ${one.by} to ${one.machine} could not be written down: ${why(err)}`)
    }
    if (through) return
    let got: There
    try {
      got = await this.there(one.machine, one.task)
    } catch (err) {
      return this.say(
        `${one.by} did not get through to ${one.machine}, and nothing else could be asked: ${printable(why(err))}`,
      )
    }
    if ('why' in got) return this.say(`${one.by} did not get through to ${one.machine}: ${got.why}`)
    const by = got.terminal.by ?? 'the link'
    // The same way again is the link with nothing else to offer: said, never tried in a loop.
    if (by === one.by) {
      return this.say(`${one.by} did not get through to ${one.machine}, and there is no other way`)
    }
    try {
      await this.replace(
        { id, machine: one.machine, task: one.task },
        got.terminal,
        `[${one.by} did not get through to ${one.machine}: over ${by}]`,
      )
    } catch (err) {
      return this.say(`${name} on ${one.machine} could not be opened over ${by}: ${why(err)}`)
    }
    flash(this.wire, `${name} on ${one.machine}, over ${by} — ${one.by} did not get through there`)
    this.wire.draw()
  }

  private say(said: string): void {
    notify(this.wire, said)
    this.wire.draw()
  }
}

/**
 * What a terminal there is run inside, as `sh -c HOLD tade <ended> <lost>
 * <machine> <said> <command> <args…>`: what the link handed over runs as it
 * was handed over (`"$@"`, never through a shell's reading of it), after the
 * line `said` where there is one. Where it ends with a failure the terminal
 * stays with what it printed and says so until enter is pressed — a lane gone
 * is a tab gone, and a tab that vanished says nothing — and how it ended is
 * written to `<ended>`: `lost` for the link's own exit for a connection that
 * went, its status otherwise. One that ends cleanly, let go there, closes as
 * it ends.
 */
export const HOLD =
  'ended=$1 lost=$2 machine=$3 said=$4; shift 4; rm -f "$ended"; ' +
  '[ -n "$said" ] && printf \'%s\\r\\n\' "$said"; ' +
  '"$@"; status=$?; [ "$status" -eq 0 ] && exit 0; ' +
  'if [ "$status" = "$lost" ]; then echo lost > "$ended"; ' +
  'printf \'\\r\\n[the connection to %s dropped: it opens again when the link is back, or enter closes it]\' "$machine"; ' +
  'else echo "$status" > "$ended"; ' +
  'printf \'\\r\\n[it ended (%s): press enter to close]\' "$status"; fi; ' +
  'read -r _; rm -f "$ended"; exit "$status"'

/** How a terminal there ended, as its wrapper wrote it: its connection lost, a status, or not yet. */
type Ended = 'lost' | number | null

/** Where the wrapper of the terminal in lane `id` writes how it ended. */
export function endedAt(home: string, id: string): string {
  return join(runtimeDir(home), 'attached', id.replaceAll('/', '-'))
}

/** What the wrapper wrote of how a terminal ended, or null while it has not. */
export async function endedOf(home: string, id: string): Promise<Ended> {
  let said: string
  try {
    said = (await readFile(endedAt(home, id), 'utf8')).trim()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  if (said === 'lost') return 'lost'
  return /^\d+$/.test(said) ? Number(said) : null
}

/** A terminal's agent by the name it has there, as its tab calls it. */
function nameOf(one: { task: string }): string {
  return printable(one.task.slice(one.task.indexOf('/') + 1))
}

/** That machine's line for the agent, or why there is none, from what `/api/attach` answered. */
export function lineIn(
  answer: Answer,
  machine: string,
): { command: string; why: null } | { command: null; why: string } {
  const body = typeof answer.body === 'object' && answer.body !== null ? answer.body : {}
  if (answer.status === 404) {
    return {
      command: null,
      why: `${machine}'s Tade cannot be asked for a terminal to its agents — update it there`,
    }
  }
  if (answer.status !== 200) {
    const said = 'said' in body && typeof body.said === 'string' ? printable(body.said) : ''
    return { command: null, why: `${machine}: ${said || `it answered ${answer.status}`}` }
  }
  const command = 'command' in body ? body.command : null
  if (typeof command === 'string') return { command, why: null }
  const said = 'why' in body && typeof body.why === 'string' ? printable(body.why) : ''
  return { command: null, why: `${machine}: ${said || 'it gave no terminal for that agent'}` }
}
