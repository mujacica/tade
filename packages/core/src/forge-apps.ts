import { findSecret } from './secrets.ts'

// The apps the person made on a forge and connected to this machine, as the
// config keeps them (REMOTE-TADE.md §6.3): today one, a GitHub App made from
// the guided page (`/connect`), whose installation tokens the forge reads with
// where it is installed (`@tade/forges-core`'s `apps.ts`).
//
// **Its keys are the intake extension's**, beside the secret its webhook signs
// with (`HOOK_SECRETS`), because connecting GitHub is one act and Settings ›
// Intake is where somebody looks for what came of it. They are read for every
// extension that asks a forge — intake's GitHub watch and the review watches
// alike — through `ExtensionContext.apps`, which the extension host answers
// out of this one table, so no two readers can name a different key.
//
// **Written once, by the page that made the app, through the one write path**
// (`writeKey`): the private key is `0600` because the file is, and is a key
// like any other — said as `set` or `not set`, never in the journal, its
// variable winning. Never carried to another machine (`carry.ts`): the app
// was made for this machine's public name, and its deliveries come here.

/** Where the GitHub App's keys live: `extensions.<GITHUB_APP_IN>.<key>`. */
export const GITHUB_APP_IN = 'intake'

/**
 * The GitHub App's keys. Only the private key is a credential, and only it has
 * a variable that wins over it — the way out of a key in a file, for whoever
 * wants one (`KEYS_AND_AGENTS`). Its id and its slug are names, and say nothing
 * anybody could sign with.
 */
export const GITHUB_APP = {
  id: {
    key: 'github_app_id',
    means:
      'the id of the GitHub App this machine reads your repositories as, where it is installed on them — written by Connect GitHub (/connect)',
  },
  key: {
    key: 'github_app_key',
    env: 'GITHUB_APP_PRIVATE_KEY',
    means:
      'the GitHub App’s private key (the .pem GitHub hands over once), which signs for the hour-long tokens it reads with — written by Connect GitHub (/connect)',
  },
  slug: {
    key: 'github_app_slug',
    means:
      'the GitHub App’s name in its addresses (github.com/apps/<slug>), for the page that installs it — written by Connect GitHub (/connect)',
  },
} as const

/** One app as a forge is handed it: where it was made, its id, its private key. */
export interface KeptApp {
  host: string
  id: string
  key: string
}

/**
 * The apps kept here, out of the extensions' settings with the environment
 * winning (`findSecret`, the one rule). A GitHub App with an id and no key —
 * or a key and no id — is none: half of one can sign for nothing.
 */
export function appsKept(
  extensions: Readonly<Record<string, Readonly<Record<string, unknown>> | undefined>>,
  env: Readonly<Record<string, string | undefined>>,
): readonly KeptApp[] {
  const settings = extensions[GITHUB_APP_IN]
  // A number where YAML read one: `github_app_id: 4242`, written by hand.
  const written = settings?.[GITHUB_APP.id.key]
  const id =
    typeof written === 'number'
      ? String(written)
      : typeof written === 'string'
        ? written.trim()
        : ''
  const key = findSecret({
    settings,
    key: GITHUB_APP.key.key,
    env,
    variables: [GITHUB_APP.key.env],
  })
  if (!key || !/^\d+$/.test(id)) return []
  return [{ host: 'github.com', id, key: key.value }]
}

/** The GitHub App's slug, where one is kept: what its install page is addressed by. */
export function appSlug(
  extensions: Readonly<Record<string, Readonly<Record<string, unknown>> | undefined>>,
): string | null {
  const found = extensions[GITHUB_APP_IN]?.[GITHUB_APP.slug.key]
  return typeof found === 'string' && /^[a-z0-9][a-z0-9-]{0,99}$/.test(found.trim())
    ? found.trim()
    : null
}
