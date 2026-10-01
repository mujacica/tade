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
    return ['orchestrator.provider', 'orchestrator.model', 'orchestrator.thinking']
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
