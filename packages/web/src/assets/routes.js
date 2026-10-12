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
  'agents',
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
  'settings',
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
  now: 'Overview',
  project: 'Project',
  task: 'Task',
  agents: 'Agents',
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
  talk: 'Tade',
  devices: 'Devices',
  settings: 'Settings',
  more: 'More',
  pair: 'Pair this device',
  nowhere: 'Nothing here',
  // **Two views that are not places.** `nowhere` is a path this router does
  // not know and `lastSeen` is a cold open with nothing answering — neither
  // has a path of its own, neither can be linked to, and `pathOf` is never
  // called for either. They are here because a `<title>` is owed for every
  // screen somebody can be looking at, and `test/routes-client.test.ts` names
  // them as the two it does not expect the server to serve.
  lastSeen: 'Last seen',
}

/**
 * The navigation, and it is five things because a thumb has room for five.
 *
 * Three places, Tade in the middle and More — iOS's own convention with the
 * primary action at the centre, which is the only shape that fits 360px with
 * 44px targets. **Ask is not in this table**: it is not a place but the command
 * bar (`palette.js`), so `shell.js` puts a button between the second and third
 * entries rather than a link.
 *
 * What is in the thumb row is what is read *because something is happening*:
 * the overview (what wants you, across every project), the agents at work, and
 * the queue that starts them. Everything read on a round lives under More,
 * with its count — the inbox first, whose count is somebody else blocked on
 * this machine and is also what the More tab itself carries.
 *
 * `icon` is the drawing (`icons.js`), `mark` the glyph the window uses for the
 * same place, kept for the one place a glyph is drawn in text — the key sheet.
 */
export const NAV = [
  { view: 'now', icon: 'overview', mark: '▣', label: 'Overview', counts: 'wantsYou' },
  { view: 'agents', icon: 'agents', mark: '◉', label: 'Agents', counts: 'agents' },
  { view: 'queue', icon: 'queue', mark: '⌸', label: 'Queue', counts: 'queue' },
]

/** The tab that opens everything else, carrying the one count worth a thumb from there. */
export const MORE_TAB = { view: 'more', icon: 'more', mark: '⋯', label: 'More', counts: 'intake' }

/** The weekly reads, listed on every screen's rail and under More on a phone. */
export const MORE = [
  // **First under More, and its count is on the More tab itself**: a request
  // waiting for a yes is somebody else blocked on this machine.
  { view: 'inbox', icon: 'inbox', mark: '✉', label: 'Inbox', counts: 'intake' },
  // Under the Tade category, so its own word is what it is: the conversation.
  { view: 'talk', icon: 'talk', mark: '❯', label: 'Conversation', counts: null },
  { view: 'runs', icon: 'runs', mark: '⑁', label: 'Runs', counts: 'runs' },
  { view: 'spend', icon: 'spend', mark: '$', label: 'Spend', counts: null },
  { view: 'checks', icon: 'checks', mark: '✓', label: 'Checks', counts: null },
  { view: 'reviews', icon: 'reviews', mark: '◴', label: 'Reviews', counts: 'reviews' },
  { view: 'findings', icon: 'findings', mark: '◈', label: 'Findings', counts: 'findings' },
  { view: 'workflows', icon: 'workflows', mark: '⌗', label: 'Workflows', counts: 'workflows' },
  { view: 'notes', icon: 'notes', mark: '✎', label: 'Notes', counts: 'notes' },
  { view: 'devices', icon: 'devices', mark: '⌸', label: 'Devices', counts: null },
  // What Tade is set up with, behind a grant of its own — and the few settings
  // a device granted it may change. Last, because it is read least.
  { view: 'settings', icon: 'settings', mark: '⚙', label: 'Settings', counts: null },
]

/**
 * The sidebar, in categories: the four places read because something is
 * happening, then the projects themselves (filled from the store, each one
 * opening onto its work), then the rest by what they are about. The phone's
 * More screen is the same groups, so a place is in one category everywhere.
 *
 * Every place in `NAV` and `MORE` is in exactly one group
 * (`test/routes-client.test.ts`), and `projects` names none: it is data.
 */
export const GROUPS = [
  { key: 'main', title: '', views: ['now', 'agents', 'queue', 'inbox'] },
  { key: 'projects', title: 'Projects', views: [] },
  { key: 'work', title: 'Work', views: ['runs', 'reviews', 'findings', 'workflows'] },
  { key: 'insight', title: 'Insight', views: ['spend', 'checks'] },
  { key: 'tade', title: 'Tade', views: ['talk', 'notes'] },
  { key: 'system', title: 'System', views: ['devices', 'settings'] },
]

/** One place's entry, out of either list, by its view. */
export function placeOf(view) {
  return [...NAV, ...MORE].find((one) => one.view === view) ?? null
}

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
