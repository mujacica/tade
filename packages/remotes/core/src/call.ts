import { request } from 'node:http'
import type { Duplex } from 'node:stream'
import { COOKIE } from '@tade/web'
import { type Answer, LinkError, type Remote } from './port.ts'

// One owner's request to a remote's away view, over a stream an implementation
// opened to its loopback listener (`Transport.connect`): what `carry` and the
// sign-ins ride on. Separate from the live stream (`follow.ts`), because a call
// is made by whoever needs one — the CLI with no window open, the window on a
// press — and must neither need a link held nor disturb the one that is.
//
// **A deadline on all of it**, because the window draws on the thread that
// would wait: connecting, being answered, and the answer read. And **a bound on
// what is read**, as a frame of the stream is bounded: a remote is another
// machine's answer, and how much of it this one keeps is this one's to say.

/** How long one call may take, end to end: a connection, a sign-in, a carry and its answer. */
export const CALL_MS = 60_000

/** The most of an answer that is read. A carry's answer is a few kilobytes. */
const ANSWER_MOST = 4 * 1024 * 1024

/**
 * POST `body` to `path` there as this machine's owner session, over
 * `connect`'s stream — or GET it, where there is no body: a read sends no
 * token, as a page's reads send none.
 */
export function callOver(
  connect: () => Promise<Duplex>,
  remote: Remote,
  path: string,
  body: unknown,
  ms: number = CALL_MS,
): Promise<Answer> {
  const text = body === undefined ? null : JSON.stringify(body)
  const session = remote.session
  return new Promise((done, failed) => {
    let finished = false
    let socket: Duplex | null = null
    const finish = (err: unknown, answer?: Answer) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      socket?.destroy()
      if (answer !== undefined) done(answer)
      else failed(err instanceof LinkError ? err : new LinkError('failed', saidOf(err, remote)))
    }
    const timer = setTimeout(
      () =>
        finish(new LinkError('timed out', `${remote.name} did not answer within ${ms / 1000}s`)),
      ms,
    )
    connect().then(
      (opened) => {
        socket = opened
        if (finished) {
          opened.destroy()
          return
        }
        const req = request(
          {
            createConnection: () => opened as never,
            path,
            method: text === null ? 'GET' : 'POST',
            headers: {
              host: session.host,
              cookie: `${COOKIE}=${session.cookie}`,
              ...(text === null
                ? {}
                : {
                    origin: `http://${session.host}`,
                    'content-type': 'application/json',
                    'content-length': String(Buffer.byteLength(text)),
                    'x-tade-csrf': session.csrf,
                  }),
              // One request, and the stream it came on is done with.
              connection: 'close',
            },
          },
          (res) => {
            const chunks: Buffer[] = []
            let size = 0
            res.on('data', (chunk: Buffer) => {
              size += chunk.length
              if (size > ANSWER_MOST) {
                finish(
                  new LinkError('failed', `${remote.name} answered past every bound an answer has`),
                )
                return
              }
              chunks.push(chunk)
            })
            res.on('end', () => {
              const raw = Buffer.concat(chunks).toString('utf8')
              let read: unknown = null
              try {
                read = raw === '' ? null : JSON.parse(raw)
              } catch (problem) {
                // Not JSON is an answer all the same: its status says what it
                // was, and this says that its body could not be read.
                read = { unreadable: problem instanceof Error ? problem.message : String(problem) }
              }
              finish(null, { status: res.statusCode ?? 0, body: read })
            })
            res.on('error', (err) => finish(err))
          },
        )
        req.on('error', (err) => finish(err))
        if (text === null) req.end()
        else req.end(text)
      },
      (err: unknown) => finish(err),
    )
  })
}

/** A call that failed below HTTP, in words: what did not answer. */
function saidOf(err: unknown, remote: Remote): string {
  const message = err instanceof Error ? err.message : String(err)
  if (/hang up|ECONNRESET|EPIPE|ECONNREFUSED|ENOENT/.test(message)) {
    return `nothing answers on ${remote.session.host} there: its Tade is not open, or its away view is off`
  }
  return `the call could not be made: ${message}`
}
