// Server-only process-wide runtime. The socket layer in server.ts and Next's
// compiled API routes share one process but not one module graph, so the room
// book and the socket server hang off globalThis — the same singleton pattern
// db.ts uses for the Prisma client. Nothing here is a second authority: the
// book is the same pure room-state structure server.ts has always driven.
import type { Server as SocketServer } from 'socket.io'
import { newRoomBook, roomSummaries, sweepBookings, type RoomBook } from '../room-state'
import type { ClientToServerEvents, ServerToClientEvents } from '../protocol'

type AtriumSocketServer = SocketServer<ClientToServerEvents, ServerToClientEvents>

interface AtriumRuntime {
  book: RoomBook
  io: AtriumSocketServer | null
}

const globalForRuntime = globalThis as typeof globalThis & {
  __atriumRuntime?: AtriumRuntime
}

function getRuntime(): AtriumRuntime {
  globalForRuntime.__atriumRuntime ??= { book: newRoomBook(), io: null }
  return globalForRuntime.__atriumRuntime
}

export function getRoomBook(): RoomBook {
  return getRuntime().book
}

// Called once at boot by server.ts, after the socket server exists.
export function bindIo(io: AtriumSocketServer): void {
  getRuntime().io = io
}

// Door state goes to everyone: any join, leave, disconnect or booking change
// can flip a door between open, full and reserved.
export function broadcastSummaries(): void {
  const runtime = getRuntime()
  if (!runtime.io) return
  const now = Date.now()
  sweepBookings(runtime.book, now)
  runtime.io.emit('room:summary', { rooms: roomSummaries(runtime.book, now) })
}
