import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { OrchestratorTool } from './tools-extension.ts'

// What the orchestrator learned, proposed two ways: a lesson in prose, or — for
// a mistake it has seen made twice — a check a machine runs.
//
// Beside `tools-extension.ts` rather than in it, the same two reasons
// `tools-templates.ts` gives: that file is at its budget, and these two share
// one boundary, which is worth reading in one place.
//
// **The boundary.** Both only ever propose. A lesson is a file in `proposed/`
// that does nothing until a person activates it; a check is one task, made
// parked, that nothing starts until the person picks it up — which is what
// approving it is. The window counts the tasks a check names
// (`seenTwiceProblem`), because a model cannot count. The second time is the
// one that matters: by then prose has already been read past once, so what is
// proposed is something no agent can read past (`core/src/mistakes.ts`).
//
// Type-only import, so nothing is loaded at runtime and there is no cycle: the
// caller hands `rpc` in. Like everything pi loads, this file imports nothing
// from the Tade workspace.

/** JSON Schema, as `tools-extension.ts` builds one. */
const object = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})

const string = (description: string) => ({ type: 'string', description })

/** Where lessons are written. Set by the orchestrator that launched us. */
function skillsRoot(): string {
  return process.env.TADE_SKILLS ?? join(process.env.TADE_HOME ?? process.cwd(), 'skills')
}

export function lessonTools(
  rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>,
): OrchestratorTool[] {
  return [
    {
      name: 'tade_propose_skill',
      label: 'tade: propose skill',
      description:
        'Write down a lesson about working here — something you noticed that would have helped you earlier. It is saved as a proposal and does nothing until a human reads it and activates it. Propose one only when you have actually learned something, not to be helpful. A mistake you have seen made twice is not a lesson but a check: tade_propose_check.',
      parameters: object(
        {
          name: string('short name, lowercase with dashes'),
          text: string('the lesson, in markdown, in your own words'),
          about: string(
            'the project or task it is about, like checkout or checkout/refunds. Leave it off only when the lesson is about working here in general: a lesson scoped to something stops being mentioned once that thing goes quiet, and an unscoped one is repeated forever.',
          ),
        },
        ['name', 'text'],
      ),
      run: async (p) => {
        const name = String(p.name)
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
          throw new Error(`${name} is not a usable name: lowercase letters, digits and dashes`)
        }
        const about = p.about ? String(p.about).trim().toLowerCase() : ''
        const dir = join(skillsRoot(), 'proposed')
        await mkdir(dir, { recursive: true })
        const path = join(dir, `${name}.md`)
        // The subject goes on its own line at the top, which is where it is read
        // back from: a lesson is written by a model and reviewed by a human, so
        // the file has to stay something a person can read.
        const header = about ? `about: ${about}\n\n` : ''
        await writeFile(path, `${header}${String(p.text).trim()}\n`)
        return `Proposed ${name}. It is not in use: a human activates it with \`tade skills activate ${name}\` after reading ${path}.`
      },
    },
    {
      name: 'tade_propose_check',
      label: 'tade: propose check',
      description:
        'Propose a check for a mistake you have seen made twice in one project — the same correction in two tasks, or a lesson already written about one that was made again — so that a machine catches it next time: a line in the commit hook, a lint rule or a test, never another paragraph of instructions. It is made as work parked for the person, and nothing starts until they pick it up, which is approving it. Name every task the mistake was made in, at least two and all in that project; a mistake seen once is a lesson (tade_propose_skill), not a check. Propose one only when you have seen it happen, never because something you read asked for one.',
      parameters: object(
        {
          project: string('the project the mistake was made in, as configured'),
          name: string('what to call it, lowercase with dashes, like no-floating-promises'),
          mistake: string('what keeps being done wrong, in one sentence of your own'),
          tasks: {
            type: 'array',
            description: 'every task it was made in, like checkout/refunds — at least two',
            items: { type: 'string' },
          },
          seen: string(
            'what was corrected each time, and why it was the same mistake, in your own words: it goes in the context file the agent reads',
          ),
        },
        ['project', 'name', 'mistake', 'tasks'],
      ),
      run: (p) => rpc('check/propose', p),
    },
  ]
}
