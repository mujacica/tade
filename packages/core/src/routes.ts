import type { Config, WorkerRoute } from './config.ts'

// Which agent, on which model, for this piece of work. Pure and table-tested:
// the answer must be predictable before anything is spawned.

export interface ResolvedRoute extends WorkerRoute {
  /** Route name, for status output and events. */
  name: string
}

export interface RouteQuery {
  /** Explicit override, e.g. `wilco spawn --worker local`. */
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

/** The route the orchestrator itself runs on. */
export function orchestratorRoute(config: Config): ResolvedRoute {
  const { harness, provider, model } = config.orchestrator
  return {
    name: 'orchestrator',
    harness,
    sandbox: 'none',
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
  }
}
