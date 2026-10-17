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
  type LinearLook,
  linearPage,
  type SlackLook,
  secretPath,
  slackPage,
} from '@tade/core'
import {
  LINEAR_APP,
  LINEAR_APP_IN,
  LINEAR_KEY,
  LinearError,
  linearAsks,
  linearAuthorizeUrl,
  linearClientIdOf,
  linearEvents,
  linearInstalled,
  linearMakeUrl,
  linearWho,
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
import { LINEAR_CONNECTED_BY, LinearTokens } from './linear-tokens.ts'
import type { Settings } from './settings.ts'

// The window's half of the guided pages that connect a source
// (`@tade/web`'s `connected.ts`, REMOTE-TADE.md §6.4): what is true of each
// source now, what making its app asks for, and keeping what comes back —
// through the one write path, each key a `config_changed` line said as `set`,
// a credential `0600` because the file is.
//
// **Everything about GitHub is asked of the forge** (`capabilities.apps`):
// the manifest, the code's exchange, where the App is installed. **Everything
// about Slack and Linear is asked of their doors** (`@tade/extension-intake`'s
// `slack-app.ts` and `linear-app.ts`, each over its one client): the manifest,
// the install's address, the code's exchange, who a token is. There is no
// second HTTP client here, which is the rule `add-intake-source` holds every
// source to. Linear's tokens are the window's to hold and refresh
// (`linear-tokens.ts`): connecting hands them over there, and the page asks
// there who the token is.

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
  /** What Slack and Linear are asked over: the machine's own `fetch` unless a test's. */
  fetch?: typeof fetch
  env?: Readonly<Record<string, string | undefined>>
  /**
   * The Linear app's tokens as the window holds them, which the watches are
   * lent too: connecting hands a new one over there. One of its own where
   * none is handed in — a test's window.
   */
  linear?: LinearTokens
}

/** What a `keep` press writes a box as, and says it as. */
type KeptAs = Readonly<
  Partial<Record<ConnectFieldName, { key: string; env?: string; said: string }>>
>

