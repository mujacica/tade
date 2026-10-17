import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { printable, printableLines, remoteDocumentPath } from '@tade/core'
import type { Remote, RemoteLink } from '@tade/remotes-core'
import { DocumentAnswerSchema, MachineAnswerSchema, ToolAnswerSchema } from '@tade/web'
import type { AboutHeld } from '../machine-there.ts'

// What each other machine says it is, asked as its owner (REMOTE-TADE.md §9.4;
// `@tade/web`'s `machine.ts` is the far side): its version, its public name's
// health, its problems, its schedules and watches with their last looks, and
// its documents — the half of "everything about a remote" its projection does
// not carry. And, on a press or a tool call, one of its documents read into a
// copy here, and one of its tools that only reads run there.
//
// **Asked on the beat, never waited for.** One small owner's request over the
// held link (`RemoteLink.request`): when the link comes up, and every
// `AGAIN_MS` while it stays up — one at a time per remote, never awaited by
// anything that draws. How long it took there and back is the round trip the
// Remotes page says, measured on the request itself, so it is what asking that
// machine anything costs from here and not a number about the network alone.
//
// **Kept when the link goes down**, with when it was said (`AboutHeld.at`), so
// a machine that stopped answering is drawn as of its last answer — never as a
// machine with no problems, no schedules and no version. What could not be
// asked is said beside it, once, as the reason: an older Tade there has no such
// door, which is a fact about that machine and not trouble here.

/** How long a linked remote goes before what it is, is asked again. */
export const AGAIN_MS = 60_000

/** The far side's doors (`@tade/web`'s `machine.ts`, `document.ts`, `tool-read.ts`). */
const MACHINE_DOOR = '/api/machine'
const DOCUMENT_DOOR = '/api/document'
const TOOL_DOOR = '/api/tool'

export interface RemoteMachinesDeps {
  home: string
  /** The link that holds a remote and the remote as it was opened, or null for none held. */
  reach: (name: string) => { link: RemoteLink; remote: Remote; live: boolean } | null
  now: () => number
  /** What is held moved: a frame, to draw what reads it. */
  draw: () => void
}

interface Kept extends AboutHeld {
  /** When it was last asked, or last could not be. */
  asked: number
  busy: boolean
  /** It is owed an ask on the next beat: its link has just come up. */
  owed: boolean
}

export class RemoteMachines {
  private readonly deps: RemoteMachinesDeps
  private readonly kept = new Map<string, Kept>()
  /** Moved whenever something held moved, so what folds it folds again. */
  private moved = 0

  constructor(deps: RemoteMachinesDeps) {
    this.deps = deps
  }

  /** What is held for one remote: its last answer and why there is none, or null before anything. */
  held(name: string): AboutHeld | null {
    return this.kept.get(name) ?? null
  }

  /** Moves whenever anything held moved. */
  revision(): number {
    return this.moved
  }

  /** The window's beat: ask every linked remote that is due. Returns at once. */
  beat(names: readonly string[]): void {
    const now = this.deps.now()
    for (const name of names) {
      const one = this.kept.get(name)
      if (one?.busy === true) continue
      if (one !== undefined && !one.owed && now - one.asked < AGAIN_MS) continue
      if (this.deps.reach(name)?.live !== true) continue
      void this.ask(name)
    }
  }

  /** A link came up: what it is, is asked on the next beat. */
  up(name: string): void {
    const one = this.kept.get(name)
    if (one !== undefined) one.owed = true
  }

  /** A remote no longer in the config: what it said goes with it. */
  forget(name: string): void {
    if (this.kept.delete(name)) this.moved++
  }

  /** Ask one remote what it is, and hold what it answered. Never throws. */
  async ask(name: string): Promise<void> {
    const reach = this.deps.reach(name)
    if (reach === null) return
    const was = this.kept.get(name)
    const one: Kept = {
      answer: was?.answer ?? null,
      at: was?.at ?? null,
      roundTrip: was?.roundTrip ?? null,
      said: was?.said ?? null,
      asked: this.deps.now(),
      busy: true,
      owed: false,
    }
    this.kept.set(name, one)
    const from = this.deps.now()
    try {
      const answer = await reach.link.request(name, MACHINE_DOOR, {})
      const back = this.deps.now()
      if (answer.status !== 200) {
        one.said =
          answer.status === 404
            ? `${name} runs a Tade that does not say what it is yet: update it there`
            : `${name} answered ${answer.status} when asked what it is`
        return
      }
      const read = MachineAnswerSchema.safeParse(answer.body)
      if (!read.success) {
        one.said = `${name} said what it is in a shape this Tade does not read`
        return
      }
      one.answer = read.data
      one.at = back
      one.roundTrip = Math.max(0, back - from)
      one.said = null
    } catch (err) {
      // A link that went down is the link's news, and the last answer stands.
      if (this.deps.reach(name)?.live === true) {
        one.said = `${name} could not be asked what it is: ${printable(why(err))}`
      }
    } finally {
      one.busy = false
      this.moved++
      this.deps.draw()
    }
  }

  /**
   * One document another machine's work produced, read into a copy in this
   * home: the copy's path, to open as any file is. Throws, in words to act on,
   * where the link is down or the machine has no such document.
   */
  async document(name: string, task: string, file: string): Promise<string> {
    const reach = this.deps.reach(name)
    if (reach === null || !reach.live) {
      throw new Error(`${name} is not linked, so its documents cannot be read now`)
    }
    const path = remoteDocumentPath(this.deps.home, name, task, file)
    const answer = await reach.link.request(name, DOCUMENT_DOOR, { task, name: file })
    if (answer.status === 404) {
      throw new Error(`${name} has no document of ${task} called ${file} to read`)
    }
    const read = DocumentAnswerSchema.safeParse(answer.body)
    if (answer.status !== 200 || !read.success) {
      throw new Error(`${name} answered ${answer.status} when asked for ${file}`)
    }
    // What the agent there wrote, as it wrote it: a copy, and drawn as text where it is read.
    const cut = read.data.cut
      ? `\n\n— cut here: ${name} sent the first ${read.data.text.length} of ${read.data.bytes} bytes —\n`
      : ''
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${read.data.text}${cut}`, { mode: 0o600 })
    return path
  }

  /**
   * One of another machine's extension tools that only reads, run there with
   * that machine's own settings: its answer as text. Throws with what it said
   * where it failed, and in words to act on where it could not be asked.
   */
  async tool(name: string, tool: string, input: Record<string, unknown>): Promise<string> {
    const reach = this.deps.reach(name)
    if (reach === null || !reach.live) {
      throw new Error(`${name} is not linked, so nothing can be asked of it now`)
    }
    const answer = await reach.link.request(name, TOOL_DOOR, { tool, input })
    if (answer.status === 404) {
      throw new Error(
        `${name} has no ${tool} that only reads: it may not have that extension on, or runs an older Tade`,
      )
    }
    const read = ToolAnswerSchema.safeParse(answer.body)
    if (answer.status !== 200 || !read.success) {
      throw new Error(`${name} answered ${answer.status} when asked to run ${tool}`)
    }
    // Another machine's words, as text line by line, under the machine they came from.
    const said = printableLines(read.data.text)
    if (read.data.failed) throw new Error(`${tool} on ${name}: ${said}`)
    return said
  }
}

function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
