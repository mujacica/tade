import { connect } from 'node:net'

// How a test reaches the `ToolHost`: the framing Tade's own tools use, and
// nothing else.
//
// Shared by the two files about the host — what its methods do, and what a
// turn from away may reach through them — because a second copy of the framing
// is a second thing to keep in step with `tools-extension.ts`'s `rpc`.

/** One call over the socket, framed the way the orchestrator's tools frame it. */
export function call(
  path: string,
  method: string,
  params: Record<string, unknown>,
): Promise<{ result?: unknown; error?: { message: string } }> {
  return new Promise((resolve, reject) => {
    const socket = connect(path)
    let buffer = Buffer.alloc(0)
    socket.on('error', reject)
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      const split = buffer.indexOf('\r\n\r\n')
      if (split < 0) return
      const header = buffer.subarray(0, split).toString('utf8')
      const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1] ?? 0)
      if (buffer.byteLength < split + 4 + length) return
      socket.end()
      resolve(JSON.parse(buffer.subarray(split + 4, split + 4 + length).toString('utf8')))
    })
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), 'utf8')
    socket.write(`Content-Length: ${body.byteLength}\r\n\r\n`)
    socket.write(body)
  })
}
