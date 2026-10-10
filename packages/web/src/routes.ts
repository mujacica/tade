import { SAYINGS } from './asked.ts'
import { SAVINGS } from './drafted.ts'
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
// The two non-`GET` entries are *session lifecycle* — this browser's own
// credential, created and destroyed — and `test/routes.test.ts` asserts the set
// of them is exactly those two, by name. A third one fails that test until
// somebody puts it in the set deliberately, which is the conversation the
// claim was for.
//
// **And the acting routes are not in it.** They are `ACTS`, a second table
// built from `VERBS`, and `routesFor` adds them only where
// `surfaces.web.acting` says so — so with that setting off there is no path to
// mutate a task at all, and `ROUTES` is still the forty lines somebody checks
// read-only against. That is Phase 1's guarantee kept rather than replaced: it
// was never "this program cannot act", it was "nothing here can", and absence
// is still how it is enforced.
//
// What is **not** here, in either table, matters as much as what is: no route
// reads a setting, no route writes one, no route grants anything, no route
// publishes anything, no route starts an agent, no route takes a path or a
// command, and no route reaches the `ToolHost`. By §10.8 a path that is not in
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
  /** Whether it may be answered with no session: the bootstrap, and nothing else. */
  public?: true
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
  shellAt('/queue', 'queue page'),
  // The factory floor. `:source`, `:id`, `:run` and `:name` are read and **not
  // used**, exactly as `:project` and `:task` are: the handler serves a file
  // out of a map, so a deep link to a request this device may not read is
  // byte-identical to one it may.
  shellAt('/inbox', 'inbox page'),
  shellAt('/i/:source/:id', 'request page'),
  shellAt('/runs', 'runs page'),
  shellAt('/r/:run', 'run page'),
  shellAt('/workflows', 'workflows page'),
  shellAt('/w/:name', 'workflow page'),
  shellAt('/checks', 'checks page'),
  shellAt('/reviews', 'reviews page'),
  shellAt('/spend', 'spend page'),
  shellAt('/findings', 'findings page'),
  shellAt('/notes', 'notes page'),
  shellAt('/talk', 'talk page'),
  shellAt('/devices', 'devices page'),
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
  { method: 'GET', path: '/api/devices', name: 'devices', needs: 'read', mutates: false },

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
]

/**
 * The routes that are not `GET` in `ROUTES`, by name.
 *
 * Written out here rather than computed in the test, so that adding one is a
 * line in this file next to the argument for it. Both are session lifecycle;
 * neither touches a project or a task.
 */
export const LIFECYCLE = ['pair', 'sign out'] as const

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
 * The table this listener answers from, which is a fact about the config.
 *
 * Built once, when the server is made, which is why turning any of the three
 * capabilities **on** waits for a restart and turning one **off** does not:
 * the table is the strongest half of each gate and the live re-read
 * (`WebActing.unlocked`, `WebAsking.unlocked`, `WebDrafting.unlocked`) is the
 * half that can only ever take authority away. Asymmetric in the safe
 * direction, and each setting's own words say so.
 */
export function routesFor(surface: Surface): readonly Route[] {
  return [
    ...ROUTES,
    ...(surface.acting ? ACTS : []),
    ...(surface.talking ? ASKS : []),
    ...(surface.drafting ? DRAFTS : []),
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