/** What Slack's `keep` press writes each box it carries as. */
const SLACK_KEPT_AS: KeptAs = {
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

/** What Linear's `keep` press writes each box it carries as: never a client secret, which PKCE makes unneeded. */
const LINEAR_KEPT_AS: KeptAs = {
  client_id: { key: LINEAR_APP.clientId.key, said: 'the client id' },
  signing_secret: {
    key: HOOK_SECRETS.linear.key,
    env: HOOK_SECRETS.linear.env,
    said: 'the webhook’s signing secret',
  },
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
  const tokens =
    deps.linear ??
    new LinearTokens({
      config: deps.config,
      settings: deps.settings,
      now: deps.now,
      env,
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    })
  const halves: Readonly<Record<ConnectSource, Half>> = {
    github: githubHalf(deps, env),
    slack: slackHalf(deps, env),
    linear: linearHalf(deps, env, tokens),
  }
  return {
    page: (source) => halves[source].page(),
    form: (source, want) => halves[source].form(want),
    installUrl: (source, state, home, challenge) =>
      halves[source].installUrl(state, home, challenge),
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

  const write = writer(deps, SLACK_APP_IN, SLACK_CONNECTED_BY)

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

    async keep(fields: Partial<Record<ConnectFieldName, string>>) {
      const answer = await keepAs(SLACK_KEPT_AS, fields, write, env, 'Slack')
      held = null
      return answer
    },
  }
}

/** One key of an intake block written through the one write path, said as it was: a credential as `set`. */
function writer(deps: ConnectDeps, block: string, by: string) {
  return (key: string, value: string | undefined, credential: boolean) => {
    const before = deps.config().extensions[block]?.[key]
    const was = credential
      ? heldSays(typeof before === 'string' ? before : undefined)
      : before === undefined
        ? ''
        : String(before)
    return deps.settings.writeKey(secretPath(block, key), value, was, { by })
  }
}

/**
 * What one `keep` press pasted, written box by box as its table says — the
 * names of what was kept, each said where a variable here wins over it, or
 * why nothing was.
 */
async function keepAs(
  as: KeptAs,
  fields: Partial<Record<ConnectFieldName, string>>,
  write: ReturnType<typeof writer>,
  env: Readonly<Record<string, string | undefined>>,
  title: string,
): Promise<{ kept: readonly string[] } | { problem: string }> {
  const kept: string[] = []
  try {
    for (const [name, value] of Object.entries(fields) as [ConnectFieldName, string][]) {
      const one = as[name]
      if (one === undefined || value === undefined) continue
      await write(one.key, value, one.env !== undefined)
      // Kept, and said where a variable here wins over it, since then it is
      // not the one in use.
      kept.push(
        one.env !== undefined && (env[one.env] ?? '').trim() !== ''
          ? `${one.said} (though $${one.env} wins over it here)`
          : one.said,
      )
    }
  } catch (err) {
    return {
      problem: `${kept.length > 0 ? `${kept.join(', ')} kept, and the rest` : 'it'} could not be kept: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  return kept.length > 0
    ? { kept }
    : { problem: `nothing was pasted that ${title}’s page asks for` }
}

/**
 * Linear's half: everything asked of the Linear door over its one client, and
 * its tokens held by the window (`linear-tokens.ts`), which connecting hands
 * a new one to and the page asks who it is.
 */
function linearHalf(
  deps: ConnectDeps,
  env: Readonly<Record<string, string | undefined>>,
  tokens: LinearTokens,
): Half {
  const doFetch = deps.fetch ?? globalThis.fetch.bind(globalThis)
  const write = writer(deps, LINEAR_APP_IN, LINEAR_CONNECTED_BY)
  let held: { at: number; token: string; installed: LinearLook['installed'] } | null = null

  /** One of the keys kept in the intake block, its variable winning where it has one (`findSecret`). */
  const keyOf = (key: string, variable?: string): string | null => {
    const found = findSecret({
      settings: deps.config().extensions[LINEAR_APP_IN],
      key,
      env,
      variables: variable === undefined ? [] : [variable],
    })
    const value = found?.value.trim() ?? ''
    return value === '' ? null : value
  }
  const clientId = (): string | null => linearClientIdOf(keyOf(LINEAR_APP.clientId.key))

  /** What Linear is asked with: this machine's `fetch`, and a signal the deadline aborts. */
  const asking = (limit: number) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), limit)
    timer.unref?.()
    return { from: { fetch: doFetch, signal: controller.signal }, done: () => clearTimeout(timer) }
  }

  /**
   * Who the app's token is, as Linear says it, held a minute and asked with a
   * deadline — the token refreshed first where it is near its end, which is
   * the page keeping a connection nobody else uses alive. Null where nothing
   * is connected.
   */
  const who = async (): Promise<LinearLook['installed']> => {
    const refused = (err: unknown): LinearLook['installed'] => ({
      problem: err instanceof Error ? err.message : String(err),
      refused: err instanceof LinearError && err.trouble === 'auth',
    })
    const late = {
      problem: `Linear did not answer within ${INSTALLED_MS / 1000} seconds`,
      refused: false,
    }
    let token: string | null
    try {
      const got = await inTime(
        tokens.token().then((one) => ({ one })),
        INSTALLED_MS,
        null,
      )
      if (got === null) return late
      token = got.one
    } catch (err) {
      return refused(err)
    }
    if (token === null) return null
    if (held !== null && held.token === token && deps.now() - held.at < HELD_MS) {
      return held.installed
    }
    const ask = asking(INSTALLED_MS)
    const asked = linearWho(ask.from, token).then((one): LinearLook['installed'] => one, refused)
    const answer = await inTime(asked, INSTALLED_MS, late)
    ask.done()
    held = { at: deps.now(), token, installed: answer }
    return answer
  }

  return {
    async page() {
      const config = deps.config()
      const publicName = surfaceOf(config.surfaces.web).publicName
      const look: LinearLook = {
        publicName,
        kept: {
          clientId: clientId(),
          signingSecret: secretOf(config, 'linear') !== null,
          connected: keyOf(LINEAR_APP.refresh.key) !== null,
          key: keyOf(LINEAR_KEY, 'LINEAR_API_KEY') !== null,
        },
        installed: await who(),
        heard: deps.heard('linear'),
      }
      return {
        page: linearPage(look),
        asks: linearAsks(),
        events: linearEvents(publicName !== null),
      }
    },

    form(want: Parameters<WebConnecting['form']>[1]) {
      // No public name is no webhook: Linear delivers only to public HTTPS,
      // and its redirect comes back to the door the press came in at.
      return {
        url: linearMakeUrl({ name: want.name, home: want.home, delivers: want.hook !== null }),
      }
    },

    installUrl(state: string, home: string, challenge: string | null): string | null {
      const id = clientId()
      // Never without a proof key: a code anybody could exchange is not one to ask for.
      if (id === null || challenge === null) return null
      return linearAuthorizeUrl({ clientId: id, home, state, challenge })
    },

    async made() {
      return { problem: 'Linear makes its app on its own page: nothing comes back here' }
    },

    async installed(back: ConnectReturn): Promise<{ where: string | null } | { problem: string }> {
      if (back.error !== null) {
        const word = /^[a-z_]{1,64}$/.test(back.error) ? back.error : 'no reason it gave'
        return { problem: `Linear did not connect it (${word}), so nothing was kept` }
      }
      if (back.code === null || back.code === '') {
        return { problem: 'Linear sent no code back, so nothing was kept' }
      }
      if (back.verifier === undefined || back.verifier === null) {
        return {
          problem: 'this machine holds no proof key for that code, so it cannot be exchanged',
        }
      }
      const id = clientId()
      if (id === null) return { problem: 'the app’s client id is not kept here any more' }
      const ask = asking(EXCHANGE_MS)
      let got: Awaited<ReturnType<typeof linearInstalled>>
      try {
        got = await inTime(
          linearInstalled(ask.from, {
            clientId: id,
            code: back.code,
            verifier: back.verifier,
            home: back.home,
          }),
          EXCHANGE_MS,
          null,
        ).then((answer) => {
          if (answer === null) throw new LinearError('linear', 'Linear did not answer in time')
          return answer
        })
      } catch (err) {
        // Linear's own word where it said one; an exception's words never reach a page.
        return {
          problem:
            err instanceof LinearError
              ? err.message
              : 'Linear could not be asked for its token, so nothing was kept',
        }
      } finally {
        ask.done()
      }
      const trouble = await tokens.took(got)
      held = null
      if (trouble !== null) {
        return {
          problem: `Linear connected it, and its token could not be kept here: ${trouble} — this window reads with it until it closes`,
        }
      }
      return { where: got.workspace || null }
    },

    async keep(fields: Partial<Record<ConnectFieldName, string>>) {
      const answer = await keepAs(LINEAR_KEPT_AS, fields, write, env, 'Linear')
      held = null
      return answer
    },
  }
}
