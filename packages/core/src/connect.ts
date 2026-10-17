// Connecting a source of work, step by step (REMOTE-TADE.md §6.4): what the
// guided page says and offers, as a pure fold over a look.
//
// **Each source's page is one fold over what is true now** — what is kept in
// the config, what the source says when asked, what the journal heard — and
// never a record of how far somebody got: a step is done when the thing it is
// for is true, so an App deleted on GitHub reads as not made again, and a
// webhook that stopped arriving reads as not arriving. One line a step and at
// most one press, and every press asks for something and says what.
//
// **What connecting does not do: grant anybody anything.** It makes the forge
// read as the App and the doorbell ring; whose labels count (`from`), what
// template work is stamped from, and whether Tade may say anything back stay
// the person's to write in Settings › Intake, three separate acts, as before.
//
// GitHub and Slack are the sources this builds; Linear (V16) is connected from
// here once it is, which is why the page is per source and each source says
// what its page may be asked (`CONNECT_FLOWS`).

/** The sources a page here connects. Only what is built: a row is a promise. */
export const CONNECT_SOURCES = ['github', 'slack'] as const
export type ConnectSource = (typeof CONNECT_SOURCES)[number]

/** Each source as a heading says it. */
export const CONNECT_TITLES: Readonly<Record<ConnectSource, string>> = {
  github: 'GitHub',
  slack: 'Slack',
}

/** How long a one-time word the owner minted is good for. GitHub gives its code an hour, Slack ten minutes. */
export const CONNECT_STATE_MS = 10 * 60_000

/**
 * What one press on a page asks for: making the app, keeping what the source
 * showed the person and hands over no other way, or installing it.
 */
export type ConnectPress = 'make' | 'keep' | 'install'

/** Where a source sends the browser back after a press: once the app is made, once it is installed. */
export type ConnectBack = 'made' | 'installed'

/**
 * What each source's page may be asked, and how the source answers.
 *
 * - `presses`: the presses it has, each a route of its own.
 * - `backs`: where the source sends the browser back, each a route answered
 *   only for a one-time word a press minted (`made` follows `make`,
 *   `installed` follows `install`). A press with no back mints no word: a
 *   word nothing will bring back is one more thing to hold for nothing.
 * - `publicBack`: whether the source sends a browser back only to a public
 *   name. Slack's redirect must be HTTPS, so with none its app is installed
 *   from its own page and its token kept here by hand; GitHub's may be the
 *   door the press came in at.
 * - `goes`: the hosts a press may send a browser to, which another machine's
 *   answer is held to before this one opens anything.
 */
export const CONNECT_FLOWS: Readonly<
  Record<
    ConnectSource,
    {
      presses: readonly ConnectPress[]
      backs: readonly ConnectBack[]
      publicBack: boolean
      goes: readonly string[]
    }
  >
> = {
  github: {
    presses: ['make', 'install'],
    backs: ['made', 'installed'],
    publicBack: false,
    goes: ['github.com'],
  },
  slack: {
    presses: ['make', 'keep', 'install'],
    backs: ['installed'],
    publicBack: true,
    goes: ['api.slack.com', 'slack.com'],
  },
}

/** The press a source sending the browser back follows. */
export function pressBefore(back: ConnectBack): ConnectPress {
  return back === 'made' ? 'make' : 'install'
}

/**
 * What a press may carry, by name: an App's name and organisation for
 * GitHub's making, and for Slack what its Basic Information shows the person
 * and nothing hands over — the signing secret, the client's id and secret —
 * or, with no public name, the bot token its own install page shows.
 */
export const CONNECT_FIELDS = [
  'name',
  'organisation',
  'signing_secret',
  'client_id',
  'client_secret',
  'token',
] as const
export type ConnectFieldName = (typeof CONNECT_FIELDS)[number]

/** One box a press carries, as the page draws it. */
export interface ConnectField {
  name: ConnectFieldName
  label: string
  /** A credential: typed into a box that hides it, and never drawn back. */
  secret: boolean
  placeholder?: string
}

/** What the page knows of GitHub now. */
export interface GithubLook {
  /** This machine's public name, where it has one: where GitHub can deliver to. */
  publicName: string | null
  /** The App kept in the config, where one is: its id, and its slug where kept. */
  app: { id: string; slug: string | null } | null
  /**
   * Where GitHub says the App is installed — each account and how many of its
   * repositories (`all`, or a count) — or why that could not be asked, or null
   * where there is no App to ask about.
   */
  installed:
    | readonly { account: string; repositories: 'all' | number }[]
    | { problem: string }
    | null
  /** Whether a secret its deliveries are signed with is kept here. */
  secret: boolean
  /** When a delivery from GitHub last verified here, and when one last did not; null for never. */
  heard: { verified: number | null; refused: number | null }
}

