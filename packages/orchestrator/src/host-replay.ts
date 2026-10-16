// The `ToolHost` methods behind the replay tools (`tools-replay.ts`): starting
// one and reading where it stands. Their own file for the reason `host-race.ts`
// gives — `tool-host.ts` is near its budget.
//
// **Both are the window's.** Starting is a plan the window's queue starts and
// paces, refused there unless a line of the person's asks for an eval
// (`REPLAY_START`); where one stands is folded from what the window holds.

type Handler = (params: Record<string, unknown>) => Promise<string>

/** What a replay is started with, as the orchestrator sends it. */
export interface ReplayStartSaid {
  project: string
  name: string
  said: string
  candidate: { harness?: string; model?: string }
  last?: number
  ceilingUsd: number
  at?: string
  atOnce?: number
}

/** What the window answers for them. Without a window there is no queue to start one. */
export interface ReplayHost {
  start(req: ReplayStartSaid): Promise<string>
  standing(req: { project?: string; replay?: string }): Promise<string>
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/** A number the orchestrator sent, or the reason it is not one. */
function numberOf(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} is a number`)
  }
  return value
}

export function replayMethods(host: () => ReplayHost | undefined): Record<string, Handler> {
  const of = (): ReplayHost => {
    const found = host()
    if (!found) throw new Error('a replay needs the Tade window open, which starts queued work')
    return found
  }
  return {
    'replay/start': async (p) => {
      const ceiling = numberOf(p.ceiling_usd, 'ceiling_usd')
      if (ceiling === undefined) {
        throw new Error(
          'a replay costs money: ask them the most it may spend, and pass it as ceiling_usd',
        )
      }
      const last = numberOf(p.last, 'last')
      const atOnce = numberOf(p.at_once, 'at_once')
      return of().start({
        project: text(p.project),
        name: text(p.name),
        said: typeof p.said === 'string' ? p.said : '',
        candidate: {
          ...(text(p.harness) ? { harness: text(p.harness) } : {}),
          ...(text(p.model) ? { model: text(p.model) } : {}),
        },
        ceilingUsd: ceiling,
        ...(last !== undefined ? { last } : {}),
        ...(text(p.at) ? { at: text(p.at) } : {}),
        ...(atOnce !== undefined ? { atOnce } : {}),
      })
    },
    'replay/standing': async (p) =>
      of().standing({
        ...(text(p.project) ? { project: text(p.project) } : {}),
        ...(text(p.replay) ? { replay: text(p.replay) } : {}),
      }),
  }
}
