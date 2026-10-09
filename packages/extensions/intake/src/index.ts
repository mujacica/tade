// The package's public surface. `slack-message.ts` and `linear-issue.ts` are
// deliberately not here: each is the pure half of a door, and their names are
// the ordinary ones every source wants — `candidateOf`, `revisionOf`,
// `requesterOf` — so a barrel is exactly where they would collide. Two sources
// proved it rather than one predicting it. Their own tests import them by path.
export * from './extension.ts'
export * from './github.ts'
export * from './linear.ts'
export * from './linear-api.ts'
export * from './slack.ts'
export * from './slack-api.ts'
export * from './spool.ts'