/** One step of a page: what it is for, whether it is true, its line, and its one press. */
export interface ConnectStep {
  id: 'make' | 'keep' | 'install' | 'deliveries'
  title: string
  done: boolean
  /** One line: what is true, or what the press will do. */
  said: string
  press?: {
    act: ConnectPress
    label: string
    /** The boxes it carries, where it carries any. */
    fields?: readonly ConnectField[]
    /** What pressing it again replaces, said under it once the step is done. */
    replaces?: string
  }
}

/** One source's page. */
export interface ConnectPage {
  source: ConnectSource
  title: string
  steps: readonly ConnectStep[]
  /** What the app may write anywhere, said under what making it asks for. */
  writes: string
}

/**
 * GitHub's page: make the App, install it, hear its deliveries.
 *
 * The press to make one is offered again once one is kept, as "make another",
 * because an App deleted on GitHub keeps its id here and only the source can
 * say it is gone (`installed` then carries the problem); the page that answers
 * the press says what making one replaces.
 */
export function githubPage(look: GithubLook, now: number): ConnectPage {
  const made = look.app !== null
  const installs = Array.isArray(look.installed) ? look.installed : []
  const readable = installs.filter((one) => one.repositories === 'all' || one.repositories > 0)
  const problem =
    look.installed !== null && !Array.isArray(look.installed)
      ? (look.installed as { problem: string }).problem
      : null
  const steps: ConnectStep[] = [
    {
      id: 'make',
      title: 'Make a GitHub App',
      done: made,
      said: made
        ? `kept here: GitHub App ${look.app?.slug ?? look.app?.id}, which may read and never write`
        : 'one App in your GitHub account that may read issues, reviews and CI on the repositories you pick, and write nothing anywhere',
      press: {
        act: 'make',
        label: made ? 'Make another' : 'Make it on GitHub',
        fields: [
          {
            name: 'name',
            label: 'Name on GitHub',
            secret: false,
            placeholder: look.publicName ? `Tade ${look.publicName.split('.')[0] ?? ''}` : 'Tade',
          },
          {
            name: 'organisation',
            label: 'Under an organisation',
            secret: false,
            placeholder: 'your own account',
          },
        ],
        replaces:
          'Making another replaces the App kept here; the old one stays on GitHub until you delete it there.',
      },
    },
    {
      id: 'install',
      title: 'Install it on your repositories',
      done: readable.length > 0,
      said: !made
        ? 'once it is made: pick which repositories it may read'
        : problem !== null
          ? `GitHub could not be asked where it is installed: ${problem}`
          : readable.length === 0
            ? 'installed nowhere yet: pick which repositories it may read'
            : `installed on ${readable.map(installedSaid).join(', ')}`,
      ...(made && look.app?.slug
        ? {
            press: {
              act: 'install' as const,
              label: readable.length > 0 ? 'Change repositories' : 'Install it on GitHub',
            },
          }
        : {}),
    },
    deliveries(look, now),
  ]
  return {
    source: 'github',
    title: CONNECT_TITLES.github,
    steps,
    writes: 'Nothing it may do writes anything; replies and pushes stay yours.',
  }
}

function installedSaid(one: { account: string; repositories: 'all' | number }): string {
  const what =
    one.repositories === 'all'
      ? 'every repository'
      : `${one.repositories} ${one.repositories === 1 ? 'repository' : 'repositories'}`
  return `${what} of ${one.account}`
}

/** How long without a delivery before a hook that worked reads as one that stopped. */
export const QUIET_MS = 24 * 3_600_000

/**
 * Whether GitHub's deliveries arrive: the newest of a verified one and a
 * refused one decides, as `bellStands` decides for a schedule.
 */
