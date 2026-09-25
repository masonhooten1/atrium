// The server-side half of onboarding completion: the finished profile is
// archived into the Avatar table. The localStorage record stays the
// visitor's identity — the prototype is single-tenant and unauthenticated,
// so this row is the world's memory that someone got styled here, not an
// account. Values pass through sanitizeProfile: hostile input collapses to
// the known presets, never echoes raw.
import { NextResponse } from 'next/server'
import { sanitizeProfile } from '@/lib/avatar-presets'
import { getDb } from '@/lib/db'

export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 })
  }
  if (typeof body !== 'object' || body === null) {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  }
  const input = body as Record<string, unknown>
  const profile = sanitizeProfile({ name: input.name, color: input.color, hat: input.hat })
  const db = getDb()
  const avatar = await db.avatar.create({
    data: { name: profile.name, color: profile.color, hat: profile.hat },
  })
  return NextResponse.json(
    { avatar: { id: avatar.id, name: avatar.name, color: avatar.color, hat: avatar.hat } },
    { status: 201 },
  )
}
