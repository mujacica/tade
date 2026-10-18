import {
  CONNECT_FLOWS,
  CONNECT_SOURCES,
  type ConnectBack,
  type ConnectPress,
  type ConnectSource,
  HOOK_SOURCES,
  type HookSource,
} from '@tade/core'
import { SAYINGS } from './asked.ts'
import { CHANGES } from './configured.ts'
import { SAVINGS } from './drafted.ts'
import { PUSHINGS } from './pushed.ts'
import type { Scope, Surface } from './surface.ts'
import { VERBS } from './verbs.ts'

// Every path the away view answers, as a table.
//
// **Read-only is enforced by absence, and this table is where somebody checks
// it in forty lines.** DESIGN.md said the test should assert every entry is a
// `GET`; that test cannot pass against DESIGN.md's own Phase 1, which has a
// `POST` that mints a session and a `DELETE` that destroys one. So the
// invariant is the one the `GET`-only claim was reaching for, and it is
// stronger for being sayable:
//
//   **No route in `ROUTES` mutates a project or a task.**
//
// The non-`GET` entries are *session lifecycle* — this browser's own
// credential, created, destroyed and proved with its passkey — and
// `test/routes.test.ts` asserts the set of them is exactly `LIFECYCLE`, by
// name. Another fails that test until somebody puts it in the set
// deliberately, which is the conversation the claim was for.
//
// **And the acting routes are not in it.** They are `ACTS`, a second table
// built from `VERBS`, and `routesFor` adds them only where
// `surfaces.web.acting` says so — so with that setting off there is no path to
// mutate a task at all, and `ROUTES` is still the forty lines somebody checks
// read-only against. That is Phase 1's guarantee kept rather than replaced: it
// was never "this program cannot act", it was "nothing here can", and absence
// is still how it is enforced.
//
// What is **not** here, in any table, matters as much as what is: no route
// grants anything, no route publishes anything, no route starts an agent —
// but the owner's `take`, which makes queued work the window starts by its own
// rule (`taken.ts`) — no route takes a path or a command, and no route reaches
// the `ToolHost`. One
// route reads the settings, behind a grant, and the one that writes one is
// `SETTINGS`, built only where `surfaces.web.settings` says so and reaching
// `settingReach`'s `open` tier and nothing else (`configuring.ts`). By §10.8 a path that is not in
// the table is a `404` and not a `403` — an off capability is not a thing to
// probe — so the absences cost nothing to keep.

