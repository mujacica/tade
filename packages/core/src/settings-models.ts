import { type Config, HARNESS_IDS, type ThinkingLevel } from './config.ts'
import { HARNESS_CHOICES } from './model.ts'
import type { Setting, SettingGroup } from './settings.ts'

// What new agents start on: each route's model, thinking and harness, and what
// they start on in each other harness under it (`routeIn`). Every one of them
// is a default, and every default is a row, because a default somebody can ask
// for has to be one somebody can find: the Settings page and `tade_settings`
// read this same list, and the orchestrator changes a row with
// `tade_setting_change`, on the person's own words naming it (`ALLOWED_UNDER`).
// Switching one running agent writes none of them. Its own file because
// `settings.ts` is at its budget, the reason `settings-keep.ts` gives.
//
// **No `provider` row, on purpose.** Which provider a route sends work to is
// the person's, in `config.yaml`, and never the orchestrator's (`NEVER`); a
// model row writes its own key alone, as `provider/id` where the harness names
// a model that way — so the default route, which sets no provider, is given a
// model without anything written beside it.

/** `thinksAt` is what a harness can be told to think at, least to most: none is no row. */
export function modelsGroup(
  config: Config,
  thinksAt: (harness: string) => readonly ThinkingLevel[],
): SettingGroup {
  const main = config.workers.default
  const others = Object.keys(config.workers.routes)
    .filter((name) => name !== main)
    .sort()
  return {
    id: 'models',
    title: 'Models',
    about:
      'What new agents start on, unless a project says otherwise. Switching one agent changes that agent alone.',
    settings: [main, ...others].flatMap((name) => routeRows(config, name, name === main, thinksAt)),
  }
}

/** One route's rows: its own three, then a model and thinking for each other harness. */
function routeRows(
  config: Config,
  name: string,
  main: boolean,
  thinksAt: (harness: string) => readonly ThinkingLevel[],
): Setting[] {
  const route = config.workers.routes[name]
  const harness = route?.harness ?? 'pi'
  const at = `workers.routes.${name}`
  // The default route's rows keep the names they have always had; another
  // route's say which, and whose new agents it is.
  const title = main ? 'Agent' : `${name} route`
  const users = Object.keys(config.projects).filter((one) => config.projects[one]?.worker === name)
  const whose = main
    ? 'new agents'
    : `new agents in ${users.join(', ') || 'a project that names it'}`
  const rows: Setting[] = [
    {
      path: `${at}.model`,
      title: `${title} model`,
      means: `the model ${whose} start on; the harness picks when unset`,
      value: shown(route),
      fallback: 'the harness decides',
      type: { kind: 'model', harness },
      live: true,
    },
    {
      path: `${at}.thinking`,
      title: `${title} thinking`,
      means: `how hard ${whose} think; each agent can be changed from its pane`,
      value: route?.thinking ?? '',
      fallback: 'the harness decides',
      type: { kind: 'choice', options: [...thinksAt(harness)] },
      live: true,
    },
    {
      path: `${at}.harness`,
      title: `${title} harness`,
      means: `what runs ${whose}; each agent can be moved to another from its pane`,
      value: harness,
      fallback: 'pi',
      type: { kind: 'choice', options: [...HARNESS_IDS] },
      live: true,
    },
  ]
  // Another harness than the route's: what an agent moved there from its pane,
  // or started there by name, begins on — never the route's own model, which
  // is a name that harness never heard of.
  for (const other of HARNESS_CHOICES.filter((one) => one.ready && one.id !== harness)) {
    const chosen = route?.harnesses?.[other.id as keyof NonNullable<typeof route.harnesses>]
    const named = main ? other.title : `${name} route ${other.title}`
    const where = `${whose} start on in ${other.title}`
    rows.push({
      path: `${at}.harnesses.${other.id}.model`,
      title: `${named} model`,
      means: `the model ${where}; ${other.title} picks when unset`,
      value: shown(chosen),
      fallback: `${other.title} decides`,
      type: { kind: 'model', harness: other.id },
      live: true,
    })
    const levels = thinksAt(other.id)
    if (levels.length === 0) continue
    rows.push({
      path: `${at}.harnesses.${other.id}.thinking`,
      title: `${named} thinking`,
      means: `how hard ${whose} think in ${other.title}; ${other.title} decides when unset`,
      value: chosen?.thinking ?? '',
      fallback: `${other.title} decides`,
      type: { kind: 'choice', options: [...levels] },
      live: true,
    })
  }
  return rows
}

/**
 * A model as its row shows it: `provider/id` where a provider is kept beside
 * it, and the provider said once. A route with a `provider` whose model row was
 * written as the row offers it — `anthropic/claude-…` — holds the provider
 * twice, which pi takes as one model (`--provider p --model p/id`), and the row
 * read back as `anthropic/anthropic/claude-…`.
 */
function shown(at: { provider?: string | undefined; model?: string | undefined } | undefined) {
  if (!at?.model) return ''
  if (!at.provider || at.model.startsWith(`${at.provider}/`)) return at.model
  return `${at.provider}/${at.model}`
}
