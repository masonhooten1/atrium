import { describe, expect, it } from 'vitest'
import { GET } from '../src/app/api/health/route'

describe('GET /api/health', () => {
  it('returns 200 { status: "ok" }', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ status: 'ok' })
  })
})
