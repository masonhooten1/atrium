// The booking API: list and create reservations for the boardroom. The
// server is authoritative — overlap rejection happens against real rows
// before an insert, never in client code — and every accepted booking is
// adopted into the process-wide room book so doors react immediately.
import { NextResponse, type NextRequest } from 'next/server'
import { validateBooking, type BookingWindow } from '@/lib/bookings'
import { getDb } from '@/lib/db'
import { findRoomDef, ROOMS } from '@/lib/rooms'
import { applyBooking } from '@/lib/room-state'
import { broadcastSummaries, getRoomBook } from '@/lib/server/runtime'
import { hydrateBookingsInto } from '@/lib/server/store'

interface BookingRow {
  id: string
  roomId: string
  title: string
  booker: string
  startsAt: string
  endsAt: string
}

function toRow(b: {
  id: string
  roomId: string
  title: string
  booker: string
  startsAt: Date
  endsAt: Date
}): BookingRow {
  return {
    id: b.id,
    roomId: b.roomId,
    title: b.title,
    booker: b.booker,
    startsAt: b.startsAt.toISOString(),
    endsAt: b.endsAt.toISOString(),
  }
}

// GET /api/bookings?roomId=<id> — the room's bookings, earliest first.
export async function GET(request: NextRequest) {
  const roomId = request.nextUrl.searchParams.get('roomId')
  if (!roomId) {
    return NextResponse.json({ error: 'roomId required' }, { status: 400 })
  }
  const db = getDb()
  const rows = await db.booking.findMany({
    where: { roomId },
    orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
  })
  return NextResponse.json({ bookings: rows.map(toRow) })
}

// POST /api/bookings — create a booking. Rejections are specific: 404 for a
// room that cannot be booked, 400 for malformed payloads or impossible
// windows, 409 with the conflicting booking when the room is taken.
export async function POST(request: NextRequest) {
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
  const roomId = typeof input.roomId === 'string' ? input.roomId : ''
  const def = findRoomDef(ROOMS, roomId)
  // The concept books one room — the boardroom. Pods and huddle zones are
  // first-come; the amphitheater is a layout stub.
  if (!def || def.kind !== 'boardroom') {
    return NextResponse.json({ error: 'room not bookable' }, { status: 404 })
  }

  const startsAt = typeof input.startsAt === 'number' ? input.startsAt : Number(input.startsAt)
  const endsAt = typeof input.endsAt === 'number' ? input.endsAt : Number(input.endsAt)
  const now = Date.now()
  const db = getDb()

  // Only in-force bookings can conflict; expired ones are history.
  const existing: BookingWindow[] = (
    await db.booking.findMany({
      where: { roomId, endsAt: { gt: new Date(now) } },
      orderBy: [{ startsAt: 'asc' }],
    })
  ).map((b) => ({ title: b.title, startsAt: b.startsAt.getTime(), endsAt: b.endsAt.getTime() }))

  const verdict = validateBooking(
    {
      roomId,
      title: typeof input.title === 'string' ? input.title : '',
      booker: typeof input.booker === 'string' ? input.booker : '',
      startsAt,
      endsAt,
    },
    existing,
    now,
  )
  if (!verdict.ok) {
    const status = verdict.reason === 'overlap' ? 409 : 400
    return NextResponse.json(
      {
        error: verdict.reason,
        conflict: verdict.conflict
          ? { title: verdict.conflict.title, startsAt: verdict.conflict.startsAt, endsAt: verdict.conflict.endsAt }
          : null,
      },
      { status },
    )
  }

  const created = await db.booking.create({
    data: {
      roomId,
      title: (input.title as string).trim(),
      booker: (input.booker as string).trim(),
      startsAt: new Date(startsAt),
      endsAt: new Date(endsAt),
    },
  })

  // Adopt into the door state when this booking is the one to announce —
  // the live or earliest-starting in-force booking. The fallback rehydrates
  // the whole set, which also repairs a book that missed an earlier boot.
  const book = getRoomBook()
  const adopted = applyBooking(book, roomId, {
    title: created.title,
    startsAt: created.startsAt.getTime(),
    endsAt: created.endsAt.getTime(),
  })
  if (!adopted) await hydrateBookingsInto(book, db, now)
  broadcastSummaries()

  return NextResponse.json({ booking: toRow(created) }, { status: 201 })
}
