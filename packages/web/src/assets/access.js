// What this device may read, asked by **what is drawn** rather than by a grant's
// name.
//
// `WITHHOLDS` is `reach.ts`'s table — every place on the wire each grant
// withholds — copied because a browser cannot import a `.ts` file, and held
// equal by `test/withholds.test.ts`. A page asks `mayFor(store, 'plans')` and the
// table says which grant that is, so a page cannot say *not granted* about
// something the machine sent, or draw a dash as *not recorded* where the
// machine withheld it: the projection gates by the same lines.
//
// Nothing here touches the DOM.

export const WITHHOLDS = {
  titles: ['projects.title', 'tasks.title'],
  intent: ['tasks.intent', 'queue.waitsOn.why', 'runs.steps.waits.why', 'evaluations.races.said'],
  notes: ['notes'],
  findings: ['findings', 'evaluations.findings', 'evaluations.races.order'],
  spend: [
    'tasks.spend',
    'plans',
    'intake.would.limits',
    'runs.steps.usd',
    'runs.usd',
    'evaluations.cost',
    'evaluations.races.usd',
  ],
  reviews: ['tasks.review.url'],
  accounts: ['tasks.account', 'plans.account', 'plans.uses'],
  talk: ['chat'],
  requests: ['intake.title', 'intake.who', 'intake.url'],
  material: ['intake.material', 'intake.materialSays', 'intake.materialLabel'],
  workflows: ['workflows'],
  lanes: ['agent.screen'],
  settings: ['settings'],
}

/** The grant a place on the wire is withheld under, or null for what every device reads. */
export function grantOf(path) {
  for (const [grant, paths] of Object.entries(WITHHOLDS)) if (paths.includes(path)) return grant
  return null
}

/**
 * Whether this device was sent what is at that place on the wire.
 *
 * **A path nothing withholds throws**, rather than answering yes: a page asking
 * about a place the table does not know is a page about to disagree with the
 * machine, and a test that renders it should say so the first time.
 */
export function mayFor(store, path) {
  const grant = grantOf(path)
  if (grant === null) throw new Error(`nothing on the wire is withheld at ${path}`)
  return store.you?.reads.includes(grant) ?? false
}
