// Apps: something the person makes on a forge, owns, installs on the
// repositories they choose, and lets Tade read those repositories as
// (REMOTE-TADE.md §6.3).
//
// Its own file for the reason `tickets.ts` is one: a port within the port,
// with its own objects and its own capability (`capabilities.apps`) and its own
// conformance section. The arrow is types only, both ways.
//
// **Why an app at all, when a forge already finds the person's own sign-in.**
// The person's sign-in is the person's whole reach: every repository they can
// see, every write they may make, and one budget shared with everything else
// they do. An app is chosen per permission rather than per scope, installed on
// the repositories somebody picked, hands out a token that runs out within the
// hour, and has a budget of its own. So where one is installed on a repository,
// **reading that repository is asked as the app** (`ForgeOptions.app`), and
// everything else — what is about the person (whose a review is, what waits on
// them) and every write — is still asked as the person, exactly as before. An
// app Tade made is read-only, so there is nothing a write could be asked as.
//
// **Making one is the person's act, at a page they are signed in on.** A forge
// that can make one from a description declares how (`appForm`): where the
// browser posts and what it posts, and what it will ask for and why, so the
// page can say so before the press. The forge sends the browser back with a
// code, which `appMade` exchanges once for everything the app is — its private
// key among it, which is handed over that one time and never again.
//
// **Vocabulary rule (R2).** "App" and "installation" are the words GitHub,
// Slack and Linear all use for this shape, and none of them means a review, a
// token scope or a sign-in. Permission names, events and URLs are the forge's
// own and stay in its implementation; the port says only *that* it asks for
// something, and why.

/**
 * An app the person made on a forge, as Tade keeps it: enough to ask as it.
 *
 * Read out of the config where it was written once (`writeKey`), the
 * environment winning as it does for every key; never written by a forge.
 */
export interface ForgeApp {
  /**
   * The forge host it was made on: `github.com`. A forge asks as it only for a
   * repository on that host, so an app made on one never answers for another.
   */
  host: string
  /** Its id there. */
  id: string
  /** Its private key, as the forge handed it over the one time it does (PEM). */
  key: string
}

/**
 * What a person is asked to make: where it lives and where it answers. Never a
 * permission — what an app Tade makes may do is the forge's declaration
 * (`AppForm.asks`), and it only ever reads.
 */
export interface AppWant {
  /** The app's home page: this machine's public name, or where the page was opened. */
  home: string
  /**
   * Where deliveries go (`/hooks/<source>`), or null where this machine has no
   * public name: the app is then made with no webhook, and its watches poll.
   */
  hook: string | null
  /** Where the forge sends the browser back once the app is made. */
  made: string
  /** Where it sends the browser back once the app is installed. */
  installed: string
  /** The one-time word the browser carries there and back. */
  state: string
  /** A name to suggest. The person may change it before the press. */
  name: string
  /** Made under this organisation rather than the person's own account. */
  organisation?: string
}

/**
 * Where a browser posts to make the app, and what it posts.
 *
 * A form and never a request Tade makes, because only a page the person is
 * signed in on can make an app: the forge asks them, there, and Tade is told
 * the outcome.
 */
export interface AppForm {
  /** Where the form goes. */
  url: string
  /** What it carries, as the forge names each field. */
  fields: Readonly<Record<string, string>>
  /** What the app will be allowed, in the forge's own words, each with why. */
  asks: readonly AppAsk[]
  /** The kinds of delivery it will be sent, where it has a webhook: none without one. */
  events: readonly string[]
}

/** One thing an app will be allowed, and the reason it is asked for. */
export interface AppAsk {
  /** As the forge says it: `Issues: read`. */
  what: string
  /** Why Tade needs it, in one clause somebody reads before the press. */
  why: string
}

/**
 * An app just made: everything it is, handed over once.
 *
 * `key` is its private key and `hookSecret` what its deliveries are signed
 * with. Both go straight into the config through the one write path and are
 * never said anywhere else — not in the journal, not on the page that finishes
 * the making.
 */
export interface MadeApp {
  id: string
  /** The name its addresses use: `tade-on-vps`. */
  slug: string
  name: string
  /** The account that owns it. */
  owner: string
  /** Its page on the forge. */
  url: string
  key: string
  hookSecret: string | null
}

/** Where an app is installed, as the app reads it. */
export interface AppInstallation {
  id: string
  /** The account it is installed on. */
  account: string
  /**
   * Which of that account's repositories it may read: `all`, or how many it
   * was given. A count rather than names, because which repositories somebody
   * chose is theirs and the page only needs to say whether it is any.
   */
  repositories: 'all' | number
}
