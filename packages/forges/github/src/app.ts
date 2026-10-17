import { createPrivateKey, createSign } from 'node:crypto'
import {
  type AppAsk,
  type AppForm,
  type AppWant,
  type ForgeApp,
  ForgeError,
  type MadeApp,
} from '@tade/forges-core'

// A GitHub App the person makes from a manifest, and asking as it
// (REMOTE-TADE.md §6.3): what the manifest says, the token an app signs for
// itself, and reading back what GitHub handed over once.
//
// **Read-only, on purpose and for good** (§14 decision 10). The GitHub door has
// no way back — nothing Tade reads there can be something it wrote — and
// agents push with the person's own git credentials, so every permission here
// is `read` and there is no field a write could go in.
//
// **Webhooks built in** where this machine has a public name: the manifest
// carries the delivery address and the events, and GitHub hands back the
// secret the deliveries are signed with. Without a public name the app is made
// with no webhook at all, because GitHub cannot reach a laptop, and its
// watches poll as they always did.

/**
 * What the app is allowed, by GitHub's own name for each permission, with why.
 * `metadata` is every app's and is said anyway, so the page leaves nothing out.
 */
export const APP_PERMISSIONS: readonly (AppAsk & { permission: string })[] = [
  {
    permission: 'issues',
    what: 'Issues: read',
    why: 'to read an issue somebody on your list labelled for Tade, and who applied the label',
  },
  {
    permission: 'pull_requests',
    what: 'Pull requests: read',
    why: 'to read your reviews — their conversations, what they change, whether they conflict',
  },
  {
    permission: 'checks',
    what: 'Checks: read',
    why: 'to see which checks failed on a branch or a review',
  },
  {
    permission: 'statuses',
    what: 'Commit statuses: read',
    why: 'to see what CI that reports by commit status says',
  },
  {
    permission: 'actions',
    what: 'Actions: read',
    why: 'to read the log of a workflow run that failed',
  },
  {
    permission: 'metadata',
    what: 'Metadata: read',
    why: 'every app has it: a repository’s name, and that it is there',
  },
]

/**
 * The deliveries the app is sent, each one a doorbell some watch declares:
 * an issue labelled or commented on (intake), a review opened, pushed to,
 * reviewed or commented on (the comment and conflict watches), and CI
 * finishing (the check watches). Nothing else rings anything here.
 */
export const APP_EVENTS: readonly string[] = [
  'issues',
  'issue_comment',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'check_suite',
  'workflow_run',
  'status',
]

/** The form that makes the app at `host`, as GitHub's manifest flow takes it. */
export function appFormAt(host: string, want: AppWant): AppForm {
  const manifest = {
    name: want.name,
    url: want.home,
    ...(want.hook === null ? {} : { hook_attributes: { url: want.hook, active: true } }),
    redirect_url: want.made,
    setup_url: want.installed,
    // Installing is how somebody picks repositories, and the page they come
    // back to says what came of it: there is no setup beyond that to send them
    // to on every later change.
    setup_on_update: false,
    public: false,
    default_permissions: Object.fromEntries(APP_PERMISSIONS.map((one) => [one.permission, 'read'])),
    default_events: want.hook === null ? [] : [...APP_EVENTS],
  }
  const state = encodeURIComponent(want.state)
  const url = want.organisation
    ? `https://${host}/organizations/${encodeURIComponent(want.organisation)}/settings/apps/new?state=${state}`
    : `https://${host}/settings/apps/new?state=${state}`
  return {
    url,
    fields: { manifest: JSON.stringify(manifest) },
    asks: APP_PERMISSIONS.map(({ what, why }) => ({ what, why })),
    events: want.hook === null ? [] : APP_EVENTS,
  }
}

/** How long an app's own token is good for. GitHub refuses more than ten minutes. */
const JWT_SECONDS = 9 * 60

/**
 * The token an app signs for itself: RS256 over its id and a few minutes,
 * which is what GitHub takes to say which installation is where and to hand
 * out an installation's token. Backdated a minute, as GitHub advises, for a
 * clock a little ahead of theirs.
 *
 * A key that cannot be read is `auth`, said without a byte of the key in it.
 */
export function appToken(app: ForgeApp, now: number): string {
  let key: ReturnType<typeof createPrivateKey>
  try {
    key = createPrivateKey(pemOf(app.key))
  } catch {
    throw new ForgeError(
      'auth',
      `the private key kept for GitHub App ${app.id} is not one: connect GitHub again, or set $GITHUB_APP_PRIVATE_KEY to the .pem GitHub gave you`,
    )
  }
  const seconds = Math.floor(now / 1000)
  const head = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const body = base64url(
    JSON.stringify({ iat: seconds - 60, exp: seconds + JWT_SECONDS, iss: app.id }),
  )
  const signed = createSign('RSA-SHA256').update(`${head}.${body}`).sign(key)
  return `${head}.${body}.${signed.toString('base64url')}`
}

/**
 * A PEM as it is kept: GitHub's own bytes in the config, or a variable that
 * held it on one line with its newlines written as `\n`, which is how a key is
 * usually put in an environment.
 */
export function pemOf(kept: string): string {
  return kept.includes('\\n') && !kept.includes('\n') ? kept.replace(/\\n/g, '\n') : kept
}

function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url')
}

/** What GitHub handed over for a code, in the port's words; a field missing is a refusal. */
export function madeFrom(body: unknown, host: string): MadeApp {
  const one = (body ?? {}) as Record<string, unknown>
  const owner = (one.owner ?? {}) as Record<string, unknown>
  const id = one.id
  const slug = one.slug
  const pem = one.pem
  if ((typeof id !== 'number' && typeof id !== 'string') || typeof slug !== 'string') {
    throw new ForgeError('refused', `${host} did not say which app it made`)
  }
  if (typeof pem !== 'string' || pem.trim() === '') {
    throw new ForgeError('refused', `${host} made the app and handed over no key for it`)
  }
  return {
    id: String(id),
    slug,
    name: typeof one.name === 'string' ? one.name : slug,
    owner: typeof owner.login === 'string' ? owner.login : '',
    url: typeof one.html_url === 'string' ? one.html_url : `https://${host}/apps/${slug}`,
    key: pem,
    hookSecret:
      typeof one.webhook_secret === 'string' && one.webhook_secret !== ''
        ? one.webhook_secret
        : null,
  }
}
