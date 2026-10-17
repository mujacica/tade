import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  CONNECT_FLOWS,
  CONNECT_SOURCES,
  CONNECT_TITLES,
  type ConnectSource,
  printable,
  printableLines,
  remoteDocumentPath,
} from '@tade/core'
import type { Remote, RemoteLink } from '@tade/remotes-core'
import {
  CARDS_MOST,
  type ConnectAnswer,
  ConnectAnswerSchema,
  DocumentAnswerSchema,
  type EvaluationsAnswer,
  EvaluationsAnswerSchema,
  esc,
  MachineAnswerSchema,
  type RecordsAnswer,
  RecordsAnswerSchema,
  ToolAnswerSchema,
} from '@tade/web'
import type { LookHeld } from '../machine-looks.ts'
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
//
// **Two more things are asked only while somebody here is looking**
// (`RemoteMachinesDeps.looking`), because each is asked again of the world or
// folded again over a journal there, and nobody here reads them otherwise:
// the records its public name needs (`/api/records`), looked at there by that
// machine's own `tade host domain` look — once for each opening of Settings ›
// Remotes, and again on its Look again, which is the look's own rule there
// (`web-domain.ts`) — and its scorecards (`GET /api/evaluations`), while /evals
// is open on a grouping, and every `AGAIN_MS` while it stays open. Both are
// kept when the page closes or the link goes down, with when they came, so a
// page opened again says as of when until the next answer.
//
// **And how connecting each source there stands** (`/api/connect`,
// REMOTE-TADE §6.4), asked with the records — the same openings, the same Look
// again — of a machine that said it has a public name, because that is where
// each source can send a browser here back to. A press on one of its steps
// asks that machine for the one-time word and the form (`connectPress`): this
// window's browser cannot reach that machine's own `/connect`, whose link ends
// in a socket no browser opens, so GitHub's form goes in a page in this home
// that posts itself to GitHub, and Slack's and Linear's addresses are opened as
// they are; each sends the browser on to that machine's public name, and
// Linear's proof key stays with the word on that machine. What Slack's and
// Linear's own pages show the person — their secrets and ids — is pasted at
// that machine's own page, never carried here.

/** How long a linked remote goes before what it is, is asked again. */
export const AGAIN_MS = 60_000

/** The far side's doors (`@tade/web`'s `machine.ts`, `document.ts`, `tool-read.ts`). */
const MACHINE_DOOR = '/api/machine'
const DOCUMENT_DOOR = '/api/document'
const TOOL_DOOR = '/api/tool'
const RECORDS_DOOR = '/api/records'
const CARDS_DOOR = '/api/evaluations'
const CONNECT_DOOR = '/api/connect'

export interface RemoteMachinesDeps {
  home: string
  /** The link that holds a remote and the remote as it was opened, or null for none held. */
  reach: (name: string) => { link: RemoteLink; remote: Remote; live: boolean } | null
  now: () => number
  /** What is held moved: a frame, to draw what reads it. */
  draw: () => void
  /**
   * What somebody here is looking at now: Settings › Remotes (`records`), and
   * /evals on a grouping (`scorecards`). Absent, nobody ever is.
   */
  looking?: () => { records: boolean; scorecards: boolean }
}

interface Kept extends AboutHeld {
  /** When it was last asked, or last could not be. */
  asked: number
  busy: boolean
  /** It is owed an ask on the next beat: its link has just come up. */
  owed: boolean
}

/** One look asked while somebody looks, and when it was last asked. */
interface LookKept<T> extends LookHeld<T> {
  asked: number
}

export class RemoteMachines {
  private readonly deps: RemoteMachinesDeps
  private readonly kept = new Map<string, Kept>()
  private readonly records = new Map<string, LookKept<RecordsAnswer>>()
  private readonly cards = new Map<string, LookKept<EvaluationsAnswer>>()
  private readonly connects = Object.fromEntries(
    CONNECT_SOURCES.map((source) => [source, new Map<string, LookKept<ConnectAnswer>>()]),
  ) as Record<ConnectSource, Map<string, LookKept<ConnectAnswer>>>
  /** The remotes whose records this opening of Settings › Remotes has not asked for yet. */
  private readonly recordsOwed = new Set<string>()
  /** What was being looked at on the last beat, so an opening is told from staying open. */
  private was = { records: false, scorecards: false }
  /** Moved whenever something held moved, so what folds it folds again. */
  private moved = 0

  constructor(deps: RemoteMachinesDeps) {
    this.deps = deps
  }

  /** What is held for one remote: its last answers and why there are none, or null before anything. */
  held(name: string): AboutHeld | null {
    const about = this.kept.get(name)
    const records = this.records.get(name) ?? null
    const cards = this.cards.get(name) ?? null
    const connects = Object.fromEntries(
      CONNECT_SOURCES.flatMap((source) => {
        const one = this.connects[source].get(name)
        return one === undefined ? [] : [[source, one]]
      }),
    ) as Partial<Record<ConnectSource, LookKept<ConnectAnswer>>>
    const asked = Object.keys(connects).length > 0
    if (about === undefined && records === null && cards === null && !asked) return null
    return {
      answer: about?.answer ?? null,
      at: about?.at ?? null,
      roundTrip: about?.roundTrip ?? null,
      said: about?.said ?? null,
      records,
      cards,
      connects,
    }
  }

