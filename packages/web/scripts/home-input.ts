import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { NoteSchema, noSpend, PROJECTS_DIR, TaskFile, taskOrigin } from '@tade/core'
import { parse } from 'yaml'
import type { NoteIn, ProjectIn, SnapshotInput, TaskIn } from '../src/input.ts'
import type { Reach } from '../src/reach.ts'

// A `SnapshotInput` built from a real `TADE_HOME`, for measuring with.
//
// Under `scripts/` and not `src/` on purpose: nothing here ships
// (`scripts/release/stage.ts` copies only `src/` and `skills/`), nothing in
// the window imports it, and it reads the filesystem, which `src/snapshot.ts`
// and its neighbours may not.
//
// **It reads the half of the state that is in files and says so.** A task
// file, a project folder and `memory.jsonl` are the real authored strings and
// the real counts, which is what a size measurement is about. Git, spend,
// checks and reviews are the window's live look and are not reachable from
// here — those rows come out with their unknowns, and `sayMeasurement`'s
// unknown count is how that shows rather than being hidden.
//
// Nothing here prints anything. What it hands back holds the person's own
// words, like any other input; `src/measure.ts` is the thing that only ever
// emits numbers, and `test/measure.test.ts` is what holds it to that.

const lines = (path: string): string[] => {
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}

const folders = (path: string): string[] => {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/** A task file, or null on anything this cannot read — never a throw. */
function taskFileAt(path: string): TaskFile | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  try {
    return TaskFile.parse(parse(text))
  } catch {
    return null
  }
}

function taskIn(project: string, folder: string, file: TaskFile): TaskIn {
  const id = file.id ?? `${project}/${folder}`
  const origin = taskOrigin(file.by)
  return {
    id,
    project,
    // Nothing here looks at git or at a process, so the state is the one thing
    // a file can answer on its own and the rest is honestly unknown.
    state: file.parked ? 'parked' : 'queued',
    reason: { kind: 'clause', said: file.parked ? 'parked by you' : 'no agent has started' },
    stalled: false,
    createdAt: file.created.getTime(),
    movedAt: null,
    title: file.title ?? '',
    intent: file.intent_spoken,
    branch: '',
    ahead: null,
    behind: null,
    dirty: null,
    workspace: file.workspace ?? 'checkout',
    shared: (file.workspace ?? 'checkout') === 'checkout',
    effort: file.effort ?? '',
    done: file.done ?? null,
    produces: file.produces === undefined ? null : { name: file.produces, written: false },
    harness: file.harness ?? '',
    model: file.start?.model?.id ?? '',
    account: file.account ?? '',
    origin: { kind: origin.kind, name: origin.name },
    agents: 0,
    lanes: file.lanes.length,
    question: false,
    approval: null,
    spend: noSpend(),
    checks: { state: 'unknown', failed: [], missing: [], overridden: false },
    review: null,
  }
}

function notesIn(home: string): NoteIn[] {
  const out: NoteIn[] = []
  for (const line of lines(join(home, 'memory.jsonl'))) {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      continue
    }
    const note = NoteSchema.safeParse(raw)
    if (!note.success) continue
    out.push({
      text: note.data.text,
      summary: note.data.summary ?? '',
      scope: note.data.scope,
      by: note.data.by,
      at: note.data.at,
    })
  }
  return out
}

/**
 * Everything a projection of this home would be built from, as far as files
 * can say.
 *
 * `reach` is the caller's, so a measurement can be taken of a device granted
 * everything and of one granted nothing, which are the two numbers worth
 * having.
 */
export function inputFrom(home: string, reach: Reach, now: number): SnapshotInput {
  const projects: ProjectIn[] = []
  const tasks: TaskIn[] = []
  for (const name of folders(join(home, PROJECTS_DIR))) {
    projects.push({ name, title: '' })
    const dir = join(home, PROJECTS_DIR, name, 'tasks')
    for (const folder of folders(dir)) {
      const file = taskFileAt(join(dir, folder, 'task.yaml'))
      if (file === null) continue
      tasks.push(taskIn(name, folder, file))
    }
  }
  return {
    lifetime: { epoch: 'measured-0000-4000-8000-000000000000', rev: 0, openedAt: now },
    reach,
    projects,
    tasks,
    queue: tasks
      .filter((task) => task.state === 'queued')
      .map((task) => ({
        task: task.id,
        project: task.project,
        state: { kind: 'ready' as const },
        order: null,
        waitsOn: [],
      })),
    findings: [],
    notes: notesIn(home),
    plans: [],
    warnings: ['measured from files alone: git, spend, checks and reviews were not looked at'],
    machineUpSince: upSince(home),
    // Nothing is folded here: this reads task files and never the journal, so
    // there is no period any money figure covers and no figure to cover.
    spendSince: null,
  }
}

/** When the home was made, which is the nearest thing a file can say. */
function upSince(home: string): number | null {
  try {
    return statSync(home).birthtimeMs || null
  } catch {
    return null
  }
}
