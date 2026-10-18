import { loggedInProviders } from './models.ts'

// Whether pi is signed in to anything, as the user this runs as.
//
// Run by setup through `sudo` as the user pi's agents run as
// (`PiAdapter.signInProof`), whose sign-in is in a home Tade cannot open:
// the same reading `account` makes, answered by the exit code alone — 0
// signed in to some provider, 1 to none — and never a provider's name or
// anything of the sign-in itself, which stays that user's.

process.exitCode = (await loggedInProviders()).length > 0 ? 0 : 1