/** One route: how it is reached, what it needs, and what it is allowed to do. */
export interface Route {
  method: 'GET' | 'POST' | 'DELETE'
  /** The path, with `:name` for one segment. */
  path: string
  /**
   * Whether this route owns everything under its path.
   *
   * True of exactly one route — the static files — and `test/routes.test.ts`
   * says so. It is not a traversal risk, because what the handler does with
   * the rest of the path is **look it up in a map of the files that exist**:
   * `/assets/../../config.yaml` reaches a `Map.get` that answers nothing, not
   * a filesystem call that has to refuse it. A traversal here is not refused,
   * it is unrepresentable.
   */
  under?: true
  /** What this route is called, in the journal and in a test's words. */
  name: string
  /** The scope a device needs. Nothing in `ROUTES` needs more than `read`. */
  needs: Scope
  /**
   * The verb this route is, where it is one of `ACTS`.
   *
   * The name is in the path and could be read back out of it; it is carried
   * instead, because a handler that parsed a verb out of a URL is a handler
   * one route change away from accepting a verb nobody declared. Here it is
   * the table that holds the name, and `VERBS` is the closed list it came
   * from.
   */
  verb?: string
  /**
   * The draft field this route saves, where it is one of `DRAFTS`.
   *
   * Carried rather than read back out of the path, for the reason `verb` and
   * `says` are. A route has exactly one of the three and never two, and
   * `test/routes.test.ts` says so.
   */
  saves?: string
  /**
   * What about notifications this route changes, where it is one of `PUSHES`.
   *
   * Carried rather than read back out of the path, for the reason `verb`,
   * `saves` and `says` are. A route has exactly one of the four and never two,
   * and `test/routes.test.ts` says so.
   */
  notifies?: string
  /**
   * What this route does to a setting, where it is one of `SETTINGS`.
   *
   * Carried rather than read back out of the path, for the reason `verb`,
   * `saves`, `notifies` and `says` are. A route has exactly one of the five and
   * never two, and `test/routes.test.ts` says so.
   */
  configures?: string
  /**
   * The thing this route says to the conversation, where it is one of `ASKS`.
   *
   * Carried rather than read back out of the path, for the reason `verb` is: a
   * handler that parsed a name out of a URL is a handler one route change away
   * from accepting a name nobody declared. A route has one or the other and
   * never both — a verb reaches a `WebActing` method and this reaches a
   * `WebAsking` one, and `test/routes.test.ts` says so.
   */
  says?: string
  /**
   * Whether it changes anything at all. Mutations carry the cross-site layers:
   * an exact `Origin`, JSON only, and the session's own token.
   */
  mutates: boolean
  /**
   * Whether it is the route that mints a session, and so cannot present one.
   *
   * Exactly one route may be this, and `test/routes.test.ts` says which. It is
   * not an exemption from the guard — the `Host`, `Origin`, `Sec-Fetch-Site`,
   * content-type and rate-limit layers all still apply — it is the fact that
   * there is no session or token yet to check, because this is the request
   * that creates them. What authorises it is the keypress at the machine.
   */
  opens?: true
  /** Whether it may be answered with no session: the bootstrap, and a delivery (`rings`). */
  public?: true
  /**
   * The source whose deliveries this route takes, where it is one of `HOOKS`.
   *
   * Carried rather than read back out of the path, for the reason `verb` is.
   * The guard answers such a route on the public listener alone and asks none
   * of a browser's layers of it, because no browser sends one: what
   * authenticates a delivery is its signature (`hooked.ts`).
   */
  rings?: HookSource
  /**
   * Whether only this machine may reach it: the loopback listener and a
   * loopback `Host` (`thisMachine`), which from anywhere else is a person over
   * SSH. Everywhere else it is the `404` of a path nobody built — the public
   * listener above all, which is the internet through Caddy.
   *
   * `presence` is the first: an owner's link saying the person is at another
   * of their screens, which an owner session could only ever say through here.
   * The guided page that connects a source and its presses (`CONNECTS`) are
   * the others, so that a page like that is one word in its route rather than
   * a rule somebody remembers.
   */
  here?: true
  /**
   * Whether the person's own device (`theirsOf`: full access, not a machine
   * link) is answered this `here` route on **any** door, as an owner is on
   * this one. Off this machine's door the guard lets it through only for a
   * session that is theirs at that request — every other is still the `404`
   * of a path nobody built — and asks it what acting asks, a trusted origin
   * and the passkey, because what it reaches is the SSH key's.
   *
   * The person decided it: their phone is the device they can pull the plug
   * on, so it may do what they can. Revoking it, or unticking one box, makes
   * it an ordinary device at the next request (`sessionOf` reads the record).
   */
  theirs?: true
  /**
   * What this route is in connecting a source (REMOTE-TADE §6.4,
   * `connected.ts`), where it is one of `CONNECTS`: the guided `page`, one
   * `press` on it — each answered on this machine alone and with no session,
   * because reaching that door is what a session would prove — or where the
   * source sends the browser `back`, answered on any door and only for the
   * one-time word a press minted.
   */
  connects?: 'page' | 'press' | 'back'
  /** The source a press or a callback is about, carried for the reason `rings` is. */
  source?: ConnectSource
  /** Which press it is, where it is one: carried, so nothing reads it back out of the name. */
  press?: ConnectPress
  /** Which callback it is, where the source sends the browser back. */
  back?: ConnectBack
  /**
   * Whether this path is answered with the shell.
   *
   * `assets.ts` asks the table rather than keeping its own list of the document
   * paths, because two lists of the same thing is a screen that deep-links to a
   * `404` on the day somebody adds one to only the other.
   */
  document?: true
}

/** A path answered with the shell: one `GET`, public, carrying no data. */
function shellAt(path: string, name: string): Route {
  return { method: 'GET', path, name, needs: 'read', mutates: false, public: true, document: true }
}

