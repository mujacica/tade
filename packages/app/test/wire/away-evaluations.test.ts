import { request } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { COOKIE, closeAll, machine, paired } from './away-harness.ts'

// The scorecards, from away: `GET /api/evaluations` over the real listener,
// folded from the journal the workbench wrote and cut to what this device was
// granted — money under `spend`, the judge under `findings`.

afterEach(closeAll)

function get(
  port: number,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((done, failed) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: { host: `127.0.0.1:${port}`, cookie: COOKIE, 'sec-fetch-site': 'same-origin' },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          done({
            status: res.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
          }),
        )
      },
    )
    req.on('error', failed)
    req.end()
  })
}

describe('the scorecards from away', () => {
  it('says the journal is being read, then answers with the work it holds', async () => {
    const one = await machine()
    await one.client.log.append({ type: 'task_created', task: one.task, detail: {} })
    await one.client.log.append({
      type: 'run_started',
      task: one.task,
      run: `${one.task}/agent`,
      detail: { harness: 'claude-code', model: 'claude-opus-5' },
    })
    await paired(one.home, one.port, ['read'], [])
    await one.away.open()

    // The first ask starts the read and is told so, rather than shown noughts.
    const first = await get(one.port, '/api/evaluations')
    expect(first.status).toBe(200)
    expect(first.body.read).toBe(false)

    let answer = first
    for (let tries = 0; tries < 100 && answer.body.read !== true; tries++) {
      await new Promise((done) => setTimeout(done, 20))
      answer = await get(one.port, '/api/evaluations')
    }
    expect(answer.body.read).toBe(true)
    const total = answer.body.total as { tasks: number; cost: unknown }
    expect(total.tasks).toBe(1)
    // Granted nothing but reading: no money, and the judge not granted.
    expect(total.cost).toBeNull()
    expect(answer.body.judge).toBe('not granted')
    const by = answer.body.by as Record<string, { label: string }[]>
    expect(by.harness?.map((row) => row.label)).toEqual(['claude-code'])
  })
})
