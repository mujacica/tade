import { fileURLToPath } from 'node:url'

// The one thing about keys that needs to know where Tade is on the disk: the
// command that prints one. Apart from `secrets.ts`, whose sentences about keys
// are drawn in the window — in a browser too (`@tade/core/pure`).

/**
 * A shell command that prints one credential out of the config, read at the
 * moment it runs: for a program that asks for its key that way — Claude Code's
 * `apiKeyHelper` — so the key is never written into what launches it, where it
 * would sit in the process table for anybody on the machine to read.
 */
export function secretCommand(home: string, path: string): string {
  const script = fileURLToPath(new URL('./print-secret.ts', import.meta.url))
  const word = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`
  return [process.execPath, script, home, path].map(word).join(' ')
}