export const ROUTES: readonly Route[] = [
  // **Every screen's own path, and all of them answered with the same bytes.**
  // Public, and the thing that makes that safe is that the shell carries no
  // data at all: it is a script that asks `/api/snapshot`, and that route is a
  // `401` without a session. `test/server.test.ts` asserts the bytes of every
  // public answer contain nothing of the projection.
  //
  // They are enumerated rather than matched with a wildcard for two reasons. A
  // wildcard would make this table stop being the list of what the away view
  // answers — which is the thing somebody checks read-only against in forty
  // lines — and it would turn every mistyped path into a page that loads and
  // then says it knows nothing, instead of the `404` it is.
  //
  // `:project` and `:task` are read and **not used**: the handler serves a file
  // out of a map. So a deep link to a project that is not there, or that this
  // device may not read, is byte-identical to one that is — which is the only
  // way a public route can carry a name in its path without answering a
  // question about it.
  shellAt('/', 'shell'),
  shellAt('/pair', 'pair page'),
  shellAt('/p/:project', 'project page'),
  shellAt('/t/:project/:task', 'task page'),
  // Every agent running, across every project this device may read: the
  // window's own side list, as a page of its own on a phone and a tablet.
  shellAt('/agents', 'agents page'),
  shellAt('/queue', 'queue page'),
  // The factory floor. `:source`, `:id`, `:run` and `:name` are read and **not
  // used**, exactly as `:project` and `:task` are: the handler serves a file
  // out of a map, so a deep link to a request this device may not read is
  // byte-identical to one it may.
  shellAt('/inbox', 'inbox page'),
  shellAt('/i/:source/:id', 'request page'),
  shellAt('/plans', 'plans page'),
  shellAt('/plans/:run', 'plan page'),
  // The plans' old addresses, from before a run of a workflow was called a
  // plan: still the shell, so a bookmark or a pushed link lands, and the page
  // writes the new address over it (`movedFrom` in `assets/routes.js`).
  shellAt('/runs', 'old plans page'),
  shellAt('/r/:run', 'old plan page'),
  shellAt('/workflows', 'workflows page'),
  shellAt('/w/:name', 'workflow page'),
  shellAt('/checks', 'checks page'),
  shellAt('/evals', 'evaluations page'),
  shellAt('/reviews', 'reviews page'),
  shellAt('/spend', 'spend page'),
  shellAt('/findings', 'findings page'),
  shellAt('/notes', 'notes page'),
  shellAt('/talk', 'talk page'),
  shellAt('/devices', 'devices page'),
  shellAt('/settings', 'settings page'),
  shellAt('/more', 'more page'),
  // The service worker, at the root because that is what decides its scope: a
  // worker is only allowed to control paths under the folder it was served
  // from, so one served out of `/assets/` could never answer for `/`. Public
  // like the shell and for the same reason — it is the shell's own file list
  // and a version, and it can draw nothing.
  //
  // Not a `document`: it is answered with the worker rather than with
  // `index.html`, and `assets.ts` asks that flag to decide which. Not an
  // asset either, because what is served here is the file in the folder with
  // a line of JSON in front of it (`installable.ts`).
  {
    method: 'GET',
    path: '/sw.js',
    name: 'worker',
    needs: 'read',
    mutates: false,
    public: true,
  },

  // The stylesheet and the script. Public for the same reason the shell is:
  // they carry no data, and everything they draw they have to ask a route
  // that needs a session for.
  {
    method: 'GET',
    path: '/assets',
    name: 'assets',
    needs: 'read',
    mutates: false,
    public: true,
    under: true,
  },

  // Pairing: the one route that mints a credential, and the one route with no
  // credential to present. DECISIONS §4.2.
  {
    method: 'POST',
    path: '/api/pair',
    name: 'pair',
    needs: 'read',
    mutates: true,
    opens: true,
    public: true,
  },

  // Everything that carries data. Each one a session, every time.
  { method: 'GET', path: '/api/snapshot', name: 'snapshot', needs: 'read', mutates: false },
  // The live stream. A `GET` like every other read, and the one route whose
  // answer stays open — which is why `server.ts` answers a *reopened* dead
  // session here with `204` rather than `401`: a non-200 kills an
  // `EventSource` permanently, and `204` is how a browser is told to stop
  // retrying rather than hammering a port it will never get into.
  { method: 'GET', path: '/api/stream', name: 'stream', needs: 'read', mutates: false },
  { method: 'GET', path: '/api/notes', name: 'notes', needs: 'read', mutates: false },
  // **One agent, read while somebody is looking at it.** A `GET`, like every
  // other read, and it changes nothing about the work: what asking does is
  // tell the window that a device is still looking, which is what keeps it
  // reading that lane (`web-lanes.ts`) — and a page that stops asking stops
  // that within a beat or two. The screen's rows are behind the device's own
  // `lanes` grant, checked in the projection (`agentOf`) rather than here,
  // because a grant is per device and this route is the same for all of them.
  {
    method: 'GET',
    path: '/api/agent/:project/:task',
    name: 'agent',
    needs: 'read',
    mutates: false,
  },
  { method: 'GET', path: '/api/devices', name: 'devices', needs: 'read', mutates: false },
  // **What Tade is set up with, read while somebody has the page open.** A
  // `GET` like every other read, and the same for every device: what it may
  // see is the device's own `settings` grant, checked in the answer
  // (`settingsFor`) as `lanes` is in an agent's, and a key is never in it
  // under any grant. It changes nothing — the one route that does is in
  // `SETTINGS`, a table of its own behind a setting of its own.
  { method: 'GET', path: '/api/settings', name: 'settings', needs: 'read', mutates: false },
  // **The scorecards, read while somebody has the page open**, folded over the
  // projects this device reads, with money and the judge behind their grants
  // (`evaluationsFor`). A `GET` that changes nothing, like the settings.
  { method: 'GET', path: '/api/evaluations', name: 'evaluations', needs: 'read', mutates: false },

  // Signing out. A mutation, because it destroys a credential — and **its own
  // only**: revoking another device is the window's, which is the rule that
  // keeps one stolen phone from disconnecting the others while it works.
  {
    method: 'DELETE',
    path: '/api/devices/:id',
    name: 'sign out',
    needs: 'read',
    mutates: true,
  },

  // **This device's passkey: a challenge, and its answer** (`passkeyed.ts`).
  // Lifecycle like the two above — this browser's own credential, made in the
  // minutes after pairing and used before acting from the public name — and
  // `read`, because proving it may act cannot itself need the proof. A
  // mutation, so the token and the exact `Origin` are asked like any other.
  {
    method: 'POST',
    path: '/api/passkey/challenge',
    name: 'passkey challenge',
    needs: 'read',
    mutates: true,
  },
  {
    method: 'POST',
    path: '/api/passkey/answer',
    name: 'passkey answer',
    needs: 'read',
    mutates: true,
  },

  // **Somebody is at another of their screens** (`presence.ts`): an owner's
  // link saying how long ago a key was pressed there, so nothing buzzes a
  // phone while the person sits at the Mac. Lifecycle like the passkey — this
  // device's own word about the person holding it, written to no file and
  // touching no project — and only on this machine's own door (`here`), which
  // is the one door an owner session can be used at, but for the person's own
  // phone (`theirs`), which may say it from any door.
  {
    method: 'POST',
    path: '/api/presence',
    name: 'presence',
    needs: 'read',
    mutates: true,
    here: true,
    theirs: true,
  },

  // **This device's own page is in front of somebody** (`looking.ts`): any
  // paired device, from any listener, and only ever about what *it* is sent —
  // the push sender reads it for that device and no other. Lifecycle for the
  // reason `presence` is: the device's word about the person holding it,
  // written to no file and touching no project.
  { method: 'POST', path: '/api/looking', name: 'looking', needs: 'read', mutates: true },
]

