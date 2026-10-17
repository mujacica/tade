// What a remote link is: the port, the rules a held value moves by, and the
// follower every implementation may build on. The suite every implementation
// must pass is a subpath (`@tade/remotes-core/conformance`), and so is the far
// end it links to (`@tade/remotes-core/far`), so that importing the port does
// not drag a test runner, or a listener, into production code.

// The carry is the away protocol's too: what an owner sends a remote of its
// setup and what comes back, named once in `@tade/web` and handed on here so
// that whatever holds a link reads them from the link's own package.
export type {
  CarriedFileOut,
  CarriedSetting,
  CarryAnswer,
  CarryBody,
  SignInHere,
} from '@tade/web'
export * from './call.ts'
export * from './follow.ts'
export * from './frames.ts'
export * from './held.ts'
export * from './links.ts'
export * from './pages.ts'
export * from './port.ts'
