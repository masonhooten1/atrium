import { describe, expect, it } from 'vitest'
import { doorNear, ROOMS, zoneAt } from '@/lib/rooms'
import {
  doorView,
  joinRoom,
  leaveAllRooms,
  leaveRoom,
  newRoomBook,
  roomSummaries,
  sharedRoom,
  sweepBookings,
  type RoomBook,
  type RoomState,
} from '@/lib/room-state'

const NOW = 1_700_000_000_000

function mustState(book: RoomBook, roomId: string): RoomState {
  const state = book.rooms.get(roomId)
  if (!state) throw new Error(`missing room ${roomId}`)
  return state
}

describe('joinRoom capacity arbitration', () => {
  it('fills a pod to exactly two seats and refuses the third with full', () => {
    const book = newRoomBook()
    expect(joinRoom(book, 'pod-north', 'a', NOW)).toEqual({ ok: true, seat: 0 })
    expect(joinRoom(book, 'pod-north', 'b', NOW)).toEqual({ ok: true, seat: 1 })
    expect(joinRoom(book, 'pod-north', 'c', NOW)).toEqual({ ok: false, reason: 'full' })
  })

  it('leaving frees the seat and the freed seat is reused first', () => {
    const book = newRoomBook()
    joinRoom(book, 'pod-north', 'a', NOW)
    joinRoom(book, 'pod-north', 'b', NOW)
    expect(leaveRoom(book, 'pod-north', 'a')).toBe(true)
    expect(joinRoom(book, 'pod-north', 'c', NOW)).toEqual({ ok: true, seat: 0 })
  })

  it('fills the boardroom to eight and refuses the ninth', () => {
    const book = newRoomBook()
    for (let i = 0; i < 8; i++) {
      expect(joinRoom(book, 'boardroom', `p${i}`, NOW).ok).toBe(true)
    }
    expect(joinRoom(book, 'boardroom', 'p8', NOW)).toEqual({ ok: false, reason: 'full' })
  })

  it('is idempotent for a peer already seated', () => {
    const book = newRoomBook()
    const first = joinRoom(book, 'pod-north', 'a', NOW)
    expect(joinRoom(book, 'pod-north', 'a', NOW)).toEqual(first)
  })

  it('refuses unknown rooms and the stage stub with closed', () => {
    const book = newRoomBook()
    expect(joinRoom(book, 'nope', 'a', NOW)).toEqual({ ok: false, reason: 'closed' })
    expect(joinRoom(book, 'stage', 'a', NOW)).toEqual({ ok: false, reason: 'closed' })
  })
})

describe('reserved bookings', () => {
  it('refuses joins while an upcoming booking holds the room, and the door shows it', () => {
    const book = newRoomBook()
    mustState(book, 'boardroom').booking = {
      title: 'Roadmap review',
      startsAt: NOW + 1_000,
      endsAt: NOW + 60_000,
    }
    expect(joinRoom(book, 'boardroom', 'a', NOW)).toEqual({ ok: false, reason: 'reserved' })
    const view = doorView(mustState(book, 'boardroom'), ROOMS[4], NOW)
    expect(view.status).toBe('reserved')
    expect(view.booking?.title).toBe('Roadmap review')
    expect(view.booking?.live).toBe(false)
  })

  it('accepts joins inside the booking window even though the booker never arrived', () => {
    const book = newRoomBook()
    mustState(book, 'boardroom').booking = {
      title: 'Roadmap review',
      startsAt: NOW - 1_000,
      endsAt: NOW + 60_000,
    }
    expect(joinRoom(book, 'boardroom', 'a', NOW)).toEqual({ ok: true, seat: 0 })
    const view = doorView(mustState(book, 'boardroom'), ROOMS[4], NOW)
    // A live booking reads "in session" even though the door still admits.
    expect(view.status).toBe('reserved')
    expect(view.booking?.live).toBe(true)
  })

  it('sweeps an expired booking back to open', () => {
    const book = newRoomBook()
    mustState(book, 'boardroom').booking = {
      title: 'Roadmap review',
      startsAt: NOW - 60_000,
      endsAt: NOW,
    }
    sweepBookings(book, NOW + 1)
    expect(mustState(book, 'boardroom').booking).toBeNull()
    expect(joinRoom(book, 'boardroom', 'a', NOW + 1).ok).toBe(true)
  })
})

