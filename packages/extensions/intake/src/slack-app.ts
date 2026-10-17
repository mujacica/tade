import { SlackApi } from './slack-api.ts'

// The Slack app Connect Slack asks the person to make (REMOTE-TADE.md §6.3):
// the manifest it is made from, what it asks Slack for and why, where its
// install sends the browser back, and the code that install comes back with
// exchanged for its bot token — through the one Slack client there is
// (`slack-api.ts`). The window's half (`wire/web-connect.ts`) asks this, and
// keeps what comes of it through the one write path.
//
// **An app of the person's own workspace, never one Tade distributes.** Slack
// gives an *internal* app 50+ reads a minute and 1,000 messages a page, and one
// "commercially distributed outside the Marketplace" one read a minute and
// fifteen (`slack-api.ts`): an app each person makes from this manifest in
// their own workspace is theirs, and nothing here is installed anywhere else.
// Whether Slack counts a manifest Tade ships as "a templated custom app" is
// not something anybody documents (REMOTE-TADE §15); what is checked is that
// the app is the person's, in their workspace, made by their press.
//
// **Over HTTP, where this machine has a public name**: events go to
// `/hooks/slack` (the doorbell, signed with the app's signing secret) and the
// install comes back to `/connect/slack/installed`, both HTTPS, which Slack
// requires of a redirect. **With no public name** the app is made with no
// address and no redirect — it is sent nothing, its watch polls, and it is
// installed from its own page with its token kept here by hand. Socket Mode,
// which needs no public name, is not built: it would be a socket held open by
// the window, and the poll is the path for a machine nothing can reach.

/** Where Slack's app keys live: `extensions.<SLACK_APP_IN>.<key>`, beside the bot token. */
export const SLACK_APP_IN = 'intake'

/**
 * The app's keys, beside the bot token (`SLACK_TOKEN`) and the signing secret
 * (`HOOK_SECRETS.slack`). The client id is a name and says nothing anybody
 * could sign with; the client secret is a credential, with the variable that
 * wins over it, and is read only when an install's code is exchanged.
 */
export const SLACK_APP = {
  clientId: {
    key: 'slack_client_id',
    means:
      'the Client ID of the Slack app this machine installs with OAuth (Basic Information) — kept by Connect Slack (/connect)',
  },
  clientSecret: {
    key: 'slack_client_secret',
    env: 'SLACK_CLIENT_SECRET',
    means:
      'the Client Secret of that Slack app, which exchanges an install’s code for its bot token and nothing else — kept by Connect Slack (/connect)',
  },
} as const

/** Where Slack's install sends the browser back: the public name's connect callback. */
export function slackRedirect(home: string): string {
  return `${home}/connect/slack/installed`
}

/**
 * The bot scopes the app is made with, and why each, in the words the page
 * draws before the press. `app_mentions:read` only where Slack can deliver,
 * since it is only what a delivery needs.
 */
export function slackAsks(delivers: boolean): readonly { what: string; why: string }[] {
  return [
    ...(delivers
      ? [
          {
            what: 'app_mentions:read',
            why: 'to be told when somebody mentions it, which makes the watch look at once — inside a thread too, which no poll can see',
          },
        ]
      : []),
    {
      what: 'channels:history',
      why: 'to read a public channel you invite it to, and the thread a request was asked in',
    },
    { what: 'groups:history', why: 'the same, for a private channel you invite it to' },
    {
      what: 'chat:write',
      why: 'to say one of Tade’s own statuses in a request’s own thread — only once you turn reply on in Settings › Intake',
    },
    {
      what: 'reactions:write',
      why: 'to put the reaction on a request that claims each status, so one is never said twice — only once reply is on',
    },
  ]
}

/** The events it is sent: mentions, and only where this machine has a public name. */
export function slackEvents(delivers: boolean): readonly string[] {
  return delivers ? ['app_mention'] : []
}

/** What the app is made with. */
export interface SlackWant {
  /** Its name in the workspace: at most 35 characters, Slack's limit. */
  name: string
  /** This machine's public address — `https://tade.example.com` — or null where it has none. */
  home: string | null
}

/**
 * The manifest (Slack's app manifest, JSON): one bot, the scopes above, and —
 * where there is a public name — events to the doorbell and the install's
 * redirect. No Socket Mode, no token rotation, no org-wide install.
 */
export function slackManifest(want: SlackWant): Record<string, unknown> {
  const delivers = want.home !== null
  const name = want.name.slice(0, 35).trim() || 'Tade'
  return {
    display_information: {
      name,
      description: 'Notices when somebody on your own list asks Tade for something in a channel.',
    },
    features: { bot_user: { display_name: botNameOf(name), always_online: false } },
    oauth_config: {
      ...(want.home === null ? {} : { redirect_urls: [slackRedirect(want.home)] }),
      scopes: { bot: slackAsks(delivers).map((one) => one.what) },
    },
    settings: {
      ...(want.home === null
        ? {}
        : {
            event_subscriptions: {
              request_url: `${want.home}/hooks/slack`,
              bot_events: [...slackEvents(true)],
            },
          }),
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  }
}

/**
 * The bot's handle: Slack allows lower-case letters, digits, `-`, `_` and `.`,
 * so `Tade vps` is `tade-vps` — two apps of one person's, a laptop's and a
 * server's, are then two names to mention rather than one.
 */
function botNameOf(name: string): string {
  const handle = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return handle || 'tade'
}

/** Where a browser goes to make the app: Slack's own page, with the manifest filled in. */
export function slackMakeUrl(want: SlackWant): string {
  const manifest = encodeURIComponent(JSON.stringify(slackManifest(want)))
  return `https://api.slack.com/apps?new_app=1&manifest_json=${manifest}`
}

/**
 * Where a browser goes to install it with OAuth v2, carrying the one-time
 * word the press minted: Slack asks the person to allow it, then sends the
 * browser to the redirect with a code good for ten minutes.
 */
export function slackInstallUrl(want: { clientId: string; home: string; state: string }): string {
  const query = new URLSearchParams({
    client_id: want.clientId,
    scope: slackAsks(true)
      .map((one) => one.what)
      .join(','),
    redirect_uri: slackRedirect(want.home),
    state: want.state,
  })
  return `https://slack.com/oauth/v2/authorize?${query.toString()}`
}

/**
 * The code Slack sent the browser back with, exchanged once for the bot
 * token, and who that token is: the workspace and the bot's own name. Throws
 * `SlackError` with Slack's own word for what went wrong.
 */
export async function slackInstalled(
  from: { fetch: typeof fetch; signal: AbortSignal },
  req: { clientId: string; clientSecret: string; code: string; home: string },
): Promise<{ token: string; team: string; user: string }> {
  const { token, team } = await SlackApi.access(from, {
    clientId: req.clientId,
    clientSecret: req.clientSecret,
    code: req.code,
    redirect: slackRedirect(req.home),
  })
  const who = await new SlackApi(token, from).installed()
  return { token, team: who.team || team, user: who.user }
}

/** Who a bot token kept here is, as Slack says now. Throws `SlackError` where it says no. */
export function slackWho(
  from: { fetch: typeof fetch; signal: AbortSignal },
  token: string,
): Promise<{ team: string; user: string }> {
  return new SlackApi(token, from).installed()
}
