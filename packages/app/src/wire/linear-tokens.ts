import { type Config, type ConnectSource, findSecret, heldSays, secretPath } from '@tade/core'
import {
  LINEAR_APP,
  LINEAR_APP_IN,
  LinearError,
  type LinearGrant,
  linearClientIdOf,
  linearRefreshed,
} from '@tade/extension-intake'
import { inTime } from '@tade/web'
import type { Settings } from './settings.ts'

// The Linear app's tokens, as the window holds them (REMOTE-TADE.md §6.3): what
// Connect Linear kept, refreshed when a look needs it, and the refresh token
// that replaces itself written back through the one write path each time.
//
// **Why the window and not the watch.** Since 2026-04-01 every Linear OAuth
// app's access token lasts a day, and each refresh hands over the next refresh
// token and spends the one it was. Whatever refreshes must keep the new one,
// and only the window writes the config (`writeKey`): an extension reads keys
// and never writes one. So the watch asks the extension host
// (`ExtensionContext.connected`) and the host asks this, which hands back a
// day's access token — refreshing it first where it is within `MARGIN_MS` of
// its end — and the access token itself is never written anywhere: it lives
// in this window's memory, and a window opened again refreshes once.
//
// **One refresh at a time** (`asking`), because two at once would spend one
// refresh token twice; Linear allows the same request again for thirty
// minutes, which is what saves a window that died between Linear answering
// and the new token being written — the next one refreshes with the old token
// and is handed the same answer.
//
// **A connection made again wins over a refresh in flight** (`generation`):
// what that refresh hands back is the old connection's, and is dropped rather
// than written over the new one.
//
// **Asked, never on a timer.** A watch looks every ten minutes, or hourly
// once deliveries arrive, and the connect page asks who the token is, so a
// connection in use refreshes daily without anybody noticing. One nobody uses
// for long enough may find its refresh token gone: the page and the look then
// say to connect it again.

/** How close to its end an access token is refreshed rather than handed out: longer than any look. */
export const MARGIN_MS = 15 * 60_000

/** How long Linear may take to refresh, before the look that asked says it did not answer. */
const REFRESH_MS = 15_000

/** Who a refresh token written by a refresh is, on its `config_changed` line. */
export const LINEAR_REFRESHED_BY = 'linear refresh'

/** Who a refresh token written by connecting Linear is. */
export const LINEAR_CONNECTED_BY = 'connect linear'

export interface LinearTokenDeps {
  config: () => Config
  /** The window's one write path for a key. */
  settings: Pick<Settings, 'writeKey'>
  now: () => number
  /** What Linear is asked over: the machine's own `fetch` unless a test's Linear. */
  fetch?: typeof fetch
  env?: Readonly<Record<string, string | undefined>>
  /** Said in the conversation: a refresh token Linear handed over that could not be written down. */
  told?: (said: string) => void
}

/** The access token held, the refresh token that came with it, and whether that one is in the config yet. */
interface Held {
  access: string
  until: number
  refresh: string
  written: boolean
}

export class LinearTokens {
  private readonly deps: LinearTokenDeps
  private held: Held | null = null
  private asking: Promise<string | null> | null = null
  private generation = 0
  /** The last trouble writing a token down that was said, so it is said once. */
  private toldOf: string | null = null

  constructor(deps: LinearTokenDeps) {
    this.deps = deps
  }

  /**
   * A day's access token for the app Connect Linear made, refreshed first
   * where it is near its end; null where none is connected. Throws, in words
   * somebody can act on — a `LinearError` that is `auth` where Linear will not
   * take the refresh token any more, and Linear's own `Unreachable` where
   * nothing answered.
   */
  async token(): Promise<string | null> {
    const kept = this.kept()
    // A refresh token written and since replaced or taken away — connected
    // again, or by hand — is not this window's to keep using.
    if (this.held?.written && this.held.refresh !== kept.refresh) this.held = null
    if (this.held === null && kept.refresh === null) return null
    const held = this.held
    if (held !== null && held.until - MARGIN_MS > this.deps.now()) {
      if (!held.written) await this.write(held, LINEAR_REFRESHED_BY)
      return held.access
    }
    this.asking ??= this.refresh().finally(() => {
      this.asking = null
    })
    return this.asking
  }

