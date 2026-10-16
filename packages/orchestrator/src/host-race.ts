// The `ToolHost` methods behind the race tools (`tools-race.ts`): starting a
// race, reading where it stands, and picking one. Their own file because
// `tool-host.ts` is near its budget, and because three methods that share one
// boundary read better in one place.
//
// **All three are the window's.** A race is a plan the window's queue starts;
// where it stands is folded from what the window holds — every entrant's
// checks, the judge's findings, the money; and a pick is checked there against
// the person's own lines in the journal (`RACE_PICK`), never here, where the
// model's call lands.

type Handler = (params: Record<string, unknown>) => Promise<string>

/** One entrant, as the orchestrator names it: a harness, a model, both or neither. */
export interface RaceEntrantSaid {
  harness?: string
  model?: string
}

/** What the window answers for them. Without a window there is no queue to start one. */
export interface RaceHost {
  start(req: {
    project: string
    name: string
    said: string
    prompt: string
    entrants: readonly RaceEntrantSaid[]
    n?: number
    context?: string
  }): Promise<string>
  standing(req: { project?: string; race?: string }): Promise<string>
  pick(req: {
    project?: string
    race: string
    task: string
    why: string
    said: string
  }): Promise<string>
}

/** The entrants as sent, read carefully: anything that is not one is said, not guessed. */
function entrantsOf(value: unknown): RaceEntrantSaid[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new Error('entrants is a list: one {harness, model} for each, either of them optional')
  }
  return value.map((one, at) => {
    if (one === null || typeof one !== 'object' || Array.isArray(one)) {
      throw new Error(`entrants[${at}] is not an entrant: give it a harness, a model or both`)
    }
    const { harness, model } = one as Record<string, unknown>
    return {
      ...(typeof harness === 'string' && harness.trim() ? { harness: harness.trim() } : {}),
      ...(typeof model === 'string' && model.trim() ? { model: model.trim() } : {}),
    }
  })
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

export function raceMethods(host: () => RaceHost | undefined): Record<string, Handler> {
  const of = (): RaceHost => {
    const found = host()
    if (!found) throw new Error('a race needs the Tade window open, which starts queued work')
    return found
  }
  return {
    'race/start': async (p) =>
      of().start({
        project: text(p.project),
        name: text(p.name),
        said: text(p.said),
        prompt: text(p.prompt),
        entrants: entrantsOf(p.entrants),
        ...(typeof p.n === 'number' ? { n: p.n } : {}),
        ...(text(p.context) ? { context: text(p.context) } : {}),
      }),
    'race/standing': async (p) =>
      of().standing({
        ...(text(p.project) ? { project: text(p.project) } : {}),
        ...(text(p.race) ? { race: text(p.race) } : {}),
      }),
    'race/pick': async (p) =>
      of().pick({
        ...(text(p.project) ? { project: text(p.project) } : {}),
        race: text(p.race),
        task: text(p.task),
        why: text(p.why),
        said: text(p.said),
      }),
  }
}
