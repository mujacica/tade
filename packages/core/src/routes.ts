import type { Config, ThinkingLevel, WorkerRoute } from './config.ts'

// Which agent, on which model, for this piece of work. Pure and table-tested:
// the answer must be predictable before anything is spawned.

export interface ResolvedRoute extends WorkerRoute {
  /** Route name, for status output and events. */
  name: string
}

export interface RouteQuery {
  /** Explicit override, e.g. `tade spawn --worker local`. */
  route?: string | undefined
  /** Project the task belongs to. */
  project?: string | undefined
}

export class UnknownRouteError extends Error {
  readonly code = 'UNKNOWN_ROUTE'
  constructor(name: string, available: string[]) {
    super(`unknown worker route "${name}" (have: ${available.join(', ') || 'none'})`)
    this.name = 'UnknownRouteError'
  }
}

/**
 * Narrowest wins: an explicit override, then the project's route, then the
 * configured default. With exactly one route defined, that one is the default
 * whatever it is called.
 */
export function resolveRoute(config: Config, query: RouteQuery = {}): ResolvedRoute {
  const routes = config.workers.routes
  const names = Object.keys(routes)
  const wanted =
    query.route ??
    (query.project ? config.projects[query.project]?.worker : undefined) ??
    (names.includes(config.workers.default) ? config.workers.default : (names[0] ?? ''))

  const route = routes[wanted]
  if (!route) throw new UnknownRouteError(wanted, names)
  return { ...route, name: wanted }
}

/**
 * What new agents in one harness start on, by a route: its own model and
 * thinking level when the harness is the route's, else what was chosen for
 * that harness under it — never another harness's model.
 */
export function routeIn(
  route: ResolvedRoute,
  harness: string,
): { provider?: string; model?: string; thinking?: ThinkingLevel } {
  if (harness === route.harness) {
    return {
      ...(route.provider ? { provider: route.provider } : {}),
      ...(route.model ? { model: route.model } : {}),
      ...(route.thinking ? { thinking: route.thinking } : {}),
    }
  }
  return route.harnesses?.[harness as keyof NonNullable<typeof route.harnesses>] ?? {}
}

/**
 * What choosing a harness clears, as config paths to unset.
 *
 * A model and a thinking level are chosen per harness and never handed across
 * — `routeIn` reads a route's own model as its own harness's — so a route
 * switched from pi to Claude Code would otherwise hand Claude Code whatever
 * was picked for pi: a name that harness never heard of. Reset means unset,
 * which is the harness deciding, and is exactly where a route sits before
 * anybody has chosen anything. What was chosen for another harness under the
 * same route (`harnesses.<id>`) is untouched: it was never this harness's.
 *
 * Nothing for a path that is not a harness.
 */
export function clearedByHarness(path: string): string[] {
  if (path === 'orchestrator.harness') {
    // An account belongs to one harness, so it goes with the model.
    return [
      'orchestrator.provider',
      'orchestrator.model',
      'orchestrator.thinking',
      'orchestrator.account',
    ]
  }
  const route = /^workers\.routes\.([^.]+)\.harness$/.exec(path)
  if (!route?.[1]) return []
  const at = `workers.routes.${route[1]}`
  return [`${at}.provider`, `${at}.model`, `${at}.thinking`]
}

/**
 * A model as somebody chose it, as the two keys a route stores it in.
 *
 * `openrouter/anthropic/claude-opus-4.5` is a provider and a model; a bare
 * `claude-opus-5` is a model and no provider, which means "whichever provider
 * you have that offers it" and is what the harness does with a bare name.
 *
 * One function because there were two copies and only one of them was right:
 * the other took the first segment as the provider whatever it was, so
 * choosing a bare name wrote the *model* into `provider` and left `model`
 * empty. Empty is "the harness decides" on both keys, which is where a route
 * sits before anybody chooses anything.
 */
export function modelChosen(value: string): {
  provider: string | undefined
  model: string | undefined
} {
  const said = value.trim()
  const [first, ...rest] = said.split('/')
  if (rest.length === 0) return { provider: undefined, model: said || undefined }
  return { provider: first || undefined, model: rest.join('/') || undefined }
}

