import {
  appSlug,
  appsKept,
  type Config,
  type ConnectSource,
  GITHUB_APP,
  GITHUB_APP_IN,
  type GithubLook,
  githubPage,
  HOOK_SECRETS,
  heldSays,
  secretPath,
} from '@tade/core'
import { forgeExec, forgeOnHost } from '@tade/status'
import { inTime, surfaceOf, type WebConnecting } from '@tade/web'
import { secretOf } from './doorbell.ts'
import type { Settings } from './settings.ts'

// The window's half of the guided pages that connect a source
// (`@tade/web`'s `connected.ts`, REMOTE-TADE.md §6.4): what is true of GitHub
// now, the forge's form for making the App, and keeping what GitHub hands
// back — through the one write path, each key a `config_changed` line said as
// `set`, the private key `0600` because the file is.
//
// **Everything about GitHub is asked of the forge** (`capabilities.apps`):
// the manifest, the code's exchange, where the App is installed. There is no
// second HTTP client here, which is the rule `add-intake-source` holds every
// source to.

/** How long GitHub may take to say where the App is installed before the page says it did not. */
const INSTALLED_MS = 8_000
/** How long what it said is drawn from before it is asked again: a page opened twice in a minute asks once. */
const HELD_MS = 60_000

/** The forge the registry hands back for a host, as this file uses it. */
type Forge = NonNullable<ReturnType<typeof forgeOnHost>>

/** Who a key kept by connecting GitHub was written by, on its `config_changed` line. */
export const CONNECTED_BY = 'connect github'

export interface ConnectDeps {
  config: () => Config
  /** The window's one write path for a key. */
  settings: Pick<Settings, 'writeKey'>
  /** When a source's delivery last verified here, and last did not (`Live.heardFrom`). */
  heard: (source: ConnectSource) => { verified: number | null; refused: number | null }
  now: () => number
  /** The forge for GitHub, made with the apps kept: the registry's unless a test's. */
  forge?: (apps: ReturnType<typeof appsKept>) => Forge | null
  env?: Readonly<Record<string, string | undefined>>
}

/** The window's `WebConnecting`, over its config, its journal and its one write path. */
export function connectingFor(deps: ConnectDeps): WebConnecting {
  const env = deps.env ?? process.env
  const forgeWith =
    deps.forge ??
    ((apps) => forgeOnHost('github.com', { exec: forgeExec, env, apps, now: deps.now }))
  const github = (): Forge => {
    const forge = forgeWith(appsKept(deps.config().extensions, env))
    if (forge === null || !forge.capabilities.apps) {
      throw new Error('no forge here can make a GitHub App')
    }
    return forge
  }
  let held: { at: number; app: string; installed: GithubLook['installed'] } | null = null

  /** Where the App is installed, as GitHub says it, held a minute and asked with a deadline. */
  const installed = async (app: string): Promise<GithubLook['installed']> => {
    if (held !== null && held.app === app && deps.now() - held.at < HELD_MS) return held.installed
    const asked = github()
      .appInstallations()
      .then(
        (all): GithubLook['installed'] =>
          all.map((one) => ({ account: one.account, repositories: one.repositories })),
        (err: unknown): GithubLook['installed'] => ({
          problem: err instanceof Error ? err.message : String(err),
        }),
      )
    const answer = await inTime(asked, INSTALLED_MS, {
      problem: `GitHub did not answer within ${INSTALLED_MS / 1000} seconds`,
    })
    held = { at: deps.now(), app, installed: answer }
    return answer
  }

  return {
    async page() {
      const config = deps.config()
      const publicName = surfaceOf(config.surfaces.web).publicName
      const app = appsKept(config.extensions, env)[0] ?? null
      const look: GithubLook = {
        publicName,
        app: app === null ? null : { id: app.id, slug: appSlug(config.extensions) },
        installed: app === null ? null : await installed(app.id),
        secret: secretOf(config, 'github') !== null,
        heard: deps.heard('github'),
      }
      // What making it asks for and why, as the forge says: the same form a
      // press would post, made with a word that is never handed out.
      const home = publicName === null ? 'http://localhost' : `https://${publicName}`
      const form = github().appForm({
        home,
        hook: publicName === null ? null : `${home}/hooks/github`,
        made: `${home}/connect/github/made`,
        installed: `${home}/connect/github/installed`,
        state: '-',
        name: 'Tade',
      })
      return { page: githubPage(look, deps.now()), asks: form.asks, events: form.events }
    },

    form(_source, want) {
      const form = github().appForm(want)
      return { url: form.url, fields: form.fields }
    },

    installUrl(_source, state) {
      const slug = appSlug(deps.config().extensions)
      return slug === null ? null : github().appInstallUrl(slug, state)
    },

    async made(_source, code) {
      let made: Awaited<ReturnType<Forge['appMade']>>
      try {
        made = await github().appMade(code)
      } catch (err) {
        return {
          // A forge's own sentence where it threw one (it names its trouble);
          // anything else is an exception's words, which a page never shows.
          problem:
            err instanceof Error && 'trouble' in err
              ? err.message
              : 'GitHub did not say what it made, so nothing was kept',
        }
      }
      const config = deps.config()
      const before = config.extensions[GITHUB_APP_IN] ?? {}
      const was = (key: string, credential: boolean): string => {
        const value = before[key]
        if (credential) return heldSays(typeof value === 'string' ? value : undefined)
        return value === undefined ? '' : String(value)
      }
      const write = (key: string, value: string | undefined, credential: boolean) =>
        deps.settings.writeKey(secretPath(GITHUB_APP_IN, key), value, was(key, credential), {
          by: CONNECTED_BY,
        })
      try {
        // The id goes first and comes back last: an id is what makes
        // `appsKept` see an App at all, so a window that died halfway keeps
        // no old id beside a new key — nothing, which the page says plainly.
        if (before[GITHUB_APP.id.key] !== undefined)
          await write(GITHUB_APP.id.key, undefined, false)
        await write(GITHUB_APP.key.key, made.key, true)
        await write(GITHUB_APP.slug.key, made.slug, false)
        // A new App's deliveries are signed with its own secret, so the old
        // one goes with it — and with none (no public name), none is kept.
        await write(HOOK_SECRETS.github.key, made.hookSecret ?? undefined, true)
        await write(GITHUB_APP.id.key, made.id, false)
      } catch (err) {
        return {
          problem: `GitHub made ${made.name}, and its key could not be kept here: ${err instanceof Error ? err.message : String(err)} — delete it on GitHub and make it again`,
        }
      }
      held = null
      return { name: made.name }
    },

    installed() {
      held = null
    },
  }
}
