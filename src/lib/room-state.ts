// Pure room occupancy state. The server is the only writer: seats are handed
// out here and never trusted from the client. `now` is always injected so
// tests can freeze time around bookings.
import { findRoomDef, ROOMS, type RoomDef } from './rooms'

export interface RoomBooking {
  title: string
  startsAt: number
  endsAt: number
}

export interface RoomState {
  def: RoomDef
  // peer id -> seat index; seats 0..capacity-1 are handed out lowest-free-first.
  occupants: Map<string, number>
  booking: RoomBooking | null
}

export interface RoomBook {
  rooms: Map<string, RoomState>
}

export function newRoomBook(defs: RoomDef[] = ROOMS): RoomBook {
  const rooms = new Map<string, RoomState>()
  for (const def of defs) {
    if (!def.dynamic) rooms.set(def.id, { def, occupants: new Map(), booking: null })
  }
  return { rooms }
}

// 'closed' covers unknown rooms and the stage stub — the client disables
// those doors, so reaching this reason means a lying or stale client.
export type RoomJoinResult =
  | { ok: true; seat: number }
  | { ok: false; reason: 'full' | 'reserved' | 'closed' }

function lowestFreeSeat(occupants: Map<string, number>, capacity: number): number {
  const taken = new Set(occupants.values())
  for (let seat = 0; seat < capacity; seat++) {
    if (!taken.has(seat)) return seat
  }
  return -1 // unreachable: callers check size < capacity first
}

// Server-side join arbitration: unknown/stub rooms are closed, an upcoming
// booking holds the room (reserved), and capacity is never exceeded (full).
// Joins inside an active booking window are accepted — the meeting has
// started whether or not the booker arrived yet.
export function joinRoom(book: RoomBook, roomId: string, peerId: string, now: number): RoomJoinResult {
  const state = book.rooms.get(roomId)
  const def = state?.def ?? findRoomDef(ROOMS, roomId)
  if (!def || !def.joinable) return { ok: false, reason: 'closed' }
  if (!state) {
    if (!def.dynamic) return { ok: false, reason: 'closed' }
    book.rooms.set(roomId, { def, occupants: new Map(), booking: null })
    return joinRoom(book, roomId, peerId, now)
  }

  const existing = state.occupants.get(peerId)
  if (existing !== undefined) return { ok: true, seat: existing }
  if (state.booking && now < state.booking.startsAt) return { ok: false, reason: 'reserved' }
  if (state.occupants.size >= def.capacity) return { ok: false, reason: 'full' }

  const seat = lowestFreeSeat(state.occupants, def.capacity)
  if (seat < 0) return { ok: false, reason: 'full' }
  state.occupants.set(peerId, seat)
  return { ok: true, seat }
}

// Free a seat. Dynamic rooms dissolve when they empty. Returns whether the
// peer was actually a member — double-leaves are no-ops.
export function leaveRoom(book: RoomBook, roomId: string, peerId: string): boolean {
  const state = book.rooms.get(roomId)
  if (!state || !state.occupants.has(peerId)) return false
  state.occupants.delete(peerId)
  if (state.def.dynamic && state.occupants.size === 0) book.rooms.delete(roomId)
  return true
}

// Disconnect cleanup: every seat the socket held, across every room.
export function leaveAllRooms(book: RoomBook, peerId: string): string[] {
  const left: string[] = []
  for (const roomId of [...book.rooms.keys()]) {
    if (leaveRoom(book, roomId, peerId)) left.push(roomId)
  }
  return left
}

// Register a spawned pod (the grab gesture's accept): the book is the only
// registry, and the def carries isSpawned so summaries can render it on the
// street. The def's dynamic flag drives the dissolve-when-empty lifecycle.
export function spawnRoom(book: RoomBook, def: RoomDef): RoomState {
  const state: RoomState = { def, occupants: new Map(), booking: null }
  book.rooms.set(def.id, state)
  return state
}

// Is the peer currently holding a seat anywhere? The grab gesture never pulls
// someone out of (or into) a meeting they are already in.
export function occupiesAnyRoom(book: RoomBook, peerId: string): boolean {
  for (const state of book.rooms.values()) {
    if (state.occupants.has(peerId)) return true
  }
  return false
}

// The one room (if any) both sockets currently share — the WebRTC relay only
// forwards signaling between sockets that sit in the same room.
export function sharedRoom(book: RoomBook, a: string, b: string): string | null {
  for (const [roomId, state] of book.rooms) {
    if (state.occupants.has(a) && state.occupants.has(b)) return roomId
  }
  return null
}

// Expired bookings stop holding rooms — called on summary reads so the door
// returns to open without a separate sweeper process.
export function sweepBookings(book: RoomBook, now: number): void {
  for (const state of book.rooms.values()) {
    if (state.booking && now >= state.booking.endsAt) state.booking = null
  }
}

// --- Door views -------------------------------------------------------------

export type DoorStatus = 'open' | 'full' | 'reserved' | 'stub'

export interface DoorView {
  status: DoorStatus
  occupancy: number
  // Booking in force (upcoming or live) for the door's second line.
  booking: { title: string; startsAt: number; live: boolean } | null
}

// Precedence: stub > reserved (upcoming booking holds the room) > full > open.
export function doorView(state: RoomState | null, def: RoomDef, now: number): DoorView {
  if (!def.joinable) return { status: 'stub', occupancy: 0, booking: null }
  const occupancy = state ? state.occupants.size : 0
  const booking = state?.booking ?? null
  if (booking && now < booking.endsAt) {
    const info = { title: booking.title, startsAt: booking.startsAt, live: now >= booking.startsAt }
    if (now < booking.startsAt) return { status: 'reserved', occupancy, booking: info }
    if (occupancy >= def.capacity) return { status: 'full', occupancy, booking: info }
    return { status: 'open', occupancy, booking: info }
  }
  return { status: occupancy >= def.capacity ? 'full' : 'open', occupancy, booking: null }
}

// Full door-state snapshot for the room:summary broadcast. Static rooms always
// appear; huddle zones appear with zero occupancy until their pod spawns.
export function roomSummaries(book: RoomBook, now: number): RoomSummaryData[] {
  const out: RoomSummaryData[] = []
  for (const def of ROOMS) {
    const state = book.rooms.get(def.id) ?? null
    const view = doorView(state, def, now)
    out.push({
      id: def.id,
      kind: def.kind,
      name: def.name,
      capacity: def.capacity,
      occupancy: view.occupancy,
      status: view.status,
      joinable: def.joinable,
      dynamic: def.dynamic,
      booking: view.booking,
    })
  }
  return out
}

// Mirrors the wire shape in protocol.ts without importing the socket contract
// (rooms stay a dependency-free logic core).
export interface RoomSummaryData {
  id: string
  kind: RoomDef['kind']
  name: string
  capacity: number
  occupancy: number
  status: DoorStatus
  joinable: boolean
  dynamic: boolean
  booking: { title: string; startsAt: number; live: boolean } | null
}
