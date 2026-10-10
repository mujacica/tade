// Where the page is, read out of the address bar and written back into it.
//
// **Real paths, real history.** `pushState` over the paths the server itself
// serves the shell at, so every screen is deep-linkable, the back button is
// correct, and a reload lands on the same screen rather than at the top. No
// hash routing: the fragment is where the pairing ticket lives (§8.2), and a
// router that owned it would put a one-use credential into every navigation.
//
// **Every view here is a path in `src/routes.ts`.** A client route the server
// does not serve is a screen that works until somebody reloads it and then
// 404s, which is the worst kind of broken — it passes every test that never
// reloads. `test/routes-client.test.ts` asserts the two tables name the same
// paths, in both directions.
//
// Nothing here touches the DOM.

/** One segment of a path, decoded, or null where it is not one segment. */
function segment(raw) {
  if (raw === undefined || raw === '') return null
  try {
    const one = decodeURIComponent(raw)
    return one === '' || one.includes('/') ? null : one
  } catch {
    // A percent-escape that is not one. Not a name, so not a route.
    return null
  }
}

/**
 * Which screen a path is, or `nowhere`.
 *
 * `nowhere` is a real answer and the page draws it: a path the server served
 * the shell for but this router does not know is a version mismatch, and
 * saying so beats drawing the overview and pretending the link worked.
 */
export function viewOf(path) {
  const parts = path.replace(/\/+$/, '').split('/')
  const first = parts[1] ?? ''
  if (path === '/' || first === '') return { view: 'now' }
  if (first === 'p' && parts.length === 3) {
    const project = segment(parts[2])
    return project === null ? { view: 'nowhere' } : { view: 'project', project }
  }
  if (first === 't' && parts.length === 4) {
    const project = segment(parts[2])
    const task = segment(parts[3])
    if (project === null || task === null) return { view: 'nowhere' }
    return { view: 'task', project, task }
  }
  // One request, by the two halves of its item key. Two segments rather than
  // one `source:id`, because a colon in a path segment is percent-encoded by
  // some clients and not others, and a router that had to undo that would be
  // guessing at what a link means.
  if (first === 'i' && parts.length === 4) {
    const source = segment(parts[2])
    const id = segment(parts[3])
    if (source === null || id === null) return { view: 'nowhere' }
    return { view: 'request', source, id }
  }
  if (first === 'r' && parts.length === 3) {
    const run = segment(parts[2])
    return run === null ? { view: 'nowhere' } : { view: 'run', run }
  }
  if (first === 'w' && parts.length === 3) {
    const name = segment(parts[2])
    return name === null ? { view: 'nowhere' } : { view: 'workflow', name }
  }
  if (parts.length !== 2) return { view: 'nowhere' }
  if (PLAIN.includes(first)) return { view: first }
  return { view: 'nowhere' }
}

/**
 * The screens that are one segment and carry nothing.
 *
 * Held equal to the server's own document routes by
 * `test/routes-client.test.ts`, in both directions: a path here that the server
 * does not serve is a screen that `404`s on reload, and one the server serves
 * that is not here is a page that loads and then says it knows nothing.
 */
const PLAIN = [
  'queue',
  'inbox',
  'runs',
  'workflows',
  'talk',
  'checks',
  'reviews',
  'spend',
  'findings',
  'notes',
  'devices',
  'more',
  'pair',
]

/** The path for a screen, which is what goes in an `href` and in the history. */
export function pathOf(where) {
  switch (where.view) {
    case 'now':
      return '/'
    case 'project':
      return `/p/${encodeURIComponent(where.project)}`
    case 'task':
      return `/t/${encodeURIComponent(where.project)}/${encodeURIComponent(where.task)}`
    case 'request':
      return `/i/${encodeURIComponent(where.source)}/${encodeURIComponent(where.id)}`
    case 'run':
      return `/r/${encodeURIComponent(where.run)}`
    case 'workflow':
      return `/w/${encodeURIComponent(where.name)}`
    default:
      return `/${where.view}`
  }
}

/** The path of one task's own screen, from the `<project>/<task>` id. */
export function taskPath(id) {
  const cut = id.indexOf('/')
  if (cut < 0) return '/'
  return pathOf({ view: 'task', project: id.slice(0, cut), task: id.slice(cut + 1) })
}

