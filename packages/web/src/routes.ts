import type { Scope } from './surface.ts'

// Every path the away view answers, as a table.
//
// **Read-only is enforced by absence, and this table is where somebody checks
// it in forty lines.** DESIGN.md said the test should assert every entry is a
// `GET`; that test cannot pass against DESIGN.md's own Phase 1, which has a
// `POST` that mints a session and a `DELETE` that destroys one. So the
// invariant is the one the `GET`-only claim was reaching for, and it is
// stronger for being sayable:
//
//   **No route mutates a project or a task.**
//
// The two non-`GET` entries are *session lifecycle* — this browser's own
// credential, created and destroyed — and `test/routes.test.ts` asserts the set
// of them is exactly those two, by name. A third one fails that test until
// somebody puts it in the set deliberately, which is the conversation the
// claim was for.
//
// What is **not** here matters as much as what is: no route reads a setting, no
// route writes one, no route grants anything, no route publishes anything, no
// route starts an agent and no route reaches the `ToolHost`. By §10.8 a path
// that is not in this table is a `404` and not a `403` — an off capability is
// not a thing to probe — so the absences cost nothing to keep.

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
  /** The scope a device needs. Nothing in Phase 1 needs more than `read`. */
  needs: Scope
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
}

export const ROUTES: readonly Route[] = [
  // The shell, and the pairing page, which is the same shell. Public, and the
  // thing that makes that safe is that it carries no data: it is a script that
  // asks `/api/snapshot`, and that route is a `401` without a session.
  // `test/server.test.ts` asserts the bytes of every public answer contain
  // nothing of the projection.
  { method: 'GET', path: '/', name: 'shell', needs: 'read', mutates: false, public: true },
  { method: 'GET', path: '/pair', name: 'pair page', needs: 'read', mutates: false, public: true },
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
 * The routes that are not `GET`, by name.
 *
 * Written out here rather than computed in the test, so that adding one is a
 * line in this file next to the argument for it. Both are session lifecycle;
 * neither touches a project or a task.
 */
export const LIFECYCLE = ['pair', 'sign out'] as const

/** The route for a method and a path, and the segment it matched. */
export function routeFor(
  method: string,
  path: string,
): { route: Route; params: Record<string, string> } | null {
  for (const route of ROUTES) {
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
