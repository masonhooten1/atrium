// The profile archive route: a finished onboarding becomes an Avatar row.
// Runs the real handler against a real (temp) SQLite database — the same
// boot path CI uses — so the sanitization contract is tested through the
// route a client actually calls, not a copy of its logic.
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const tmp = mkdtempSync(path.join(tmpdir(), 'atrium-profile-'))
const dbPath = path.join(tmp, 'profile-test.db')

// Set before any import resolves: getDb() reads this when first called.
process.env.DATABASE_URL = `file:${dbPath}`
execSync('npx prisma migrate deploy', {
  cwd: process.cwd(),
  env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
  stdio: 'pipe',
})

// Route import after the env var: the handler closes over getDb(), which
// resolves lazily on first call, but ordering it this way keeps the test
// honest about what the route sees.
const { POST } = await import('../src/app/api/profile/route')
const { AVATAR_COLORS } = await import('../src/lib/avatar-presets')

function post(body: unknown | string): Promise<Response> {
  return POST(
    new Request('http://localhost/api/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )
}

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('POST /api/profile', () => {
  it('archives a finished onboarding profile as an Avatar row', async () => {
    const res = await post({ name: 'Pilot', color: '#a78bfa', hat: 'crown' })
    expect(res.status).toBe(201)
    const data = (await res.json()) as { avatar: { id: string; name: string; color: string; hat: string } }
    expect(data.avatar.name).toBe('Pilot')
    expect(data.avatar.color).toBe('#a78bfa')
    expect(data.avatar.hat).toBe('crown')
    expect(data.avatar.id).toBeTruthy()
  })

  it('sanitizes hostile values down to the known presets', async () => {
    const res = await post({ name: 'x'.repeat(40), color: 'javascript:alert(1)', hat: 'sombrero' })
    expect(res.status).toBe(201)
    const data = (await res.json()) as { avatar: { name: string; color: string; hat: string } }
    expect(data.avatar.name).toBe('x'.repeat(24))
    expect(data.avatar.color).toBe(AVATAR_COLORS[0])
    expect(data.avatar.hat).toBe('none')
  })

  it('rejects malformed payloads with 400', async () => {
    expect((await post('not json at all')).status).toBe(400)
    expect((await post(42)).status).toBe(400)
  })
})
