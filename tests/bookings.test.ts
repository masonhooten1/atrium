import { describe, expect, it } from 'vitest'
import {
  MAX_BOOKING_MS,
  nextBookingFrom,
  overlaps,
  validateBooking,
  type BookingWindow,
} from '@/lib/bookings'
import { applyBooking, newRoomBook } from '@/lib/room-state'

const NOW = 1_800_000_000_000

function window(startsMin: number, endsMin: number, title = 'Standup'): BookingWindow {
  return { title, startsAt: NOW + startsMin * 60_000, endsAt: NOW + endsMin * 60_000 }
}

describe('overlaps', () => {
  it('detects every true overlap shape', () => {
    expect(overlaps(window(0, 60), window(30, 90))).toBe(true) // straddle
    expect(overlaps(window(30, 90), window(0, 60))).toBe(true) // contained left
    expect(overlaps(window(0, 60), window(10, 20))).toBe(true) // contained right
    expect(overlaps(window(0, 60), window(0, 60))).toBe(true) // identical
  })

  it('treats back-to-back windows as non-overlapping', () => {
    expect(overlaps(window(0, 60), window(60, 120))).toBe(false)
    expect(overlaps(window(60, 120), window(0, 60))).toBe(false)
  })
})

describe('validateBooking', () => {
  const input = (over: Partial<BookingWindow> = {}): BookingWindow => ({ ...window(120, 150), ...over })

  it('accepts a booking into a free window', () => {
    expect(validateBooking({ ...input(), roomId: 'boardroom', booker: 'Mason' }, [], NOW)).toEqual({ ok: true })
  })

  it('rejects an overlapping booking and names the conflict', () => {
    const existing = [window(100, 140, 'Roadmap review')]
    const verdict = validateBooking({ ...input(), roomId: 'boardroom', booker: 'Mason' }, existing, NOW)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.reason).toBe('overlap')
      expect(verdict.conflict?.title).toBe('Roadmap review')
    }
  })

  it('ignores bookings that end exactly when the new one starts', () => {
    const existing = [window(60, 120, 'Earlier')]
    expect(validateBooking({ ...input(), roomId: 'boardroom', booker: 'Mason' }, existing, NOW)).toEqual({ ok: true })
  })

  it('rejects malformed payloads and impossible windows', () => {
    const shape = (over: Record<string, unknown>): BookingWindow => ({ ...input(), ...over }) as BookingWindow
    expect(validateBooking({ ...shape({ title: '  ' }), roomId: 'boardroom', booker: 'Mason' } as never, [], NOW).ok).toBe(false)
    expect(validateBooking({ ...shape({ title: 'x'.repeat(121) }), roomId: 'b', booker: 'Mason' } as never, [], NOW).ok).toBe(false)
    expect(validateBooking({ ...shape({ booker: '' }), roomId: 'b' } as never, [], NOW).ok).toBe(false)
    expect(validateBooking({ ...shape({ endsAt: Number.NaN }), roomId: 'b', booker: 'M' } as never, [], NOW).ok).toBe(false)
    // End before start.
    expect(validateBooking({ ...input({ startsAt: 150, endsAt: 120 }), roomId: 'b', booker: 'M' }, [], NOW).ok).toBe(false)
    // Zero length.
    expect(validateBooking({ ...input({ endsAt: 150 }), roomId: 'b', booker: 'M' }, [], NOW).ok).toBe(false)
    // Beyond the marquee cap.
    expect(validateBooking({ ...input({ endsAt: 120 + MAX_BOOKING_MS / 60_000 + 1 }), roomId: 'b', booker: 'M' }, [], NOW).ok).toBe(false)
    // Starts too far in the past.
    expect(validateBooking({ ...input({ startsAt: -10, endsAt: 30 }), roomId: 'b', booker: 'M' }, [], NOW).ok).toBe(false)
  })
})

describe('nextBookingFrom', () => {
  it('a live meeting outranks an earlier-starting future one', () => {
    const next = nextBookingFrom([window(60, 120, 'Future'), window(-30, 30, 'Live')], NOW)
    expect(next?.title).toBe('Live')
    expect(next?.live).toBe(true)
  })

  it('otherwise the earliest upcoming wins', () => {
    const next = nextBookingFrom([window(120, 180, 'Later'), window(60, 90, 'Sooner')], NOW)
    expect(next?.title).toBe('Sooner')
    expect(next?.live).toBe(false)
  })

  it('expired bookings never surface', () => {
    expect(nextBookingFrom([window(-120, -60, 'Over')], NOW)).toBeNull()
  })

  it('an empty room has no future', () => {
    expect(nextBookingFrom([], NOW)).toBeNull()
  })
})

describe('applyBooking', () => {
  it('adopts a booking onto a live room state', () => {
    const book = newRoomBook()
    expect(applyBooking(book, 'boardroom', window(30, 60, 'Offsite'))).toBe(true)
    expect(book.rooms.get('boardroom')?.booking?.title).toBe('Offsite')
  })

  it('declines unknown and dynamic rooms', () => {
    const book = newRoomBook()
    expect(applyBooking(book, 'no-such-room', window(30, 60))).toBe(false)
  })
})