/**
 * The `provider` a route's model row keeps beside it, where writing `value`
 * there would leave the two naming different providers — its path and what it
 * is — or null where nothing beside the model has to move.
 *
 * A model row writes its own key alone, spelled `provider/id` as the harness
 * offers it (`settings-models.ts`), and shows a kept provider in front of the
 * model (`shown`). A route the old route-keeping wrote still holds a provider
 * beside its model, and pi reads the two as one: given `--provider anthropic
 * --model openrouter/anthropic/claude-opus-4.5`, pi 0.99.1 makes up an
 * anthropic model of that name, which nobody offers, and every new agent
 * starts on it. So a value spelled with the kept provider leaves it (pi takes
 * its own prefix off), a bare name names no provider and leaves it, and any
 * other provider's spelling means the provider goes — what the row shows is
 * then what runs. Moving it is the person's own press and never the
 * orchestrator's, because a route's provider is `never` (`settingReach`).
 */
export function providerBeside(
  config: Config,
  path: string,
  value: string,
): { path: string; provider: string } | null {
  const row = /^(workers\.routes\.([a-z0-9-]+)(?:\.harnesses\.([a-z0-9-]+))?)\.model$/.exec(path)
  if (!row?.[1] || !row[2] || !Object.hasOwn(config.workers.routes, row[2])) return null
  const route = config.workers.routes[row[2]]
  const harness = row[3] as keyof NonNullable<WorkerRoute['harnesses']> | undefined
  const provider = (harness === undefined ? route : route?.harnesses?.[harness])?.provider
  if (!provider) return null
  const [first = '', ...rest] = value.trim().split('/')
  if (rest.length === 0 || first.toLowerCase() === provider.toLowerCase()) return null
  return { path: `${row[1]}.provider`, provider }
}

/**
 * The provider the orchestrator keeps, where switching it to a model of
 * `provider` would move it — its path and what it is — or null where it stays.
 *
 * Where a route's is moved by `providerBeside`, the orchestrator's own is moved
 * by its model: its `Model` row and `tade_orchestrator_model` store a choice as
 * the two keys (`modelChosen`), so another provider's model writes that
 * provider over the kept one, and a bare name writes none and clears it. It is
 * where the orchestrator's own conversation is sent, so it is `never`
 * (`settingReach`), like a route's: a model of the kept provider leaves it,
 * and anything else is the person's press in Settings or on its tab's picker,
 * never the orchestrator's. Where none is kept yet — before Tade keeps the one
 * it first started on — the name picks it, as on a route that sets none.
 */
export function ownProviderMoved(
  config: Config,
  provider: string | undefined,
): { path: string; provider: string } | null {
  const kept = config.orchestrator.provider
  if (!kept || provider?.toLowerCase() === kept.toLowerCase()) return null
  return { path: 'orchestrator.provider', provider: kept }
}

/**
 * Whether a route's provider and model can only be read together with what
 * the harness offers: a provider kept beside a model spelled with a slash and
 * not with that provider. `openrouter` beside `anthropic/claude-opus-4.5` is
 * one of OpenRouter's; `anthropic` beside `openrouter/anthropic/claude-opus-4.5`
 * is a model nobody has — and the two are the same shape.
 */
export function providerInDoubt(at: { provider?: string; model?: string }): boolean {
  const { provider, model } = at
  if (!provider || !model?.includes('/')) return false
  return !model.toLowerCase().startsWith(`${provider.toLowerCase()}/`)
}

/**
 * What new agents start on by one of a route's rows (`routeIn`), given what
 * the harness offers: its model, with the provider kept beside it — unless the
 * provider has nothing of that name and the model is another provider's own
 * spelling (`providerInDoubt`). Handed both, pi would make a model up under the
 * kept provider's name; so it is the model alone, which is one the harness
 * offers, and `disagrees` is true for whoever starts the agent to say.
 *
 * Only on what the harness offers says: a pair it cannot speak to — it offered
 * nothing, or has the model under neither reading — goes on as it was written,
 * because a provider's own models (a local endpoint, one added by hand) need
 * not be among what it offers.
 */
export function startingModel(
  at: { provider?: string; model?: string },
  offered: readonly { id: string; provider: string }[],
): { model: { id: string; provider?: string } | undefined; disagrees: boolean } {
  const { provider, model } = at
  if (!model) return { model: undefined, disagrees: false }
  const kept = { id: model, ...(provider ? { provider } : {}) }
  if (!provider || !providerInDoubt(at)) return { model: kept, disagrees: false }
  if (offered.some((one) => one.id === `${provider}/${model}`)) {
    return { model: kept, disagrees: false }
  }
  const elsewhere = offered.some((one) => one.id === model && one.provider !== provider)
  return elsewhere ? { model: { id: model }, disagrees: true } : { model: kept, disagrees: false }
}

/** The route the orchestrator itself runs on. */
export function orchestratorRoute(config: Config): ResolvedRoute {
  const { harness, provider, model, thinking } = config.orchestrator
  return {
    name: 'orchestrator',
    harness,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
  }
}
