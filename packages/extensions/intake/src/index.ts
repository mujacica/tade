// The package's public surface. `slack-message.ts` is deliberately not here:
// it is the pure half of the Slack door, its names are the ordinary ones a
// second source would want too (`candidateOf`, `revisionOf`, `isRequest`), and
// a barrel is where two of those collide. Its own tests import it by path.
export * from './extension.ts'
export * from './github.ts'
export * from './slack.ts'
export * from './slack-api.ts'
export * from './spool.ts'