/**
 * The routes that are not `GET` in `ROUTES`, by name.
 *
 * Written out here rather than computed in the test, so that adding one is a
 * line in this file next to the argument for it. All are session lifecycle —
 * minting one, ending one, its passkey, an owner saying the person is at
 * another of their screens, and a device saying its own page is being looked
 * at — and none touches a project or a task.
 */
export const LIFECYCLE = [
  'pair',
  'sign out',
  'passkey challenge',
  'passkey answer',
  'presence',
  'looking',
] as const

/**
 * The acting routes: **one path per verb**, and the table is `VERBS`.
 *
 * A path each rather than one `/api/act/:verb`, and the reason is the scope
 * check. A single route would need one `needs` for every verb, which is either
 * the weakest of them — so a device granted `answer` could park something —
 * or the strongest, so the gentler verbs need more than they should. With a
 * route each, the guard's existing per-route scope check is exact and nothing
 * new had to learn about verbs.
 *
 * It also means there is no handler anywhere that takes a name and dispatches
 * on it: a name that is not in `VERBS` has no path, and a path that has no
 * route is a `404`.
 */
export const ACTS: readonly Route[] = VERBS.map((verb) => ({
  method: 'POST' as const,
  path: `/api/act/${verb.name}`,
  name: `act ${verb.name}`,
  needs: verb.needs,
  mutates: true,
  verb: verb.name,
}))

