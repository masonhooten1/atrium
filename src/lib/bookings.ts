// Pure booking logic. Overlap rejection and next-booking selection live here
// so they are unit-testable without a database; the API route applies them
// against real rows. `now` is always injected, mirroring room-state
// discipline, so tests can freeze time around booking windows.

export interface BookingWindow {
  title: string
  startsAt: number
  endsAt: number
}

export interface BookingInput extends BookingWindow {
  roomId: string
  booker: string
}

export const MAX_TITLE_LENGTH = 120
export const MAX_BOOKER_LENGTH = 60
// A meeting room is not a venue: bookings beyond this are shape errors.
export const MAX_BOOKING_MS = 12 * 60 * 60 * 1000
// Clocks drift; a start up to a minute in the past is still accepted.
export const START_SKEW_MS = 60_000

// Half-open windows [startsAt, endsAt): a booking ending at 10:00 does not
// conflict with one starting at 10:00 — the room turns over exactly then.
export function overlaps(a: BookingWindow, b: BookingWindow): boolean {
  return a.startsAt < b.endsAt && b.startsAt < a.endsAt
}

export type BookingValidation =
  | { ok: true }
  | { ok: false; reason: 'shape' | 'window' | 'overlap'; conflict: BookingWindow | null }

// Validate a new booking against the room's in-force bookings. 'shape' means
// the payload itself is malformed; 'window' means the times do not describe
// a bookable meeting; 'overlap' means the room is already taken.
export function validateBooking(input: BookingInput, existing: BookingWindow[], now: number): BookingValidation {
  if (
    typeof input.title !== 'string' ||
    input.title.trim().length === 0 ||
    input.title.trim().length > MAX_TITLE_LENGTH
  ) {
    return { ok: false, reason: 'shape', conflict: null }
  }
  if (typeof input.booker !== 'string' || input.booker.trim().length === 0 || input.booker.trim().length > MAX_BOOKER_LENGTH) {
    return { ok: false, reason: 'shape', conflict: null }
  }
  for (const t of [input.startsAt, input.endsAt]) {
    if (typeof t !== 'number' || !Number.isFinite(t)) return { ok: false, reason: 'shape', conflict: null }
  }
  if (input.endsAt <= input.startsAt) return { ok: false, reason: 'window', conflict: null }
  if (input.endsAt - input.startsAt > MAX_BOOKING_MS) return { ok: false, reason: 'window', conflict: null }
  if (input.startsAt < now - START_SKEW_MS) return { ok: false, reason: 'window', conflict: null }
  const conflict = existing.find((b) => overlaps(b, input))
  if (conflict) return { ok: false, reason: 'overlap', conflict }
  return { ok: true }
}

// The booking a door should announce: a live meeting outranks the future,
// otherwise the earliest upcoming one. Expired bookings never appear.
export function nextBookingFrom(bookings: BookingWindow[], now: number): (BookingWindow & { live: boolean }) | null {
  const inForce = bookings
    .filter((b) => b.endsAt > now)
    .sort((a, b) => a.startsAt - b.startsAt)
  const live = inForce.find((b) => b.startsAt <= now)
  if (live) return { ...live, live: true }
  const upcoming = inForce[0]
  return upcoming ? { ...upcoming, live: false } : null
}
