import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { forgetOldPictures } from '@tade/core'
import type { WorkerImage } from './port.ts'

/**
 * Pictures as files the agent is told about, for a harness that cannot be
 * handed one and reads a picture it is pointed at: each written into
 * `<dir>/attachments` and named on a line of its own after the message.
 *
 * A picture's name is its own, never the time it was written: named by the
 * millisecond, two prompts in the same one — two agents told at once, or the
 * opening and a message straight after — wrote the same path, and the second
 * picture stood in for the first under both. Written `wx`, so a name that was
 * somehow there already is a throw rather than a picture replaced.
 *
 * Kept a week rather than for good: nothing says when its reader is done, so
 * what is older goes as the next is written (`forgetOldPictures`), by when it
 * was written and never by its name.
 */
export function promptWithImages(
  message: string,
  images: readonly WorkerImage[] | undefined,
  dir: string,
): string {
  if (!images || images.length === 0) return message
  const folder = join(dir, 'attachments')
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  forgetOldPictures(folder, Date.now())
  const paths = images.map((image) => {
    const path = join(folder, `${randomUUID()}.${extensionOf(image.mimeType)}`)
    writeFileSync(path, Buffer.from(image.data, 'base64'), { mode: 0o600, flag: 'wx' })
    return path
  })
  return `${message}\n\n${paths.map((path) => `[picture: ${path}]`).join('\n')}`
}

/**
 * `png` for `image/png`, `jpg` for `image/jpeg`: a word and nothing else, so
 * a type that is not one — `image/../../x` — is never part of a path, and is
 * `png`.
 */
function extensionOf(mimeType: string): string {
  const said = mimeType.split('/')[1]?.replace('jpeg', 'jpg') ?? ''
  return /^[a-z0-9]{1,8}$/.test(said) ? said : 'png'
}