/**
 * The asking routes: **one path per thing a device may say**, and the table is
 * `SAYINGS`.
 *
 * A third table and not two more entries in `ACTS`, for the reason
 * `asking.ts` gives: a verb is a target plus the state it expects, and a
 * message has no target. They need a different scope (`ask`), a different
 * setting (`surfaces.web.orchestrator`) and a different interface, so folding
 * them in would mean `ACTS` carrying a row whose `verb` reaches no `WebActing`
 * method — which is exactly the shape `carryOut` answers with a `404`.
 *
 * A path each rather than one `/api/ask/:what`, so there is no handler that
 * takes a name and dispatches on it: a name that is not in `SAYINGS` has no
 * path, and a path that has no route is a `404`.
 */
export const ASKS: readonly Route[] = Object.keys(SAYINGS).map((name) => ({
  method: 'POST' as const,
  path: `/api/ask/${name}`,
  name: `ask ${name}`,
  // Both need `ask` and neither is implied by `answer` or `steer`: stopping
  // the turn you started is part of being able to start one, and a device that
  // may answer an approval has not been granted free text to a model.
  needs: 'ask' as Scope,
  mutates: true,
  says: name,
}))

/**
 * The notification routes: **one path per thing a device may ask about being
 * told**, and the table is `PUSHINGS`.
 *
 * A fourth table, and the one whose subject is not the work at all: a
 * subscription is this browser saying where to reach it, which is the category
 * `LIFECYCLE` is. It is a second table rather than two more entries there
 * because it has **a setting of its own** — and in this package a setting is
 * enforced by a table that is not built when it is off, so that a crafted call
 * is the `404` of a path nobody built rather than a `403` naming a setting.
 *
 * `read` and no more, which is the scope the whole table is at: being told
 * that two things want you reveals nothing this device could not already read.
 * The trusted-origin layer the guard applies above `read` is therefore not
 * reached, and is re-asked in `admitPush` instead with the argument for why —
 * a read-only credential that crossed a network in the clear must not buy an
 * outbound request.
 *
 * `/api/notify/...` and deliberately **not** `/api/push`, which
 * `test/routes.test.ts` keeps out of every table: that one is a git push, and
 * two meanings of one word in a route table is the ambiguity somebody resolves
 * by guessing.
 */
export const PUSHES: readonly Route[] = Object.keys(PUSHINGS).map((name) => ({
  method: 'POST' as const,
  path: `/api/notify/${name}`,
  name: `notify ${name}`,
  needs: 'read' as Scope,
  mutates: true,
  notifies: name,
}))

export const DRAFTS: readonly Route[] = Object.keys(SAVINGS).map((name) => ({
  method: 'POST' as const,
  path: `/api/draft/${name}`,
  name: `${name} a draft`,
  // `draft`, and implied by nothing: a device granted both acting tiers has
  // been granted eight bounded things about work that exists, and not a file
  // every future run of a workflow would be stamped from.
  needs: 'draft' as Scope,
  mutates: true,
  saves: name,
}))

