import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// How long a Claude Code sign-in has left.
//
// A full `claude auth login` does not last for ever, and an agent that outlives
// it on a machine nobody is watching "stops making progress" — so a server's
// setup has to say how many days are left, and say it before Claude Code's own
// warning, which only somebody looking at that terminal would see.

/**
 * When this account's sign-in runs out, as Claude Code wrote it down, and null
 * where it wrote nothing down that can be read.
 *
 * The later of the refresh token's end and the access token's: Claude Code
 * renews the access token by itself every few hours for as long as the refresh
 * token lasts, and a long-lived access token outlasts both — which is the same
 * reading Claude Code makes when it warns, three days ahead, that "Your login
 * expires". Only on a machine where the sign-in is a file: on a Mac it is in
 * the Keychain, and opening that is not Tade's to do. The two dates are all
 * that is read; the tokens beside them are never kept, used or passed on.
 */
export async function signedInUntil(
  configDir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<number | null> {
  if (platform === 'darwin') return null
  let text: string
  try {
    text = await readFile(join(configDir, '.credentials.json'), 'utf8')
  } catch (err) {
    // No file is no sign-in kept in one — an API key, or none yet — and that
    // is an answer. One that is there and cannot be read is not, so it is the
    // caller's to say.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  let said: unknown
  try {
    said = JSON.parse(text)
  } catch (err) {
    // Half a file — Claude Code writing it as this read it — has no dates in it.
    if (err instanceof SyntaxError) return null
    throw err
  }
  const oauth = (said as { claudeAiOauth?: Record<string, unknown> } | null)?.claudeAiOauth
  const dates = [oauth?.refreshTokenExpiresAt, oauth?.expiresAt].filter(
    (one): one is number => typeof one === 'number' && Number.isFinite(one),
  )
  return dates.length > 0 ? Math.max(...dates) : null
}
