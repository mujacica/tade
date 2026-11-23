import { type FleetEvent, summariseWork } from '@tade/core'
import { readFeeds } from '@tade/workbench/feeds'
import { happeningThere } from '../happening.ts'

// The other machines' journals, as the copies under this home have them, for
// search to fold into what each of their rows says (`about`), the way this
// machine's own journal is folded into its rows: a finished task on the hub is
// found by its name from the Mac, labelled with the machine it is on.
//
// **Read in the background, and never waited for.** At most every `EVERY_MS`,
// when search asks; what was read last answers meanwhile, and what could not
// be read is said once and the last answer kept — a look that could not read
// a copy is not a copy with nothing in it.

/** How long one reading of the copies answers before search reads them again. */
const EVERY_MS = 60_000

/** How many of a machine's tasks its project rows carry, newest first. */
const TASKS_PER_PROJECT = 12

/** A copy's lines, by the id of the machine it came from. */
type Held = Map<string, readonly FleetEvent[]>

export interface FleetJournalsDeps {
  home: string
  now(): number
  /** The id of the machine a remote is, by its name here, where its journal is kept here. */
  idOf(remote: string): string | null
  /** Said once per trouble. */
  say(said: string): void
  /** Something new was read: a frame, so search shows it. */
  draw(): void
}

export class FleetJournals {
  private readonly deps: FleetJournalsDeps
  private held: Held = new Map()
  private at = Number.NEGATIVE_INFINITY
  private reading = false
  private troubled: string | null = null

  constructor(deps: FleetJournalsDeps) {
    this.deps = deps
  }

  /** Read the copies again where the last reading is old. Returns at once. */
  look(): void {
    const now = this.deps.now()
    if (this.reading || now - this.at < EVERY_MS) return
    this.reading = true
    this.at = now
    void readFeeds(this.deps.home)
      .then((feeds) => {
        this.held = new Map(feeds.map((feed) => [feed.machine, feed.events]))
        this.troubled = null
        this.deps.draw()
      })
      .catch((err: unknown) => {
        const said = `other machines' journals could not be read for search: ${err instanceof Error ? err.message : String(err)}`
        if (said !== this.troubled) this.deps.say(said)
        this.troubled = said
      })
      .finally(() => {
        this.reading = false
      })
  }

  /** What a remote's journal says of one of its tasks, labelled with it; '' where it says nothing. */
  aboutTask(remote: string, task: string): string {
    const events = this.eventsOf(remote)
    if (events.length === 0) return ''
    return happeningThere(remote, summariseWork(events, task, this.deps.now()))
  }

  /**
   * What a remote's journal says of one of its projects: the tasks it wrote
   * anything down about lately, newest first, so a task there is found by its
   * name. '' where it says nothing.
   */
  aboutProject(remote: string, project: string): string {
    const tasks: string[] = []
    const events = this.eventsOf(remote)
    for (let n = events.length - 1; n >= 0 && tasks.length < TASKS_PER_PROJECT; n--) {
      const task = events[n]?.task
      if (typeof task === 'string' && task.startsWith(`${project}/`) && !tasks.includes(task)) {
        tasks.push(task)
      }
    }
    return tasks.length > 0 ? `on ${remote}, its journal names: ${tasks.join(', ')}` : ''
  }

  private eventsOf(remote: string): readonly FleetEvent[] {
    const id = this.deps.idOf(remote)
    return id === null ? [] : (this.held.get(id) ?? [])
  }
}
