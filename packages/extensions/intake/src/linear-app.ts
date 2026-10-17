import { linearIssues } from './linear.ts'
import { LinearApi, type LinearGrant } from './linear-api.ts'

// The Linear app Connect Linear asks the person to make (REMOTE-TADE.md §6.3):
// the manifest it is made from, what it asks Linear for and why, where
// connecting it sends the browser back, and the code that comes back with
// exchanged for its tokens — through the one Linear client there is
// (`linear-api.ts`). The window's half (`wire/web-connect.ts`) asks this, and
// keeps what comes of it through the one write path; the window's token
// holder (`wire/linear-tokens.ts`) refreshes what it kept.
//
// **A private OAuth app of the person's own workspace**, made on Linear's own
// page with the manifest filled in (schema `1.0.0`). Over a personal API key it
// buys a budget of its own (5,000 requests an hour, not 2,500), webhooks built
// in, and a token that is the app's to revoke rather than the person's whole
// reach. It may only `read`: the Linear watch has no way back at all, so
// nothing here needs a scope to write.
//
// **Linear hands nothing back when the app is made** — there is no code to
// exchange the way GitHub's manifest has — so the person pastes its client id
// into the page, and, where this machine has a public name, its webhook's
// signing secret. **Never its client secret**: connecting is OAuth with PKCE
// (`S256`), and with PKCE Linear needs the client secret neither for the
// code's exchange nor for a refresh (its own documentation: "optional" for
// both), so it is one credential fewer in the file every agent can read.
//
// **The tokens.** Every Linear OAuth app has used refresh tokens since
// 2026-04-01: an access token lasts a day, and each refresh hands over a new
// refresh token and spends the old one, with thirty minutes in which the same
// request may be made again for a response that was lost. So the refresh
// token is **written back through `writeKey` every time it turns over**, and
// has no environment variable: one set there would be spent by the first
// refresh and never good again.
//
// **Over HTTPS where this machine has a public name**: deliveries go to
// `/hooks/linear` (the doorbell, signed with the webhook's secret), and
// connecting comes back to `/connect/linear/installed`. **With no public name**
// the app is made with no webhook — Linear delivers only to a public HTTPS
// address — and connecting comes back to the door the press came in at
// (`http://localhost:<port>`, which Linear allows for a redirect), so a laptop
// gets the app's budget and its watch polls.

/** Where Linear's app keys live: `extensions.<LINEAR_APP_IN>.<key>`, beside the personal key. */
export const LINEAR_APP_IN = 'intake'

/**
 * The app's keys, beside the webhook's signing secret (`HOOK_SECRETS.linear`).
 * The client id is a name and signs nothing; the refresh token is a
 * credential, and is the one key here with **no** variable that wins over it,
 * because it replaces itself.
 */
export const LINEAR_APP = {
  clientId: {
    key: 'linear_client_id',
    means:
      'the client ID of the Linear app this machine reads your workspace as (its page on Linear) — kept by Connect Linear (/connect)',
  },
  refresh: {
    key: 'linear_refresh_token',
    means:
      'the refresh token of that Linear app, which this machine trades for a day’s access token — written by Connect Linear (/connect) and again by Tade each time Linear hands over the next one, since each is good once; so there is no environment variable for it',
  },
} as const

/**
 * A client id as Linear hands one out — letters and digits — or null for
 * anything else, so a key pasted by hand into the wrong place is no client id
 * rather than one Linear refuses at the first press.
 */
export function linearClientIdOf(value: string | null): string | null {
  return value !== null && /^[A-Za-z0-9]{16,128}$/.test(value) ? value : null
}

/** Where connecting the app sends the browser back: this machine's connect callback. */
export function linearRedirect(home: string): string {
  return `${home}/connect/linear/installed`
}

/** What the app asks of the workspace, and why, in the words the page draws before the press. */
export function linearAsks(): readonly { what: string; why: string }[] {
  return [
    {
      what: 'read',
      why: 'to read the team you name: its open issues carrying your label, and who put the label on each — nothing it may do writes, and Tade never posts to Linear',
    },
  ]
}

/**
 * What the webhook is subscribed to: what rings the Linear watch's doorbell,
 * read off the watch, so the two can never name different things — and
 * nothing where Linear has nowhere to deliver.
 */
export function linearEvents(delivers: boolean): readonly string[] {
  return delivers ? [...(linearIssues.doorbell?.events ?? [])] : []
}