describe('huddle pods', () => {
  it('spawn on first join, take four seats, and dissolve when they empty', () => {
    const book = newRoomBook()
    for (let i = 0; i < 4; i++) {
      expect(joinRoom(book, 'huddle-west', `p${i}`, NOW).ok).toBe(true)
    }
    expect(joinRoom(book, 'huddle-west', 'p4', NOW)).toEqual({ ok: false, reason: 'full' })
    for (let i = 0; i < 4; i++) leaveRoom(book, 'huddle-west', `p${i}`)
    expect(book.rooms.has('huddle-west')).toBe(false)
  })
})

describe('disconnect cleanup', () => {
  it('frees every seat the peer held across rooms, in one call', () => {
    const book = newRoomBook()
    joinRoom(book, 'pod-north', 'a', NOW)
    joinRoom(book, 'boardroom', 'a', NOW)
    joinRoom(book, 'huddle-west', 'a', NOW)

    const left = leaveAllRooms(book, 'a').sort()
    expect(left).toEqual(['boardroom', 'huddle-west', 'pod-north'])
    expect(joinRoom(book, 'pod-north', 'b', NOW).ok).toBe(true)
    expect(joinRoom(book, 'boardroom', 'b', NOW).ok).toBe(true)
    expect(joinRoom(book, 'huddle-west', 'b', NOW).ok).toBe(true)
  })
})

describe('relay scoping', () => {
  it('finds shared membership while both peers are in the room, then none', () => {
    const book = newRoomBook()
    joinRoom(book, 'pod-north', 'a', NOW)
    joinRoom(book, 'pod-north', 'b', NOW)
    expect(sharedRoom(book, 'a', 'b')).toBe('pod-north')
    leaveRoom(book, 'pod-north', 'b')
    expect(sharedRoom(book, 'a', 'b')).toBeNull()
  })
})

describe('door views and summaries', () => {
  it('shows full only at capacity, with an empty booking line by default', () => {
    const book = newRoomBook()
    joinRoom(book, 'pod-north', 'a', NOW)
    expect(doorView(mustState(book, 'pod-north'), ROOMS[0], NOW).status).toBe('open')
    joinRoom(book, 'pod-north', 'b', NOW)
    expect(doorView(mustState(book, 'pod-north'), ROOMS[0], NOW).status).toBe('full')
    // No booking API exists yet — every booking line renders empty by default.
    expect(doorView(mustState(book, 'pod-north'), ROOMS[0], NOW).booking).toBeNull()
  })

  it('summaries always include static rooms and unspawned huddle zones', () => {
    const book = newRoomBook()
    const summaries = roomSummaries(book, NOW)
    const west = summaries.find((r) => r.id === 'huddle-west')
    expect(west?.occupancy).toBe(0)
    expect(west?.dynamic).toBe(true)
    expect(summaries.find((r) => r.id === 'stage')?.status).toBe('stub')
  })
})

describe('street lookups', () => {
  it('zoneAt finds the huddle zone containing a point and nothing else', () => {
    expect(zoneAt(ROOMS, { x: 9, y: 16.8 })?.id).toBe('huddle-west')
    expect(zoneAt(ROOMS, { x: 20, y: 16.8 })?.id).toBe('huddle-east')
    expect(zoneAt(ROOMS, { x: 15, y: 12 })).toBeNull()
  })

  it('doorNear snaps clicks near a door and ignores the open street', () => {
    expect(doorNear(ROOMS, { x: 5.6, y: 10.7 })?.id).toBe('pod-north')
    expect(doorNear(ROOMS, { x: 16.6, y: 10.7 })?.id).toBe('boardroom')
    expect(doorNear(ROOMS, { x: 15, y: 12 })).toBeNull()
  })
})
