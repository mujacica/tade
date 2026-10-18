import { type Config, HARNESS_IDS, type ThinkingLevel } from './config.ts'
import { HARNESS_CHOICES } from './model.ts'
import { ownSignInName } from './project.ts'
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
// model without anything written beside it. A provider an older route keeps
// beside it is cleared by the person's own press of another provider's model,
// and never by the orchestrator's (`providerBeside`).

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
    settings: [
      ...[main, ...others].flatMap((name) => routeRows(config, name, name === main, thinksAt)),
      ...accountRows(config),
    ],
  }
}

/**
 * Which account each harness's new agents run as, for a harness somebody has
 * added one to: a default like a model, so a row the orchestrator changes on
 * the person's own words (`ALLOWED_UNDER`), offering only the accounts there
 * are. Adding, signing in and removing one is the Accounts page's.
 */
function accountRows(config: Config): Setting[] {
  return HARNESS_CHOICES.flatMap((harness): Setting[] => {
    const names = Object.keys(config.accounts).filter(
      (name) => config.accounts[name]?.harness === harness.id,
    )
    const called = ownSignInName(config, harness.id)
    if (names.length === 0) return called === null ? [] : [nameRow(harness, called)]
    const own = ownSignInSaid(harness.title, called)
    return [
      nameRow(harness, called),
      {
        path: `workers.accounts.${harness.id}`,
        title: `${harness.title} account`,
        means: `which of your ${harness.title} sign-ins new agents run as, unless a project says otherwise; an agent already working stays on its own`,
        value: config.workers.accounts[harness.id as keyof Config['workers']['accounts']] ?? '',
        fallback: own,
        type: {
          kind: 'choice',
          options: ['', ...names],
          list: true,
          about: accountsAbout(harness.title, names, { '': own }),
        },
        live: true,
        keywords: [`${harness.title} sign-in`, `${harness.title} subscription`],
      },
    ]
  })
}

/** A harness's own sign-in as a choice says it: by the name somebody gave it, where they did. */
export function ownSignInSaid(title: string, called: string | null): string {
  return called === null ? `${title}'s own sign-in` : `${called} (${title}'s own sign-in)`
}

/**
 * What a harness's own sign-in is called (`workers.default_names`): a label,
 * so it is a row beside the account rows, offered where there is another
 * sign-in to tell it from or a name is already given. It is `asked`, not
 * `never` like `accounts` (`reach.ts`): naming one signs nothing in.
 */
function nameRow(harness: { id: string; title: string }, called: string | null): Setting {
  return {
    path: `workers.default_names.${harness.id}`,
    title: `${harness.title} own sign-in name`,
    means: `what ${harness.title}'s own sign-in is called wherever an account is shown or chosen; it still signs in where ${harness.title} always does`,
    value: called ?? '',
    fallback: 'no name',
    type: { kind: 'text', placeholder: 'work' },
    live: true,
    keywords: [`${harness.title} default account name`],
  }
}

/** An account choice's list: each option under the row's heading, the ones that are not a name labelled. */
export function accountsAbout(
  title: string,
  names: readonly string[],
  labels: Readonly<Record<string, string>>,
): Record<string, { group: string; note: string; label: string }> {
  const about: Record<string, { group: string; note: string; label: string }> = {}
  for (const [option, label] of Object.entries(labels))
    about[option] = { group: `${title} account`, note: '', label }
  for (const name of names) about[name] = { group: `${title} account`, note: '', label: name }
  return about
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