/** What the app is made with. */
export interface LinearWant {
  /** Its name in the workspace. */
  name: string
  /** Where connecting it comes back to: this machine's public address, or the door the press came in at. */
  home: string
  /** Whether Linear can deliver here: only to a public HTTPS name. */
  delivers: boolean
}

/**
 * The manifest (Linear's OAuth app manifest, schema `1.0.0`): a private app,
 * the one redirect, and — where Linear can deliver — the webhook to the
 * doorbell for what the watch rings on. No `client_credentials` grant: an app
 * token would read as the app rather than as the person who allowed it.
 */
export function linearManifest(want: LinearWant): Record<string, unknown> {
  return {
    $schema: 'https://linear.app/.well-known/oauth-app-manifest.schema.json',
    schemaVersion: '1.0.0',
    distribution: 'private',
    display: {
      description:
        'Notices when somebody on your own list labels a Linear issue for Tade. It only reads.',
    },
    developer: { name: 'Tade' },
    oauth: {
      client_name: clientNameOf(want.name),
      redirect_uris: [linearRedirect(want.home)],
      grant_types: ['authorization_code'],
    },
    ...(want.delivers
      ? {
          webhook: {
            enabled: true,
            url: `${want.home}/hooks/linear`,
            resourceTypes: [...linearEvents(true)],
          },
        }
      : {}),
  }
}

/**
 * The app's name as Linear takes one: two to eighty characters, and never the
 * word "Linear" or an address in it, which its schema refuses — so `Tade vps`
 * stays itself, and a name that came out empty is `Tade`.
 */
function clientNameOf(name: string): string {
  const named = name
    .replace(/https?:\/\/\S*/gi, '')
    .replace(/linear/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .trim()
  return named.length >= 2 ? named : 'Tade'
}

/** Where a browser goes to make the app: Linear's own page, with the manifest filled in. */
export function linearMakeUrl(want: LinearWant): string {
  const manifest = encodeURIComponent(JSON.stringify(linearManifest(want)))
  return `https://linear.app/settings/api/applications/new?manifest=${manifest}`
}

/**
 * Where a browser goes to connect it: Linear asks the person to allow it,
 * then sends the browser to the redirect with a code, which only this
 * challenge's verifier can exchange. Carries the one-time word the press minted.
 */
export function linearAuthorizeUrl(want: {
  clientId: string
  home: string
  state: string
  challenge: string
}): string {
  const query = new URLSearchParams({
    client_id: want.clientId,
    redirect_uri: linearRedirect(want.home),
    response_type: 'code',
    scope: linearAsks()
      .map((one) => one.what)
      .join(','),
    state: want.state,
    code_challenge: want.challenge,
    code_challenge_method: 'S256',
  })
  return `https://linear.app/oauth/authorize?${query.toString()}`
}

/**
 * The code Linear sent the browser back with, exchanged once — with the
 * verifier its challenge was made from, and no client secret — for the app's
 * tokens, and who they are: the workspace and the person who allowed it.
 * Throws `LinearError` with Linear's own word for what went wrong.
 */
export async function linearInstalled(
  from: { fetch: typeof fetch; signal: AbortSignal },
  req: { clientId: string; code: string; verifier: string; home: string },
): Promise<LinearGrant & { workspace: string; user: string }> {
  const grant = await LinearApi.token(from, {
    grant_type: 'authorization_code',
    code: req.code,
    redirect_uri: linearRedirect(req.home),
    client_id: req.clientId,
    code_verifier: req.verifier,
  })
  const who = await new LinearApi({ token: grant.access }, from).who()
  return { ...grant, ...who }
}

/**
 * A refresh token traded for the next access token and the next refresh
 * token, which replaces it: the one it was is spent once Linear answers.
 * Throws `LinearError`, `auth` where Linear will not take it any more.
 */
export function linearRefreshed(
  from: { fetch: typeof fetch; signal: AbortSignal },
  req: { clientId: string; refresh: string },
): Promise<LinearGrant> {
  return LinearApi.token(from, {
    grant_type: 'refresh_token',
    refresh_token: req.refresh,
    client_id: req.clientId,
  })
}

/** Who an access token is, as Linear says now. Throws `LinearError` where it says no. */
export function linearWho(
  from: { fetch: typeof fetch; signal: AbortSignal },
  token: string,
): Promise<{ workspace: string; user: string }> {
  return new LinearApi({ token }, from).who()
}