/**
 * What the heading and the document title say.
 *
 * The title is announced by a screen reader on navigation, so it is the one
 * place the view's name has to be a sentence rather than a tab label.
 */
export const TITLES = {
  now: 'Now',
  project: 'Project',
  task: 'Task',
  queue: 'Queue',
  inbox: 'Handed over',
  request: 'Request',
  runs: 'Runs',
  run: 'Run',
  workflows: 'Workflows',
  workflow: 'Workflow',
  checks: 'Checks',
  reviews: 'Reviews',
  spend: 'Spend',
  findings: 'Findings',
  notes: 'Notes',
  talk: 'With Tade',
  devices: 'Devices',
  more: 'More',
  pair: 'Pair this device',
  nowhere: 'Nothing here',
}

/**
 * The navigation, and it is five things because a thumb has room for five.
 *
 * Four plus More, which is iOS's own convention and the only shape that fits
 * 360px with 44px targets. Reviews, findings, notes and devices are read weekly
 * rather than hourly, so they live under More — and `More` is a screen of its
 * own rather than a menu, because a menu at the bottom of a phone opens under
 * the thumb that pressed it.
 */
export const NAV = [
  { view: 'now', mark: '▣', label: 'Now', counts: 'wantsYou' },
  // **Second, and it displaced Spend**, which is the one judgement in this
  // table. What is in the thumb row is what is read *because something
  // happened*: a request waiting for a yes is somebody else blocked on this
  // machine, and money is a figure that is true whenever you look. Spend and
  // Checks are one tap away under More and keep their counts there.
  { view: 'inbox', mark: '✉', label: 'Inbox', counts: 'intake' },
  { view: 'queue', mark: '⌸', label: 'Queue', counts: 'queue' },
  { view: 'runs', mark: '⑁', label: 'Runs', counts: 'runs' },
]

/** The weekly reads, listed on every screen's rail and under More on a phone. */
export const MORE = [
  // First among the weekly reads, because it is the one that is read *because
  // something happened* rather than on a round: a reply arrived, or Tade is
  // answering somebody. The others are lists that are true whenever you look.
  { view: 'talk', mark: '❯', label: 'With Tade', counts: null },
  { view: 'spend', mark: '$', label: 'Spend', counts: null },
  { view: 'checks', mark: '✓', label: 'Checks', counts: null },
  { view: 'workflows', mark: '⌗', label: 'Workflows', counts: 'workflows' },
  { view: 'reviews', mark: '◴', label: 'Reviews', counts: 'reviews' },
  { view: 'findings', mark: '◈', label: 'Findings', counts: 'findings' },
  { view: 'notes', mark: '✎', label: 'Notes', counts: 'notes' },
  { view: 'devices', mark: '⌸', label: 'Devices', counts: null },
]

/** Which of the navigation's entries a screen lights up. */
export function navFor(where) {
  if (where.view === 'project' || where.view === 'task') return 'now'
  // A screen that is one row of a list lights that list's entry, which is what
  // makes the back arrow and the lit tab agree about where somebody is.
  if (where.view === 'request') return 'inbox'
  if (where.view === 'run') return 'runs'
  if (where.view === 'workflow') return 'workflows'
  return where.view
}

/** The path of one request's own screen, from its `<source>:<externalId>` key. */
export function requestPath(item) {
  const cut = item.indexOf(':')
  if (cut < 0) return '/inbox'
  return pathOf({ view: 'request', source: item.slice(0, cut), id: item.slice(cut + 1) })
}

/**
 * A URL that may go in an `href`, or null.
 *
 * **`https:` and nothing else.** This is the only outbound link in the design —
 * a review on its forge — and the URL comes from the forge through
 * `GitSnapshot`, which makes it the one string on the page that was written by
 * something off this machine. `javascript:` and `data:` are the two that turn a
 * link into script; refusing everything but `https:` answers those and every
 * scheme nobody has thought of yet.
 *
 * Parsed rather than pattern-matched, because `https:/\evil` and
 * `HtTpS://…` are both things a prefix check gets wrong.
 */
export function safeHref(url) {
  if (typeof url !== 'string' || url === '') return null
  let parsed = null
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  return parsed.protocol === 'https:' ? parsed.href : null
}