/**
 * The changing route: **one path per thing a device may do to a setting**, and
 * the table is `CHANGES` — which has one entry.
 *
 * A fifth table rather than a thirteenth verb, for the reason `configuring.ts`
 * gives: the target is a dotted path into the config rather than a task, and
 * the write is the one door every setting goes through. One route and not one
 * per setting, because which settings a device reaches is `settingReach`'s
 * `open` tier — a function, with a project's name in some of its paths — and
 * a table built from it would be a second answer to the question it answers.
 * What keeps a `never` path off this route is the parse
 * (`readSettingChange`): it is not a change at all, so it is the `404` a path
 * nobody built is.
 *
 * `/api/settings/change` and not `/api/config`, which would read as the file.
 */
export const SETTINGS: readonly Route[] = Object.keys(CHANGES).map((name) => ({
  method: 'POST' as const,
  path: `/api/settings/${name}`,
  name: `${name} a setting`,
  // `configure`, and implied by nothing: a device granted every acting tier
  // has been granted things about work, not the config.
  needs: 'configure' as Scope,
  mutates: true,
  configures: name,
}))

/**
 * What only an owner may do, and only at this machine's own door: another
 * machine's Tade carrying its setup here (`carried.ts`), asking what to run
 * here to be shown one of its agents (`attached.ts`), asking what the person
 * missed while away (`since.ts`), sharing the person's notes
 * (`shared-notes.ts`), what this machine is (`machine.ts`), work handed
 * here to start (`taken.ts`), and a project moved here (`opened.ts`).
 *
 * A table of its own because each is what no ordinary device may ever be given: the
 * carry writes the config beyond `settingReach`'s `open` tier — preferences,
 * files and, on a press, keys — and so is the one exception to "no route
 * reaches a credential", and the attach line is the one answer that is a way
 * into a lane, and the take the one route that makes work; `test/routes.test.ts`
 * names each rather than lets one slip. What
 * makes them no wider than what already was is who may use them: an owner
 * session, which is the SSH key's (`owner.ts`), on the loopback listener for a
 * loopback `Host` (`here`), which from anywhere else is that same SSH
 * connection — and whoever holds the key can already edit `config.yaml` and
 * attach to a lane over it. No setting turns them on, because none would add
 * anything: each is answered where the window wired it, refused
 * (`out_of_scope`) to every session that is not an owner, and the `404` of a
 * path nobody built on every other door.
 *
 * **But the person's own device** (`theirs`, `theirsOf`), on the ones that
 * say so: the carry, the attach line, the catch-up, what this machine is, a
 * document, a tool that reads, presence and connecting a source, on any door.
 * The person decided it — their phone is the screen they can pull the plug
 * on, so it may do what their SSH key may — and it is read off the record at
 * every request, so revoking it or unticking one box ends it at the next.
 */
