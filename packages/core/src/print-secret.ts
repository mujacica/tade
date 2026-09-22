import { join } from 'node:path'
import { loadConfig } from './config.ts'

// Print one credential out of the config, for a program that asks for its key
// by running a command — Claude Code's `apiKeyHelper`. It is read at the moment
// it is asked for, so it is never written into a lane's launch line or into
// anybody's settings file.
//
//   node print-secret.ts <tade home> <a dotted config path>
//
// Prints nothing, and exits 1, when there is no such value: the program that
// asked says it could not authenticate, which is the truth.

const [home, path] = process.argv.slice(2)
const loaded = home ? await loadConfig(join(home, 'config.yaml')) : null
let at: unknown = loaded?.ok ? loaded.config : null
for (const part of path ? path.split('.') : ['']) {
  at = at && typeof at === 'object' ? (at as Record<string, unknown>)[part] : undefined
}
const value = typeof at === 'string' && at.trim() !== '' ? at.trim() : null
if (value) process.stdout.write(value)
process.exit(value ? 0 : 1)
