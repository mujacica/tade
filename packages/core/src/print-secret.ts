import { Secrets } from './secrets.ts'

// Print one secret Tade keeps, for a program that asks for its key by running
// a command — Claude Code's `apiKeyHelper`. The key is read at the moment it
// is asked for, from wherever Tade keeps it, so it is never written into a
// lane's launch line or anybody's settings.
//
//   node print-secret.ts <tade home> <name>
//
// Prints nothing, and exits 1, when there is no such secret: the program that
// asked says it could not authenticate, which is the truth.

const [home, name] = process.argv.slice(2)
const value = home && name ? Secrets.open({ home }).get(name) : null
if (value) process.stdout.write(value)
process.exit(value ? 0 : 1)
