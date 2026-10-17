import {
  appSlug,
  appsKept,
  type Config,
  type ConnectFieldName,
  type ConnectSource,
  findSecret,
  GITHUB_APP,
  GITHUB_APP_IN,
  type GithubLook,
  githubPage,
  HOOK_SECRETS,
  heldSays,
  type SlackLook,
  secretPath,
  slackPage,
} from '@tade/core'
import {
  SLACK_APP,
  SLACK_APP_IN,
  SLACK_TOKEN,
  SLACK_TOKEN_ENV,
  SlackError,
  slackAsks,
  slackEvents,
  slackInstalled,
  slackInstallUrl,
  slackMakeUrl,
  slackWho,
} from '@tade/extension-intake'
import { forgeExec, forgeOnHost } from '@tade/status'
import { type ConnectReturn, inTime, surfaceOf, type WebConnecting } from '@tade/web'
import { secretOf } from './doorbell.ts'
import type { Settings } from './settings.ts'

// The window's half of the guided pages that connect a source
// (`@tade/web`'s `connected.ts`, REMOTE-TADE.md §6.4): what is true of each
// source now, what making its app asks for, and keeping what comes back —
// through the one write path, each key a `config_changed` line said as `set`,
// a credential `0600` because the file is.
//
// **Everything about GitHub is asked of the forge** (`capabilities.apps`):
// the manifest, the code's exchange, where the App is installed. **Everything
// about Slack is asked of the Slack door** (`@tade/extension-intake`'s
// `slack-app.ts`, over its one client): the manifest, the install's address,
// the code's exchange, who a token is. There is no second HTTP client here,
// which is the rule `add-intake-source` holds every source to.

/** How long a source may take to answer the page before the page says it did not. */
const INSTALLED_MS = 8_000
/** How long what it said is drawn from before it is asked again: a page opened twice in a minute asks once. */
const HELD_MS = 60_000
/** How long Slack may take to exchange an install's code: its code lasts ten minutes, a browser waits less. */
const EXCHANGE_MS = 15_000

/** The forge the registry hands back for a host, as this file uses it. */
type Forge = NonNullable<ReturnType<typeof forgeOnHost>>

/** Who a key kept by connecting GitHub was written by, on its `config_changed` line. */
export const CONNECTED_BY = 'connect github'
/** Who a key kept by connecting Slack was written by. */
export const SLACK_CONNECTED_BY = 'connect slack'

export interface ConnectDeps {
  config: () => Config
  /** The window's one write path for a key. */
  settings: Pick<Settings, 'writeKey'>
  /** When a source's delivery last verified here, and last did not (`Live.heardFrom`). */
  heard: (source: ConnectSource) => { verified: number | null; refused: number | null }
  now: () => number
  /** The forge for GitHub, made with the apps kept: the registry's unless a test's. */
  forge?: (apps: ReturnType<typeof appsKept>) => Forge | null
  /** What Slack is asked over: the machine's own `fetch` unless a test's Slack. */
  fetch?: typeof fetch
  env?: Readonly<Record<string, string | undefined>>
}

/** What a `keep` press writes each box it carries as, and says it as. */
const KEPT_AS: Readonly<
  Partial<Record<ConnectFieldName, { key: string; env?: string; said: string }>>
> = {
  signing_secret: {
    key: HOOK_SECRETS.slack.key,
    env: HOOK_SECRETS.slack.env,
    said: 'the signing secret',
  },
  client_id: { key: SLACK_APP.clientId.key, said: 'the client id' },
  client_secret: {
    key: SLACK_APP.clientSecret.key,
    env: SLACK_APP.clientSecret.env,
    said: 'the client secret',
  },
  token: { key: SLACK_TOKEN, env: SLACK_TOKEN_ENV, said: 'the bot token' },
}

/**
 * One source's half: everything `WebConnecting` asks, for that source. A
 * table of them, keyed by source, so a source added to `CONNECT_SOURCES` with
 * no half here is a type error rather than another branch.
 */
type Half = {
  [K in keyof WebConnecting]: WebConnecting[K] extends (
    source: ConnectSource,
    ...rest: infer Asked
  ) => infer Answer
    ? (...rest: Asked) => Answer
    : never
}