function deliveries(look: GithubLook, now: number): ConnectStep {
  const title = 'Deliveries arrive'
  if (look.publicName === null) {
    return {
      id: 'deliveries',
      title,
      done: false,
      said: 'this machine has no public name, so GitHub cannot reach it and the watches poll every ten minutes — `tade host domain <name>` gives it one',
    }
  }
  if (!look.secret) {
    return {
      id: 'deliveries',
      title,
      done: false,
      said: look.app
        ? 'no secret is kept for its deliveries, so each is refused: make the App again from here, or set $GITHUB_WEBHOOK_SECRET'
        : `once it is made, GitHub delivers to https://${look.publicName}/hooks/github`,
    }
  }
  const { verified, refused } = look.heard
  if (refused !== null && (verified === null || refused > verified)) {
    return {
      id: 'deliveries',
      title,
      done: false,
      said: 'the newest delivery did not verify: the secret kept here is not the one GitHub signs with — make the App again from here',
    }
  }
  if (verified === null) {
    return {
      id: 'deliveries',
      title,
      done: false,
      said: `waiting for the first: GitHub delivers to https://${look.publicName}/hooks/github, and the watches poll hourly once one arrives`,
    }
  }
  if (now - verified > QUIET_MS) {
    return {
      id: 'deliveries',
      title,
      done: false,
      said: `nothing for over a day, the last at ${new Date(verified).toISOString().slice(0, 16).replace('T', ' ')} UTC: the watches poll as a safety net, and GitHub's own Advanced tab says what it sent`,
    }
  }
  return {
    id: 'deliveries',
    title,
    done: true,
    said: `the last verified at ${new Date(verified).toISOString().slice(11, 16)} UTC, so the watches poll hourly`,
  }
}

/** What the page knows of Slack now. */
export interface SlackLook {
  /** This machine's public name, where it has one: where Slack delivers and sends a browser back. */
  publicName: string | null
  /**
   * What of the app is kept in the config: its client id (a name, drawn), and
   * whether its client secret, its signing secret and a bot token are.
   */
  kept: { clientId: string | null; clientSecret: boolean; signingSecret: boolean; token: boolean }
  /**
   * Who the token kept here is, as Slack's `auth.test` answers — the workspace
   * and the app's own user — or why that could not be asked, `refused` where
   * Slack said the token is no good; null where no token is kept to ask with.
   */
  installed: { team: string; user: string } | { problem: string; refused: boolean } | null
  /** When a delivery from Slack last verified here — its check of the address too — and last did not. */
  heard: { verified: number | null; refused: number | null }
}

/**
 * Slack's page (REMOTE-TADE §6.3): make the app from a manifest, keep its
 * signing secret first, let Slack check the address, then install it — with
 * OAuth v2, whose redirect Slack sends only to HTTPS, so **with no public name
 * the app is made with no address and installed from its own page**, its
 * token kept here by hand, and its watch polls. That path is the one with no
 * public URL; Socket Mode, which a laptop could otherwise use, is not built.
 *
 * The signing secret goes in before Slack checks the address because the
 * doorbell answers Slack's `url_verification` only once its signature
 * verifies (`hooks.ts`): a check that came first is refused, and Slack's own
 * page then offers Retry.
 */
export function slackPage(look: SlackLook): ConnectPage {
  const { kept } = look
  const working = look.installed !== null && 'team' in look.installed ? look.installed : null
  const credentials = kept.clientId !== null && kept.clientSecret
  const make: ConnectStep = {
    id: 'make',
    title: 'Make a Slack app',
    done: kept.clientId !== null || kept.token,
    said:
      kept.clientId !== null || kept.token
        ? `made${kept.clientId === null ? '' : `: client ${kept.clientId} is kept here`} — an app of your own workspace's, which reads the channels you invite it to`
        : look.publicName === null
          ? 'one app in your own workspace, made from a manifest: it reads the channels you invite it to, and with no public name here it is sent nothing, so its watch polls'
          : 'one app in your own workspace, made from a manifest: it reads the channels you invite it to, and Slack tells this machine when somebody mentions it',
    press: {
      act: 'make',
      label: kept.clientId !== null || kept.token ? 'Make another' : 'Make it on Slack',
      replaces:
        'Making another means keeping its secrets here again; the old app stays in your workspace until you delete it there.',
    },
  }
  const said = working === null ? null : slackInstalledSaid(working)
  if (look.publicName === null) {
    return {
      source: 'slack',
      title: CONNECT_TITLES.slack,
      writes: SLACK_WRITES,
      steps: [
        make,
        {
          id: 'install',
          title: 'Install it, and keep its token',
          done: working !== null,
          said:
            said ??
            (look.installed !== null && 'problem' in look.installed
              ? tokenTrouble(look.installed)
              : 'on Slack, press Install to Workspace on the app’s Install App page, then keep the Bot User OAuth Token (xoxb-…) it shows here'),
          press: {
            act: 'keep',
            label: kept.token ? 'Replace it' : 'Keep it',
            fields: [{ name: 'token', label: 'Bot User OAuth Token', secret: true }],
          },
        },
        {
          id: 'deliveries',
          title: 'Mentions arrive',
          done: false,
          said: 'this machine has no public name, so Slack cannot reach it: the watch polls every couple of minutes, and a mention inside a thread is seen only where it was also sent to the channel — `tade host domain <name>` gives it one',
        },
      ],
    }
  }
  const address = `https://${look.publicName}/hooks/slack`
  const keep: ConnectStep = {
    id: 'keep',
    title: 'Give this machine its signing secret',
    done: kept.signingSecret && (credentials || working !== null),
    said:
      kept.signingSecret && (credentials || working !== null)
        ? 'kept here: the signing secret Slack signs each delivery with, and the client id and secret installing it takes'
        : 'from the app’s Basic Information on Slack, before anything else: its signing secret, so this machine can answer Slack’s check of its address, and the client id and secret, which installing it takes',
    press: {
      act: 'keep',
      label: kept.signingSecret ? 'Replace them' : 'Keep them',
      fields: [
        { name: 'signing_secret', label: 'Signing Secret', secret: true },
        { name: 'client_id', label: 'Client ID', secret: false, placeholder: kept.clientId ?? '' },
        { name: 'client_secret', label: 'Client Secret', secret: true },
      ],
    },
  }
  return {
    source: 'slack',
    title: CONNECT_TITLES.slack,
    writes: SLACK_WRITES,
    steps: [make, keep, slackDeliveries(look, address), slackInstall(look, credentials, said)],
  }
}