  /** Moves whenever anything held moved. */
  revision(): number {
    return this.moved
  }

  /** The window's beat: ask every linked remote that is due. Returns at once. */
  beat(names: readonly string[]): void {
    const now = this.deps.now()
    const looking = this.deps.looking?.() ?? { records: false, scorecards: false }
    // An opening of the page owes every remote one look, asked once it can be.
    if (looking.records && !this.was.records) for (const name of names) this.recordsOwed.add(name)
    if (!looking.records) this.recordsOwed.clear()
    const opened = looking.scorecards && !this.was.scorecards
    this.was = looking
    for (const name of names) {
      if (this.deps.reach(name)?.live !== true) continue
      const one = this.kept.get(name)
      if (one?.busy !== true && (one === undefined || one.owed || now - one.asked >= AGAIN_MS)) {
        void this.ask(name)
      }
      // Only of a machine that said it has a public name: nothing else has records to look at.
      if (this.recordsOwed.has(name) && one?.answer?.public != null) void this.lookAgain(name)
      const cards = this.cards.get(name)
      if (
        looking.scorecards &&
        cards?.busy !== true &&
        (opened || cards === undefined || now - cards.asked >= AGAIN_MS)
      ) {
        void this.scorecards(name)
      }
    }
  }

  /**
   * Its public name's records, looked at there now — on an opening of Settings
   * › Remotes, or its Look again. Nothing while a look is under way, or while
   * its link is down. Never throws.
   */
  async lookAgain(name: string): Promise<void> {
    const reach = this.deps.reach(name)
    if (reach === null || !reach.live || this.records.get(name)?.busy === true) return
    this.recordsOwed.delete(name)
    for (const source of CONNECT_SOURCES) void this.connectLook(name, source)
    await this.look(name, this.records, async () => {
      const answer = await reach.link.request(name, RECORDS_DOOR, {})
      if (answer.status === 404) {
        return `${name} runs a Tade that does not look at its records for another machine yet: update it there`
      }
      if (answer.status !== 200) {
        return `${name} answered ${answer.status} when asked to look at its records`
      }
      const read = RecordsAnswerSchema.safeParse(answer.body)
      return read.success
        ? read.data
        : `${name} said what its records are in a shape this Tade does not read`
    })
  }

  /** How connecting one source there stands, as that machine folds it. Never throws. */
  private async connectLook(name: string, source: ConnectSource): Promise<void> {
    const reach = this.deps.reach(name)
    const held = this.connects[source]
    if (reach === null || !reach.live || held.get(name)?.busy === true) return
    await this.look(name, held, () => this.askConnect(name, reach.link, source, {}))
  }

  /** One owner's ask of `/api/connect`: its answer read for its shape, or why there is none. */
  private async askConnect(
    name: string,
    link: RemoteLink,
    source: ConnectSource,
    press: { press?: 'make' | 'install' },
  ): Promise<ConnectAnswer | string> {
    const title = CONNECT_TITLES[source]
    const answer = await link.request(name, CONNECT_DOOR, { source, ...press })
    // A Tade from before a source could be connected refuses its name as a
    // shape it does not know, which is the same answer as no door at all.
    if (answer.status === 404 || (answer.status === 400 && source !== 'github')) {
      return `${name} runs a Tade that cannot connect ${title} for another machine yet: update it there`
    }
    if (answer.status !== 200) return `${name} answered ${answer.status} when asked about ${title}`
    const read = ConnectAnswerSchema.safeParse(answer.body)
    return read.success && read.data.page.source === source
      ? read.data
      : `${name} said how ${title} is connected there in a shape this Tade does not read`
  }

  /**
   * A press on one of connecting a source's steps there: what to open here —
   * that source's own address, or a page in this home that posts GitHub the
   * form making the App — once that machine has minted the word for it. What
   * it answered is held, so the page redraws from it. Throws, in that
   * machine's words or Tade's, where nothing was made to open.
   */
  async connectPress(
    name: string,
    source: ConnectSource,
    press: 'make' | 'install',
  ): Promise<string> {
    const title = CONNECT_TITLES[source]
    const reach = this.deps.reach(name)
    if (reach === null || !reach.live) {
      throw new Error(`${name} is not linked, so ${title} cannot be connected there now`)
    }
    const got = await this.askConnect(name, reach.link, source, { press })
    if (typeof got === 'string') throw new Error(got)
    this.connects[source].set(name, {
      answer: got,
      at: this.deps.now(),
      said: null,
      busy: false,
      asked: this.deps.now(),
    })
    this.moved++
    this.deps.draw()
    const form = got.form
    if (form === null) throw new Error(printable(got.cannot ?? `${name} made nothing to press`))
    // Another machine's answer, opened in this machine's browser: the
    // source's own pages and nothing else, whatever it said.
    const url = new URL(form.url)
    if (url.protocol !== 'https:' || !CONNECT_FLOWS[source].goes.includes(url.hostname)) {
      throw new Error(`${name} answered with somewhere other than ${title} to go: not opened`)
    }
    if (form.fields === undefined) return url.href
    if (source !== 'github') {
      throw new Error(
        `${name} answered ${title} with a form to post, which it never asks: not opened`,
      )
    }
    const path = connectPagePath(this.deps.home, name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, postingPage(name, url.href, form.fields), { mode: 0o600 })
    return pathToFileURL(path).href
  }