/** The window's `WebConnecting`, over its config, its journal and its one write path. */
export function connectingFor(deps: ConnectDeps): WebConnecting {
  const env = deps.env ?? process.env
  const halves: Readonly<Record<ConnectSource, Half>> = {
    github: githubHalf(deps, env),
    slack: slackHalf(deps, env),
  }
  return {
    page: (source) => halves[source].page(),
    form: (source, want) => halves[source].form(want),
    installUrl: (source, state, home) => halves[source].installUrl(state, home),
    made: (source, code) => halves[source].made(code),
    installed: (source, back) => halves[source].installed(back),
    keep: (source, fields) => halves[source].keep(fields),
  }
}

/** GitHub's half: everything asked of the forge. */
function githubHalf(deps: ConnectDeps, env: Readonly<Record<string, string | undefined>>): Half {
  const forgeWith =
    deps.forge ??
    ((apps) => forgeOnHost('github.com', { exec: forgeExec, env, apps, now: deps.now }))
  const forge = (): Forge => {
    const found = forgeWith(appsKept(deps.config().extensions, env))
    if (found === null || !found.capabilities.apps) {
      throw new Error('no forge here can make a GitHub App')
    }
    return found
  }
  let held: { at: number; app: string; installed: GithubLook['installed'] } | null = null

  /** Where the App is installed, as GitHub says it, held a minute and asked with a deadline. */
  const installed = async (app: string): Promise<GithubLook['installed']> => {
    if (held !== null && held.app === app && deps.now() - held.at < HELD_MS) return held.installed
    const asked = forge()
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
      const form = forge().appForm({
        home,
        hook: publicName === null ? null : `${home}/hooks/github`,
        made: `${home}/connect/github/made`,
        installed: `${home}/connect/github/installed`,
        state: '-',
        name: 'Tade',
      })
      return { page: githubPage(look, deps.now()), asks: form.asks, events: form.events }
    },

    form(want: Parameters<WebConnecting['form']>[1]) {
      const form = forge().appForm(want)
      return { url: form.url, fields: form.fields }
    },

    installUrl(state: string) {
      const slug = appSlug(deps.config().extensions)
      return slug === null ? null : forge().appInstallUrl(slug, state)
    },

    async made(code: string): Promise<{ name: string } | { problem: string }> {
      let made: Awaited<ReturnType<Forge['appMade']>>
      try {
        made = await forge().appMade(code)
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

    async installed() {
      held = null
      return { where: null }
    },

    async keep() {
      return { problem: 'GitHub hands its App over itself: there is nothing to paste' }
    },
  }
}

/** Slack's half: everything asked of the Slack door, over its one client. */
function slackHalf(deps: ConnectDeps, env: Readonly<Record<string, string | undefined>>): Half {
  const doFetch = deps.fetch ?? globalThis.fetch.bind(globalThis)
  let held: { at: number; token: string; installed: SlackLook['installed'] } | null = null

  /** One of the keys kept in the intake block, its variable winning (`findSecret`). */
  const keyOf = (key: string, variable?: string): string | null => {
    const found = findSecret({
      settings: deps.config().extensions[SLACK_APP_IN],
      key,
      env,
      variables: variable === undefined ? [] : [variable],
    })
    const value = found?.value.trim() ?? ''
    return value === '' ? null : value
  }
  const clientId = (): string | null => {
    const id = keyOf(SLACK_APP.clientId.key)
    return id !== null && /^\d{1,20}\.\d{1,20}$/.test(id) ? id : null
  }

  /** What Slack is asked with: this machine's `fetch`, and a signal the deadline aborts. */
  const asking = (limit: number) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), limit)
    timer.unref?.()
    return { from: { fetch: doFetch, signal: controller.signal }, done: () => clearTimeout(timer) }
  }

  /** Who the token kept here is, as Slack says it, held a minute and asked with a deadline. */
  const who = async (token: string): Promise<SlackLook['installed']> => {
    if (held !== null && held.token === token && deps.now() - held.at < HELD_MS)
      return held.installed
    const ask = asking(INSTALLED_MS)
    const asked = slackWho(ask.from, token).then(
      (one): SlackLook['installed'] => ({ team: one.team, user: one.user }),
      (err: unknown): SlackLook['installed'] => ({
        problem: err instanceof Error ? err.message : String(err),
        refused: err instanceof SlackError && err.trouble === 'auth',
      }),
    )
    const answer = await inTime(asked, INSTALLED_MS, {
      problem: `Slack did not answer within ${INSTALLED_MS / 1000} seconds`,
      refused: false,
    })
    ask.done()
    held = { at: deps.now(), token, installed: answer }
    return answer
  }

  /** One key written through the one write path, said as it was: a credential as `set`. */
  const write = (key: string, value: string | undefined, credential: boolean) => {
    const before = deps.config().extensions[SLACK_APP_IN]?.[key]
    const was = credential
      ? heldSays(typeof before === 'string' ? before : undefined)
      : before === undefined
        ? ''
        : String(before)
    return deps.settings.writeKey(secretPath(SLACK_APP_IN, key), value, was, {
      by: SLACK_CONNECTED_BY,
    })
  }

  return {
    async page() {
      const config = deps.config()
      const publicName = surfaceOf(config.surfaces.web).publicName
      const token = keyOf(SLACK_TOKEN, SLACK_TOKEN_ENV)
      const look: SlackLook = {
        publicName,
        kept: {
          clientId: clientId(),
          clientSecret: keyOf(SLACK_APP.clientSecret.key, SLACK_APP.clientSecret.env) !== null,
          signingSecret: secretOf(config, 'slack') !== null,
          token: token !== null,
        },
        installed: token === null ? null : await who(token),
        heard: deps.heard('slack'),
      }
      return {
        page: slackPage(look),
        asks: slackAsks(publicName !== null),
        events: slackEvents(publicName !== null),
      }
    },

    form(want: Parameters<WebConnecting['form']>[1]) {
      // No public name is no address: the app is made with none, and polled.
      return { url: slackMakeUrl({ name: want.name, home: want.hook === null ? null : want.home }) }
    },

    installUrl(state: string, home: string): string | null {
      const id = clientId()
      return id === null ? null : slackInstallUrl({ clientId: id, home, state })
    },

    async made() {
      return { problem: 'Slack makes its app on its own page: nothing comes back here' }
    },

    async installed(back: ConnectReturn): Promise<{ where: string | null } | { problem: string }> {
      if (back.error !== null) {
        const word = /^[a-z_]{1,64}$/.test(back.error) ? back.error : 'no reason it gave'
        return { problem: `Slack did not install it (${word}), so nothing was kept` }
      }
      if (back.code === null || back.code === '') {
        return { problem: 'Slack sent no code back, so nothing was kept' }
      }
      const id = clientId()
      const secret = keyOf(SLACK_APP.clientSecret.key, SLACK_APP.clientSecret.env)
      if (id === null || secret === null) {
        return { problem: 'the app’s client id and secret are not kept here any more' }
      }
      const ask = asking(EXCHANGE_MS)
      let got: Awaited<ReturnType<typeof slackInstalled>>
      try {
        got = await inTime(
          slackInstalled(ask.from, {
            clientId: id,
            clientSecret: secret,
            code: back.code,
            home: back.home,
          }),
          EXCHANGE_MS,
          null,
        ).then((answer) => {
          if (answer === null) throw new SlackError('slack', 'Slack did not answer in time')
          return answer
        })
      } catch (err) {
        // Slack's own word where it said one; an exception's words never reach a page.
        return {
          problem:
            err instanceof SlackError
              ? `Slack would not hand over its token: ${err.message}`
              : 'Slack could not be asked for its token, so nothing was kept',
        }
      } finally {
        ask.done()
      }
      try {
        await write(SLACK_TOKEN, got.token, true)
      } catch (err) {
        return {
          problem: `Slack installed it, and its token could not be kept here: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
      held = null
      return { where: got.team || null }
    },

    async keep(
      fields: Partial<Record<ConnectFieldName, string>>,
    ): Promise<{ kept: readonly string[] } | { problem: string }> {
      const kept: string[] = []
      try {
        for (const [name, value] of Object.entries(fields) as [ConnectFieldName, string][]) {
          const as = KEPT_AS[name]
          if (as === undefined || value === undefined) continue
          await write(as.key, value, as.env !== undefined)
          // Kept, and said where a variable here wins over it, since then it is
          // not the one in use.
          kept.push(
            as.env !== undefined && (env[as.env] ?? '').trim() !== ''
              ? `${as.said} (though $${as.env} wins over it here)`
              : as.said,
          )
        }
      } catch (err) {
        return {
          problem: `${kept.length > 0 ? `${kept.join(', ')} kept, and the rest` : 'it'} could not be kept: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
      held = null
      return kept.length > 0
        ? { kept }
        : { problem: 'nothing was pasted that Slack’s page asks for' }
    },
  }
}