/** What Slack's app may write: only what the reply grant lets it, and only there. */
const SLACK_WRITES =
  'It writes nothing unless you turn reply on in Settings › Intake, and then only a reaction and one of Tade’s own sentences, in the request’s own thread.'

function slackInstalledSaid(working: { team: string; user: string }): string {
  return `installed in ${working.team} as @${working.user}: invite it to the channel it should read (/invite @${working.user}), and turn on intake.slack with that channel’s id`
}

function tokenTrouble(trouble: { problem: string; refused: boolean }): string {
  return trouble.refused
    ? `the token kept here is no longer good (${trouble.problem}): install it again`
    : `Slack could not be asked whether its token works: ${trouble.problem}`
}

/**
 * Whether Slack's deliveries verify here: its check of the address is the
 * first, so a verified one is done. **No quiet after a day**, unlike GitHub's:
 * Slack sends only mentions, and a channel nobody mentioned Tade in for a day
 * is a quiet channel, not a broken hook.
 */
function slackDeliveries(look: SlackLook, address: string): ConnectStep {
  const title = 'Slack checks the address'
  const { verified, refused } = look.heard
  if (!look.kept.signingSecret) {
    return {
      id: 'deliveries',
      title,
      done: false,
      said: `once its signing secret is kept: Slack delivers to ${address}, and its check is answered only with the secret here`,
    }
  }
  if (refused !== null && (verified === null || refused > verified)) {
    return {
      id: 'deliveries',
      title,
      done: false,
      said: 'the newest delivery did not verify: the signing secret kept here is not the app’s — keep it again from its Basic Information',
    }
  }
  if (verified === null) {
    return {
      id: 'deliveries',
      title,
      done: false,
      said: `in the app’s Event Subscriptions on Slack, press Retry beside ${address}: this machine answers its check now`,
    }
  }
  return {
    id: 'deliveries',
    title,
    done: true,
    said: `verified, the last at ${new Date(verified).toISOString().slice(0, 16).replace('T', ' ')} UTC: a mention makes the Slack watch look at once, inside a thread too`,
  }
}

/** Installing it with OAuth v2, which comes back to this machine's public name. */
function slackInstall(look: SlackLook, credentials: boolean, said: string | null): ConnectStep {
  const title = 'Install it in your workspace'
  const press = credentials
    ? {
        press: {
          act: 'install' as const,
          label: look.installed === null ? 'Install it on Slack' : 'Install it again',
        },
      }
    : {}
  if (said !== null) return { id: 'install', title, done: true, said, ...press }
  if (look.installed !== null && 'problem' in look.installed) {
    return { id: 'install', title, done: false, said: tokenTrouble(look.installed), ...press }
  }
  return {
    id: 'install',
    title,
    done: false,
    said: credentials
      ? 'Slack asks you to allow it in your workspace, then sends the browser back here and its token is kept'
      : 'once its client id and secret are kept: Slack asks you to allow it, then sends the browser back here',
    ...press,
  }
}

/**
 * Said where the pages are offered, once: who may use them, and what they
 * cannot do.
 */
export const CONNECT_IS_HERE =
  'These pages answer on this machine alone — here, or through SSH — and nothing a phone holds reaches them. Connecting lets Tade read; it grants nobody anything: whose words count and whether Tade may answer are still yours to write in Settings › Intake.'
