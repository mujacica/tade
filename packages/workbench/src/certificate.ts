import { connect } from 'node:tls'
import type { CertificateLook, CertificateSeen } from '@tade/core'

// A look at the certificate a public name answers with: one TLS handshake, the
// way a phone would make it, and nothing sent after it.
//
// **What a phone gets, not what Caddy has on disk.** The name is resolved and
// dialled like anybody's, so a record pointing elsewhere, a port nobody
// answers on and a certificate for another name are all what this says. It
// reads the certificate whether or not it verifies — a certificate that does
// not is the thing worth saying — and says *why* in TLS's own words.
//
// **Asking the world is not free** (`set-up-the-machine`): this is called by
// the window on a clock of its own, only where the window was handed it
// (`AppOptions.certificate`, which a test's never is), and by `tade host caddy
// --check`. It never throws: a look that could not be made is an answer.

/** How long a handshake may take before the look says it could not be made. */
export const LOOK_MS = 10_000

export interface LookOptions {
  /** Where to connect, if not the name itself: a test's own server. */
  host?: string
  port?: number
  ms?: number
  now?: () => number
}

export function lookAtCertificate(name: string, opts: LookOptions = {}): Promise<CertificateLook> {
  const now = opts.now ?? Date.now
  return new Promise((done) => {
    let settled = false
    const answer = (look: { seen: CertificateSeen } | { cannot: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      done({ at: now(), ...look })
    }
    const socket = connect({
      host: opts.host ?? name,
      port: opts.port ?? 443,
      servername: name,
      // Read whatever it is: one that does not verify is the answer to give,
      // and `authorized` says so. Nothing is ever sent on this connection —
      // it is closed the moment the certificate is read — so not refusing it
      // here trusts it with nothing.
      rejectUnauthorized: false,
      ALPNProtocols: ['http/1.1'],
    })
    const timer = setTimeout(
      () => answer({ cannot: `no answer in ${(opts.ms ?? LOOK_MS) / 1000} s` }),
      opts.ms ?? LOOK_MS,
    )
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate()
      const validFrom = Date.parse(cert.valid_from ?? '')
      const validTo = Date.parse(cert.valid_to ?? '')
      if (!Number.isFinite(validFrom) || !Number.isFinite(validTo)) {
        answer({ cannot: 'it answered with no certificate this could read' })
        return
      }
      const error = socket.authorizationError
      answer({
        seen: {
          validFrom,
          validTo,
          issuer:
            [cert.issuer?.O, cert.issuer?.CN].flat().find(Boolean) ?? 'an issuer with no name',
          authorized: socket.authorized,
          error: error === null || error === undefined ? null : String(error),
        },
      })
    })
    socket.once('error', (error: NodeJS.ErrnoException) => {
      answer({ cannot: error.code ?? error.message })
    })
  })
}
