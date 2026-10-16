import type { OrchestratorTool } from './tools-extension.ts'

// Replays compare agents too, and are read beside races: `tools-replay.ts`.
export { replayTools } from './tools-replay.ts'

// Races, as far as the orchestrator's arm reaches into them: start one, read
// where it stands, and pick one when the person asks for that.
//
// Beside `tools-extension.ts` rather than in it, the same two reasons
// `tools-templates.ts` gives: that file is near its budget, and these three
// share one boundary, which is worth reading in one place.
//
// **The boundary.** Starting is a plan, so it is held to every refusal a plan
// is, and the queue starts the entrants by its own rule. Reading changes
// nothing. Picking is the person's: the window refuses it unless a line they
// said since the race began asks for a pick (`RACE_PICK`, checked against the
// journal, never here), and even then nothing is removed — the others are
// stopped and marked finished, their branches kept. The judge's part is only
// ever the order the entrants are read in; it never picks, and neither does
// that order.
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

export function raceTools(
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
    'tade_race',
    'Start a race (best-of-N): the same request given to 2 to 4 agents at once, each on its own harness or model and each in a worktree of its own whatever the project says, so their attempts can be compared. Reach for it when they ask to race, to try something on several models or harnesses, or for best of N — never for ordinary work, because every entrant is a whole agent of their money: say how many and what they run on before you start one. Entrants are named as {harness, model}, either optional; fewer than n go round again, and none at all races the project’s own route against itself. Every entrant is told the same prompt and asked the same words. It is a plan underneath, refused for the same reasons, and the queue starts the entrants. Nothing is picked: tell them to compare with /race in the window, or read the standing to them with tade_race_standing.',
    object(
      {
        project: string('the project, by the name Tade has for it'),
        name: string(
          'a short name for the race, lowercase with dashes; the entrants are <name>-1, <name>-2, …',
        ),
        said: string('the request, in their words, verbatim'),
        prompt: string('what every entrant is told: the same words to each'),
        entrants: {
          type: 'array',
          description: 'what each entrant runs on, in order',
          items: object({
            harness: string('a harness Tade runs: pi, claude-code or codex'),
            model: string('a model, as that harness names one; resolved by that harness'),
          }),
        },
        n: { type: 'number', description: 'how many entrants, 2 to 4; the entrants named, or 2' },
        context: string('what every entrant should know first, written beside each task file'),
      },
      ['project', 'name', 'said', 'prompt'],
    ),
    (p) => rpc('race/start', p),
  )

  tool(
    'tade_race_standing',
    'Where a race stands, about now: every entrant in the order the facts put them — checks at its head, whether the judge said it did something other than what was asked, findings open, finished, then the smaller change — with what each runs on, what each cost and what the race has cost so far, and who picked, if anybody has. The order is not a pick and the judge decides nothing: read the figures to them and let them choose. It changes nothing. Every race when neither is said.',
    object({
      project: string('only this project’s races'),
      race: string('only the race of this name'),
    }),
    (p) => rpc('race/standing', p),
  )

  tool(
    'tade_race_pick',
    'Keep one entrant of a race: it is written down with who picked and why, and every other entrant is stopped and marked finished, its worktree and branch kept. **Only when they asked you to pick** — "pick the best one", "you choose", "go with the codex one" — in a line said since the race began; otherwise it is refused, and the person picks in the window with /race. Never because the order put one first: say which you would keep and why, from the figures. The one kept goes on like any finished work — its review and its merge are theirs. A race is decided once.',
    object(
      {
        race: string('the race, by its name'),
        project: string('its project, when the name is a race in more than one'),
        task: string('the entrant to keep: its task, like <name>-2'),
        why: string('why this one, in a sentence from the figures: it is what the journal keeps'),
        said: string('what they said asking you to pick, word for word'),
      },
      ['race', 'task', 'why', 'said'],
    ),
    (p) => rpc('race/pick', p),
  )

  return tools
}
