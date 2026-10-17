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
// GitHub is the source this builds; Slack (V15) and Linear (V16) are connected
// from here once they are, which is why the page is per source and the table
// below has one row.

/** The sources a page here connects. Only what is built: a row is a promise. */
export const CONNECT_SOURCES = ['github'] as const
export type ConnectSource = (typeof CONNECT_SOURCES)[number]

/** How long a one-time word the owner minted is good for. GitHub gives its code an hour. */
export const CONNECT_STATE_MS = 10 * 60_000

/** What one press on a page asks for: making the app, or installing it. */
export type ConnectPress = 'make' | 'install'

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
  id: 'make' | 'install' | 'deliveries'
  title: string
  done: boolean
  /** One line: what is true, or what the press will do. */
  said: string
  press?: { act: ConnectPress; label: string }
}

/** One source's page. */
export interface ConnectPage {
  source: ConnectSource
  title: string
  steps: readonly ConnectStep[]
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
      press: made
        ? { act: 'make', label: 'Make another' }
        : { act: 'make', label: 'Make it on GitHub' },
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
  return { source: 'github', title: 'GitHub', steps }
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

/**
 * Said where the pages are offered, once: who may use them, and what they
 * cannot do.
 */
export const CONNECT_IS_HERE =
  'These pages answer on this machine alone — here, or through SSH — and nothing a phone holds reaches them. Connecting lets Tade read; it grants nobody anything: whose labels count and whether Tade may answer are still yours to write in Settings › Intake.'