export const OWNED: readonly Route[] = [
  {
    method: 'POST',
    path: '/api/carry',
    name: 'carry',
    needs: 'read',
    mutates: true,
    here: true,
    theirs: true,
  },
  {
    method: 'POST',
    path: '/api/attach',
    name: 'attach',
    needs: 'read',
    mutates: true,
    here: true,
    theirs: true,
  },
  // What the person missed while they were away (`since.ts`): a read, folded
  // over this machine's journal from the last moment it counted them present.
  // A `POST` and `here` like its neighbours — an owner's, through SSH — and it
  // changes nothing; it is here rather than in `ROUTES` because it is read
  // from the cursor an owner's presence wrote, which no phone carries.
  {
    method: 'POST',
    path: '/api/since',
    name: 'since',
    needs: 'read',
    mutates: true,
    here: true,
    theirs: true,
  },
  // The person's notes shared with the machine that asks (`shared-notes.ts`):
  // what it gives is written into this home's `memory.jsonl`, which every
  // agent here is told — so an owner's, as an edit to that file over SSH is.
  {
    method: 'POST',
    path: '/api/notes/share',
    name: 'share notes',
    needs: 'read',
    mutates: true,
    here: true,
  },
  // Where each project is checked out here and the branches its work is on
  // (`repositories.ts`): a path on this machine, which no phone reads, for the
  // fetch another machine of the person's makes over the same SSH. A read.
  {
    method: 'POST',
    path: '/api/repositories',
    name: 'repositories',
    needs: 'read',
    mutates: true,
    here: true,
  },
  // What this machine is, for another of the person's that links to it
  // (`machine.ts`): its version, its public name's health, its own problems,
  // its schedules' looks and its documents. One of its documents, as text
  // (`document.ts`). And one of its extension tools that only reads, run with
  // its own settings (`tool-read.ts`). Each a read an `ssh` already allows.
  {
    method: 'POST',
    path: '/api/machine',
    name: 'machine',
    needs: 'read',
    mutates: true,
    here: true,
    theirs: true,
  },
  {
    method: 'POST',
    path: '/api/document',
    name: 'document',
    needs: 'read',
    mutates: true,
    here: true,
    theirs: true,
  },
  {
    method: 'POST',
    path: '/api/tool',
    name: 'tool',
    needs: 'read',
    mutates: true,
    here: true,
    theirs: true,
  },
  // The records this machine's public name needs, looked at now (`records.ts`):
  // what `tade host domain` says here, asked only while somebody there has its
  // Settings › Remotes open, because the look is asking the world. A read.
  {
    method: 'POST',
    path: '/api/records',
    name: 'records',
    needs: 'read',
    mutates: true,
    here: true,
  },
  // Work another machine of the person's hands this one (`taken.ts`): made
  // queued work in one of its projects, which the window here starts by its
  // own rule. The one route that makes work — what `ssh` here and `tade run
  // start` in that shell already allow the same key.
  { method: 'POST', path: '/api/take', name: 'take', needs: 'read', mutates: true, here: true },
  // A project another machine of the person's is moving here (`opened.ts`):
  // cloned with this machine's own credentials where it is not checked out
  // yet, and opened through the window's own door — what `ssh` here and
  // `git clone` already allow the same key.
  { method: 'POST', path: '/api/open', name: 'open', needs: 'read', mutates: true, here: true },
  // A source's guided page as it stands, and one press on it (`connected.ts`):
  // for another machine of the person's whose browser cannot reach this one's
  // own `/connect`, because its link ends in a socket no browser opens. What
  // the SSH key could already do here: edit `config.yaml`.
  {
    method: 'POST',
    path: '/api/connect',
    name: 'connect',
    needs: 'read',
    mutates: true,
    here: true,
    theirs: true,
  },
]

/**
 * The guided pages that connect a source (REMOTE-TADE §6.4, `connected.ts`):
 * the page, a press per thing it does — making the app, keeping what the
 * source's own page showed the person, installing it — and where the source
 * sends the browser back, a path apiece, and the table is each source's
 * `CONNECT_FLOWS`.
 *
 * A table of its own because none of them is anything a device asks: the page
 * and its presses are this machine's alone (`here`) and ask no session, since
 * turning a source on is `never`-tier and reaching that door is the person;
 * the two callbacks are on whichever door the source was told to send the
 * browser to — the public name, or this machine's own where it has none — and
 * are answered only for a one-time word a press here minted, for that host.
 * None of them grants anything: connecting makes the forge read as the app and
 * the doorbell ring, and whose words count stay three acts in Settings ›
 * Intake. Built always, and answered only where the window wired the half
 * that knows the sources; anywhere else the `404` of a path nobody built.
 *
 * `/connect/...` and not `/api/...`, which is the page's.
 */
export const CONNECTS: readonly Route[] = [
  {
    method: 'GET',
    path: '/connect',
    name: 'connect page',
    needs: 'read',
    mutates: false,
    here: true,
    connects: 'page',
  },
  // Each source's presses and callbacks, as its flow says (`CONNECT_FLOWS`):
  // GitHub makes and installs and comes back after each, Slack makes, keeps
  // what its own page shows the person, and comes back once it is installed.
  ...CONNECT_SOURCES.flatMap((source): Route[] => [
    ...CONNECT_FLOWS[source].presses.map(
      (press): Route => ({
        method: 'POST',
        path: `/connect/${source}/${press}`,
        name: `connect ${source} ${press}`,
        needs: 'read',
        mutates: true,
        here: true,
        connects: 'press',
        source,
        press,
      }),
    ),
    ...CONNECT_FLOWS[source].backs.map(
      (back): Route => ({
        method: 'GET',
        path: `/connect/${source}/${back}`,
        name: `connect ${source} ${back}`,
        needs: 'read',
        mutates: false,
        connects: 'back',
        source,
        back,
      }),
    ),
  ]),
]

