// Server-side persistence layer: the only module that talks to Prisma.
// Functions take the client as a parameter so tests can point them at any
// database; callers all share the getDb() singleton.
import type { PrismaClient } from '@prisma/client'
import { ROOMS } from '../rooms'
import { sanitizeStroke, type StrokeData } from '../whiteboard'

// History bound: at most the most recent strokes come back per room join.
// Enough canvas for any meeting; a hard stop for the table.
const MAX_HISTORY_STROKES = 500

// Every static room def gets a row so strokes and bookings can reference it
// (SQLite enforces the foreign keys). Idempotent; runs at server boot.
export async function ensureRoomRows(db: PrismaClient): Promise<void> {
  for (const def of ROOMS) {
    await db.room.upsert({
      where: { id: def.id },
      update: { name: def.name, kind: def.kind, capacity: def.capacity },
      create: { id: def.id, name: def.name, kind: def.kind, capacity: def.capacity },
    })
  }
}

// Persisted strokes for a room, oldest first, deduped by stroke id (last
// version wins — a final stroke re-emitted across a reconnect would
// otherwise double-render). Unparseable rows are logged and skipped: one bad
// row must not blank the room's board.
export async function listStrokes(db: PrismaClient, roomId: string): Promise<StrokeData[]> {
  const rows = await db.whiteboardStroke.findMany({
    where: { roomId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: MAX_HISTORY_STROKES,
  })
  const byId = new Map<string, StrokeData>()
  for (const row of rows) {
    try {
      const parsed: unknown = JSON.parse(row.data)
      const stroke = sanitizeStroke(parsed)
      if (stroke) byId.set(stroke.id, stroke)
      else console.error(`whiteboard row ${row.id} failed validation — skipped`)
    } catch (err) {
      console.error(`whiteboard row ${row.id} is not valid JSON — skipped`, err)
    }
  }
  return [...byId.values()]
}

// One final stroke, one row. Called only for `final` strokes; in-flight
// updates live on the wire, never in the table.
export async function appendStroke(db: PrismaClient, roomId: string, stroke: StrokeData): Promise<void> {
  await db.whiteboardStroke.create({ data: { roomId, data: JSON.stringify(stroke) } })
}
