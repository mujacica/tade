import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { KeptVersion } from '@tade/judges-core'

// The version that last answered, kept past a restart.
//
// Jev asks TypeSafe which versions there are once per run, and an ask naming
// none is refused whatever is in it. Where that list cannot be read it falls
// back to the last version that answered — which used to live only in memory,
// so the first look after every restart had nothing to fall back to, and the
// review watch could not look at all until the list answered again.
//
// It is in Tade's home, never in a project, keyed by a name the judge chooses
// (a hash, never the key). It is a fallback, not a record: delete it and the
// next look lists the versions as it always does. `reviews.jsonl` keeps which
// version answered every reading; this keeps only the one to ask with.

const FILE = 'version.json'

/** Each write's own name beside the file, so two at once never share one. */
let writes = 0

/** Where the version is kept: `<home>/jev/version.json`. */
export function keptPath(home: string): string {
  return join(home, 'jev', FILE)
}

/** A kept file that is there but is not what was written: cut short, or edited by hand. */
class NotKeptWhole extends Error {}

async function readAll(path: string): Promise<Record<string, string>> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    // Never written is nothing kept; anything else is a look that failed.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new NotKeptWhole(`${path} is not what Tade wrote (${String(err)})`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new NotKeptWhole(`${path} is not what Tade wrote (not an object)`)
  }
  return Object.fromEntries(
    Object.entries(parsed).filter((one): one is [string, string] => typeof one[1] === 'string'),
  )
}

/**
 * A `KeptVersion` over one small file in Tade's home. Either call throws where
 * it cannot read or write it, and the judge says that where it matters: in the
 * error that has no version to ask with.
 */
export function keptIn(home: string): KeptVersion {
  const path = keptPath(home)
  return {
    async read(under) {
      return (await readAll(path))[under] ?? null
    },
    async write(under, version) {
      const all = await readAll(path).catch((err: unknown): Record<string, string> => {
        // A file that is not what was written is replaced whole by this one;
        // a file that cannot be read at all is not written over blind.
        if (err instanceof NotKeptWhole) return {}
        throw err
      })
      if (version === null) delete all[under]
      else all[under] = version
      await mkdir(join(home, 'jev'), { recursive: true })
      // Whole or not at all: written beside it, then moved over it.
      const next = `${path}.${process.pid}.${++writes}.tmp`
      await writeFile(next, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 })
      await rename(next, path)
    },
  }
}