/**
 * The doorbells (REMOTE-TADE §6.2): **one path per source a delivery may come
 * from**, and the table is `HOOK_SOURCES`.
 *
 * A third kind of table beside `ROUTES` and the five a setting turns on, and
 * built only where a public name is (`routesFor`): a webhook is a source's
 * server reaching this one over the internet, which is what a public name is
 * for and nothing else here is. Each is answered only while its source has a
 * secret, read at the delivery (`hooked.ts`), so a source nobody connected is
 * the `404` of a path nobody built — absence is the enforcement, as it is for
 * acting. Public, because no delivery has a session; mutating, because one
 * leaves a line and makes a look; and none of the five jobs, because what it
 * does is wake a schedule and never anything a device asks for.
 *
 * `/hooks/...` and not `/api/...`, which is the page's.
 */
export const HOOKS: readonly Route[] = HOOK_SOURCES.map((source) => ({
  method: 'POST' as const,
  path: `/hooks/${source}`,
  name: `hook ${source}`,
  needs: 'read' as Scope,
  mutates: true,
  public: true as const,
  rings: source,
}))

/**
 * The table this listener answers from, which is a fact about the config.
 *
 * Built once, when the server is made, which is why turning any of the
 * capabilities **on** waits for a restart and turning one **off** does not:
 * the table is the strongest half of each gate and the live re-read
 * (`WebActing.unlocked`, `WebAsking.unlocked`, `WebDrafting.unlocked`,
 * `WebConfiguring.unlocked`) is the half that can only ever take authority
 * away. Asymmetric in the safe
 * direction, and each setting's own words say so.
 */
export function routesFor(surface: Surface): readonly Route[] {
  return [
    ...ROUTES,
    ...(surface.acting ? ACTS : []),
    ...(surface.talking ? ASKS : []),
    ...(surface.drafting ? DRAFTS : []),
    ...(surface.pushing ? PUSHES : []),
    ...(surface.configuring ? SETTINGS : []),
    ...OWNED,
    ...CONNECTS,
    ...(surface.publicName === null ? [] : HOOKS),
  ]
}

/** The route for a method and a path, and the segment it matched. */
export function routeFor(
  method: string,
  path: string,
  routes: readonly Route[] = ROUTES,
): { route: Route; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method) continue
    const params = match(route.path, path, route.under === true)
    if (params !== null) return { route, params }
  }
  return null
}

/**
 * Whether a path is one route's, and what its one parameter was.
 *
 * Segment by segment, with nothing joined onto a path: a parameter is one
 * segment of a URL, already percent-decoded, and what each route does with one
 * is look it up in something it already holds. There is no route that builds a
 * file path out of a parameter, which is why there is nothing here that has to
 * refuse `..`.
 *
 * **Every route is matched under the method it was asked for**, so a path that
 * exists under another method finds nothing and is a `404` like any other. Not
 * a `405`: the design's answer to a capability being off is `404`, and a `405`
 * would tell whoever is probing that the path is real.
 */
function match(pattern: string, path: string, under = false): Record<string, string> | null {
  const wanted = pattern.split('/')
  const got = path.split('/')
  if (under) {
    // Everything below the prefix, and never the prefix itself: `/assets` is
    // a folder and not a file, so it answers nothing.
    if (got.length <= wanted.length) return null
    return matchParts(wanted, got.slice(0, wanted.length)) === null
      ? null
      : { rest: got.slice(wanted.length).join('/') }
  }
  if (wanted.length !== got.length) return null
  return matchParts(wanted, got)
}

function matchParts(
  wanted: readonly string[],
  got: readonly string[],
): Record<string, string> | null {
  const params: Record<string, string> = {}
  for (let at = 0; at < wanted.length; at++) {
    const part = wanted[at] ?? ''
    const value = got[at] ?? ''
    if (part.startsWith(':')) {
      if (value === '') return null
      params[part.slice(1)] = value
      continue
    }
    if (part !== value) return null
  }
  return params
}