  /** Its scorecards over all its work, as it folds them there. Never throws. */
  async scorecards(name: string): Promise<void> {
    const reach = this.deps.reach(name)
    if (reach === null || !reach.live || this.cards.get(name)?.busy === true) return
    await this.look(name, this.cards, async () => {
      const answer = await reach.link.request(name, CARDS_DOOR)
      if (answer.status !== 200) {
        return `${name} answered ${answer.status} when asked for its scorecards`
      }
      const read = EvaluationsAnswerSchema.safeParse(withinCards(answer.body))
      return read.success
        ? read.data
        : `${name} said what it scored in a shape this Tade does not read`
    })
  }

  /** One ask of a look, held: its answer and when, or why there is none. Never throws. */
  private async look<T>(
    name: string,
    held: Map<string, LookKept<T>>,
    ask: () => Promise<T | string>,
  ): Promise<void> {
    const was = held.get(name)
    const one: LookKept<T> = {
      answer: was?.answer ?? null,
      at: was?.at ?? null,
      said: was?.said ?? null,
      busy: true,
      asked: this.deps.now(),
    }
    held.set(name, one)
    this.moved++
    this.deps.draw()
    try {
      const got = await ask()
      if (typeof got === 'string') one.said = got
      else {
        one.answer = got
        one.at = this.deps.now()
        one.said = null
      }
    } catch (err) {
      // A link that went down is the link's news, and the last answer stands.
      if (this.deps.reach(name)?.live === true) {
        one.said = `${name} could not be asked: ${printable(why(err))}`
      }
    } finally {
      one.busy = false
      this.moved++
      this.deps.draw()
    }
  }

  /** A link came up: what it is, is asked on the next beat. */
  up(name: string): void {
    const one = this.kept.get(name)
    if (one !== undefined) one.owed = true
  }

  /** A remote no longer in the config: what it said goes with it. */
  forget(name: string): void {
    const went = [
      this.kept.delete(name),
      this.records.delete(name),
      this.cards.delete(name),
      ...CONNECT_SOURCES.map((source) => this.connects[source].delete(name)),
    ]
    this.recordsOwed.delete(name)
    if (went.some(Boolean)) this.moved++
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

/**
 * Where the page that posts the form making another machine's GitHub App is
 * written: one per machine, written over by the next press, under the folder
 * this home keeps that machine's copies in. The name is held to
 * `remotes.<name>`'s shape again here, so no other path can be made of it.
 */
export function connectPagePath(home: string, machine: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(machine)) {
    throw new Error('a connect page is kept only for a machine named by `remotes.<name>`')
  }
  return join(home, 'remotes', machine, 'connect-github.html')
}

/**
 * A page that posts one form to GitHub as soon as it opens: making an App is a
 * press at a page the person is signed in on, so this is that page, here. It
 * carries the manifest and the one-time word and nothing else — no key, no
 * session — and is written `0600`, gone over when the next press writes it.
 */
export function postingPage(
  name: string,
  action: string,
  fields: Readonly<Record<string, string>>,
): string {
  const inputs = Object.entries(fields)
    .map(([key, value]) => `<input type="hidden" name="${esc(key)}" value="${esc(value)}">`)
    .join('')
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer">',
    `<title>Making the GitHub App for ${esc(name)}</title></head><body>`,
    `<p>Taking you to GitHub to make the App for ${esc(name)}…</p>`,
    `<form id="make" method="post" action="${esc(action)}">${inputs}<button>Go to GitHub</button></form>`,
    "<script>document.getElementById('make').submit()</script>",
    '</body></html>',
  ].join('')
}

function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Its scorecards' groupings cut to what this Tade reads of one before they are
 * read for their shape: a machine with more models than that is still read,
 * its first ones — it sends them in its own order — rather than refused whole.
 */
function withinCards(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return body
  const by = (body as { by?: unknown }).by
  if (typeof by !== 'object' || by === null) return body
  const cut = Object.fromEntries(
    Object.entries(by).map(([key, rows]) => [
      key,
      Array.isArray(rows) ? rows.slice(0, CARDS_MOST) : rows,
    ]),
  )
  return { ...body, by: cut }
}