  /**
   * What connecting Linear just exchanged a code for: held, so nothing
   * refreshes it for a day, and its refresh token kept. Returns why it could
   * not be kept, or null — this window carries on with it either way.
   */
  async took(grant: LinearGrant): Promise<string | null> {
    this.generation++
    const held: Held = {
      access: grant.access,
      until: this.deps.now() + grant.expiresIn * 1000,
      refresh: grant.refresh,
      written: false,
    }
    this.held = held
    return this.write(held, LINEAR_CONNECTED_BY)
  }

  private async refresh(): Promise<string | null> {
    const generation = this.generation
    const kept = this.kept()
    const refresh = this.held?.refresh ?? kept.refresh
    if (refresh === null) return null
    if (kept.clientId === null) {
      throw new Error(
        'Linear is connected, and the client id its token is refreshed with is not kept here any more: keep it again at /connect',
      )
    }
    const controller = new AbortController()
    let grant: LinearGrant | null
    try {
      grant = await inTime(
        linearRefreshed(
          {
            fetch: this.deps.fetch ?? globalThis.fetch.bind(globalThis),
            signal: controller.signal,
          },
          { clientId: kept.clientId, refresh },
        ),
        REFRESH_MS,
        null,
      )
    } catch (err) {
      if (err instanceof LinearError && err.trouble === 'auth') {
        // Spent, revoked, or the app deleted: nothing held is any use now.
        if (generation === this.generation) this.held = null
        throw new LinearError(
          'auth',
          `${err.message}: Linear no longer takes the refresh token kept here — connect Linear again at /connect`,
        )
      }
      throw err
    } finally {
      controller.abort()
    }
    if (grant === null) {
      throw new Error(
        `Linear did not hand over a new token within ${REFRESH_MS / 1000} seconds; the next look asks again`,
      )
    }
    // Connected again while this was out: what came back is the old
    // connection's, and the new one is already held.
    if (generation !== this.generation) return this.held?.access ?? null
    const held: Held = {
      access: grant.access,
      until: this.deps.now() + grant.expiresIn * 1000,
      refresh: grant.refresh,
      written: false,
    }
    this.held = held
    await this.write(held, LINEAR_REFRESHED_BY)
    return held.access
  }

  /**
   * The refresh token held, written through the one write path as `set` —
   * never as itself. What went wrong is said once and returned; the window
   * carries on with the token it holds, and tries again at the next ask.
   */
  private async write(held: Held, by: string): Promise<string | null> {
    const before = this.deps.config().extensions[LINEAR_APP_IN]?.[LINEAR_APP.refresh.key]
    try {
      await this.deps.settings.writeKey(
        secretPath(LINEAR_APP_IN, LINEAR_APP.refresh.key),
        held.refresh,
        heldSays(typeof before === 'string' ? before : undefined),
        { by },
      )
      held.written = true
      this.toldOf = null
      return null
    } catch (err) {
      const problem = err instanceof Error ? err.message : String(err)
      if (problem !== this.toldOf) {
        this.toldOf = problem
        this.deps.told?.(
          `Linear handed over a new refresh token and it could not be written to config.yaml (${problem}). This window carries on with it and tries again; if Tade closes before it is written, connect Linear again at /connect.`,
        )
      }
      return problem
    }
  }

  /** What Connect Linear kept: the client id and the refresh token, with nothing in the environment for either. */
  private kept(): { clientId: string | null; refresh: string | null } {
    const settings = this.deps.config().extensions[LINEAR_APP_IN]
    const read = (key: string) => {
      const found = findSecret({ settings, key, env: this.deps.env ?? {}, variables: [] })
      const value = found?.value.trim() ?? ''
      return value === '' ? null : value
    }
    return {
      clientId: linearClientIdOf(read(LINEAR_APP.clientId.key)),
      refresh: read(LINEAR_APP.refresh.key),
    }
  }
}

/**
 * What the extension host lends every extension (`ExtensionContext.connected`),
 * by source: the Linear app's token, and nothing for a source whose
 * credentials are read some other way — GitHub's App through `apps`, Slack's
 * bot token through its key.
 */
export function lending(tokens: LinearTokens): (source: ConnectSource) => Promise<string | null> {
  const lent: Partial<Record<ConnectSource, () => Promise<string | null>>> = {
    linear: () => tokens.token(),
  }
  return (source) => lent[source]?.() ?? Promise.resolve(null)
}
