import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { composePrompt, describeNotes, livingSkills, type Note, type ToldPrint } from '@tade/core'
import { composeBriefing } from './briefing.ts'
import { activeSkills } from './extensions.ts'
import { skillsRoot } from './launch.ts'
import type { OrchestratorOptions } from './orchestrator.ts'

// What the orchestrator is told when it starts, composed once and
// fingerprinted, so whether its conversation holds it can be asked
// (`Holding`, `heldIn` and the rest in `core/src/told.ts`).
//
// The briefing is said at every launch and is not in any fingerprint: it is a
// snapshot with times on it, different every time, and a conversation that
// kept an old one has been told since what happened.

/** What a launch says, and its fingerprint. */
export interface Telling {
  /** Appended to the harness's own instructions, never replacing them. */
  instructions: string
  told: ToldPrint
}

export type TellingInput = Pick<
  OrchestratorOptions,
  'config' | 'notes' | 'activity' | 'now' | 'extensions' | 'journal' | 'queue' | 'efforts'
> & {
  home: string
  /** The tools it wrote for itself that load beside Tade's own. */
  written?: readonly string[]
}

function fingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/**
 * What a launch says and what it is told, composed once.
 *
 * What it is, and where things stood: one is true whenever it is read, the
 * other a snapshot with times on it, so they are said apart. The notes are
 * fingerprinted as the prompt says them (`describeNotes`), so one past the
 * newest twenty changes nothing that was said and nothing here.
 */
export function tellingOf(opts: TellingInput): Telling {
  const now = opts.now ?? Date.now()
  const config = opts.config
  const briefing = composeBriefing({
    now,
    events: opts.journal ?? [],
    projects: Object.keys(config?.projects ?? {}),
    ...(opts.efforts ? { efforts: opts.efforts } : {}),
    ...(opts.queue ? { queue: opts.queue } : {}),
  })
  // Only the lessons that still apply: one about a project nobody has touched
  // in a month is noise in every prompt.
  const skills = config
    ? livingSkills(
        activeSkills(skillsRoot(opts)),
        opts.activity ?? { lastSeenAt: {}, known: Object.keys(config.projects) },
        now,
      )
    : []
  const standing = (notes: readonly Note[]) =>
    config
      ? composePrompt({
          config,
          notes,
          skills,
          ...(opts.extensions?.prompt ? { extensions: opts.extensions.prompt } : {}),
        })
      : ''
  const extra = opts.extensions?.extras.instructions ?? ''
  const notes = opts.notes ?? []
  return {
    instructions: [standing(notes), briefing, extra].filter(Boolean).join('\n\n'),
    told: {
      tools: fingerprint(toolsSaid(opts)),
      instructions: fingerprint([standing([]), extra].join('\n\n')),
      notes: fingerprint(config ? describeNotes({ config, notes }) : ''),
    },
  }
}

/** Where Tade's own tools are declared: `tools-extension.ts` and the files it gathers from. */
const HERE = fileURLToPath(new URL('.', import.meta.url))

/**
 * Every tool it is handed, as what declares them: the files Tade's own are
 * written in, the extensions' listed for this run, and the ones it wrote for
 * itself.
 *
 * The source, not `orchestratorTools()`: that is agent-side code, kept out of
 * the window's process (`index.ts`), and it reads the list of extension tools
 * from whatever environment Tade was opened in. A change to a comment there
 * reads as a change to the tools, which costs a harness that pins one
 * compaction and costs any other nothing.
 */
function toolsSaid(opts: TellingInput): string {
  const read = (path: string) => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      // Not there is no tools, which is what the harness gets too.
      return ''
    }
  }
  const own = readdirSync(HERE)
    .filter((name) => /^tools-.*\.ts$/.test(name))
    .sort()
    .map((name) => read(`${HERE}${name}`))
  const listed = opts.extensions?.extras.tools ? read(opts.extensions.extras.tools) : ''
  return JSON.stringify([own, listed, opts.written ?? []])
}
