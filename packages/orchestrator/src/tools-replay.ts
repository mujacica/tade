import type { OrchestratorTool } from './tools-extension.ts'

// Replays — your own eval — as far as the orchestrator's arm reaches into
// them: start one when the person asks for an eval, and read where it stands.
//
// Beside `tools-extension.ts` for the reasons `tools-race.ts` gives: that file
// is held to its budget, and these share one boundary worth reading in one
// place.
//
// **The boundary.** A replay spends real money on work that has already
// landed, so the window refuses to start one unless a line the person said
// lately asks for an eval (`REPLAY_START`, checked against the journal, never
// here). It is a plan underneath, refused for the same reasons, and the queue
// starts and paces it; its ceiling is enforced in the window, between
// entrants. Reading changes nothing. Nothing here judges a model: the figures
// are the project's checks, the original's tests, the judge's own question and
// what it cost — and "could not replay" is never a fail.
//
// Type-only import, so nothing is loaded at runtime and there is no cycle.
// Like everything pi loads, this file imports nothing from the Tade workspace.

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

export function replayTools(
  rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>,
): OrchestratorTool[] {
  const tools: OrchestratorTool[] = []
  const tool = (
    name: string,
    description: string,
    parameters: Record<string, unknown>,
    run: (params: Record<string, unknown>) => Promise<unknown>,
  ): void => {
    tools.push({
      name,
      label: name.replace(/^tade_/, 'tade: ').replace(/_/g, ' '),
      description,
      parameters,
      run,
    })
  }

  tool(
    'tade_replay',
    'Start a replay — their own eval: the last N tasks that landed in a project, each asked again in a worktree at the commit it began from, with its original words, on a candidate model or harness, and scored by the project’s checks, the tests the original change added, whether the judge says it did what was asked, its size beside the original, and what it cost and took. Reach for it when they ask to eval, benchmark or compare a model or a harness on their own work — and only then: it spends real money, so the window refuses it unless they asked for an eval in their own words, and it needs a ceiling in dollars they gave you. It varies one thing: a model (each task on the harness it first ran on, or only the tasks of the harness you name beside it), or a harness alone. Tasks whose words lean on a conversation nobody kept are set aside as "could not replay", never counted as fails. It is a plan underneath, run a few at a time by the queue; `at` puts it off until a time (overnight).',
    object(
      {
        project: string('the project, by the name Tade has for it'),
        name: string(
          'a short name for the replay, lowercase with dashes; the entrants are <name>-1, <name>-2, …',
        ),
        said: string('what they said asking for the eval, word for word'),
        model: string('the candidate model, as its harness names one'),
        harness: string(
          'with a model: hold this harness fixed and take only its tasks; alone: the candidate harness, on its own route',
        ),
        last: {
          type: 'number',
          description: 'how many landed tasks, newest first: 5 unless said, at most 20',
        },
        ceiling_usd: {
          type: 'number',
          description: 'the most it may spend, in dollars, as they said it',
        },
        at: string('not before this time, as an ISO time'),
        at_once: { type: 'number', description: 'how many run at once, 1 to 4; 2 unless said' },
      },
      ['project', 'name', 'said', 'ceiling_usd'],
    ),
    (p) => rpc('replay/start', p),
  )

  tool(
    'tade_replay_standing',
    'Where a replay stands, about now: each case beside its original — passed, failed (and why), could not replay (and why), running, waiting or stopped at the ceiling — with what each cost and took and how big its change is, what the replay has spent against its ceiling, and what the originals cost. Read the figures to them; nothing here picks a model. Every replay when neither is said.',
    object({
      project: string('only this project’s replays'),
      replay: string('only the replay of this name'),
    }),
    (p) => rpc('replay/standing', p),
  )

  return tools
}
