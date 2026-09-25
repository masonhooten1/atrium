import { describe, expect, it } from 'vitest'
import {
  INVITE_EXPIRY_MS,
  INVITE_RANGE_TILES,
  cancelInvitesInvolving,
  createInvite,
  newInviteBook,
  respondInvite,
  sweepInvites,
} from '@/lib/invite-state'
import { peerNear, podSpawnPos, ROOMS } from '@/lib/rooms'
import { newPeerBook, teleportPeer } from '@/lib/presence'
import {
  joinRoom,
  leaveAllRooms,
  leaveRoom,
  newRoomBook,
  occupiesAnyRoom,
  roomSummaries,
  spawnRoom,
} from '@/lib/room-state'
import type { Vec2 } from '@/lib/world'

const NOW = 1_700_000_000_000

function pos(x: number, y: number): Vec2 {
  return { x, y }
}

describe('invite range enforcement', () => {
  it('accepts an invite within street range and refuses one beyond it', () => {
    const book = newInviteBook()
    expect(
      createInvite(book, { inviterId: 'a', targetId: 'b', inviterPos: pos(0, 0), targetPos: pos(3.9, 0), now: NOW }).ok,
    ).toBe(true)

    const fresh = newInviteBook()
    const far = createInvite(fresh, {
      inviterId: 'a',
      targetId: 'b',
      inviterPos: pos(0, 0),
      targetPos: pos(INVITE_RANGE_TILES + 0.1, 0),
      now: NOW,
    })
    expect(far).toEqual({ ok: false, reason: 'range' })
  })

  it('refuses inviting yourself', () => {
    const book = newInviteBook()
    expect(
      createInvite(book, { inviterId: 'a', targetId: 'a', inviterPos: pos(0, 0), targetPos: pos(0, 0), now: NOW }),
    ).toEqual({ ok: false, reason: 'self' })
  })

  it('allows one outstanding invite per inviter — no stacking', () => {
    const book = newInviteBook()
    expect(createInvite(book, { inviterId: 'a', targetId: 'b', inviterPos: pos(0, 0), targetPos: pos(1, 0), now: NOW }).ok).toBe(true)
    expect(
      createInvite(book, { inviterId: 'a', targetId: 'c', inviterPos: pos(0, 0), targetPos: pos(1, 0), now: NOW }),
    ).toEqual({ ok: false, reason: 'outstanding' })
    // A different inviter is unaffected.
    expect(createInvite(book, { inviterId: 'd', targetId: 'c', inviterPos: pos(0, 0), targetPos: pos(1, 0), now: NOW }).ok).toBe(true)
  })

  it('allows inviting again after a decline', () => {
    const book = newInviteBook()
    const first = createInvite(book, { inviterId: 'a', targetId: 'b', inviterPos: pos(0, 0), targetPos: pos(1, 0), now: NOW })
    expect(first.ok).toBe(true)
    if (first.ok) {
      expect(respondInvite(book, first.invite.id, 'b', NOW + 1)).toEqual({ ok: true, invite: first.invite })
    }
    expect(createInvite(book, { inviterId: 'a', targetId: 'c', inviterPos: pos(0, 0), targetPos: pos(1, 0), now: NOW + 2 }).ok).toBe(true)
  })
})

describe('invite expiry timer', () => {
  it('keeps an invite one tick before expiry and sweeps it at the boundary', () => {
    const book = newInviteBook()
    const created = createInvite(book, { inviterId: 'a', targetId: 'b', inviterPos: pos(0, 0), targetPos: pos(1, 0), now: NOW })
    expect(created.ok).toBe(true)
    expect(sweepInvites(book, NOW + INVITE_EXPIRY_MS - 1)).toEqual([])
    expect(book.invites.size).toBe(1)

    const expired = sweepInvites(book, NOW + INVITE_EXPIRY_MS)
    expect(expired).toHaveLength(1)
    expect(expired[0].inviterId).toBe('a')
    expect(expired[0].targetId).toBe('b')
    expect(book.invites.size).toBe(0)
  })

  it('frees the inviter after expiry and refuses a late answer', () => {
    const book = newInviteBook()
    const created = createInvite(book, { inviterId: 'a', targetId: 'b', inviterPos: pos(0, 0), targetPos: pos(1, 0), now: NOW })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    sweepInvites(book, NOW + INVITE_EXPIRY_MS)
    // Silence resolved as a no: the inviter can ask again.
    expect(
      createInvite(book, { inviterId: 'a', targetId: 'b', inviterPos: pos(0, 0), targetPos: pos(1, 0), now: NOW + INVITE_EXPIRY_MS }).ok,
    ).toBe(true)
    // And the stale invite can no longer be answered.
    expect(respondInvite(book, created.invite.id, 'b', NOW + INVITE_EXPIRY_MS)).toEqual({ ok: false, reason: 'unknown' })
  })

  it('only lets the target answer', () => {
    const book = newInviteBook()
    const created = createInvite(book, { inviterId: 'a', targetId: 'b', inviterPos: pos(0, 0), targetPos: pos(1, 0), now: NOW })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(respondInvite(book, created.invite.id, 'c', NOW + 1)).toEqual({ ok: false, reason: 'not-target' })
    // Still outstanding after the impostor's attempt — the target can answer.
    expect(respondInvite(book, created.invite.id, 'b', NOW + 2).ok).toBe(true)
  })
})

describe('invite disconnect cleanup', () => {
  it('cancels invites involving the departing peer, as inviter or target', () => {
    const book = newInviteBook()
    const asInviter = createInvite(book, { inviterId: 'a', targetId: 'b', inviterPos: pos(0, 0), targetPos: pos(1, 0), now: NOW })
    const asTarget = createInvite(book, { inviterId: 'c', targetId: 'a', inviterPos: pos(0, 0), targetPos: pos(1, 0), now: NOW })
    expect(asInviter.ok && asTarget.ok).toBe(true)

    const cancelled = cancelInvitesInvolving(book, 'a')
    expect(cancelled).toHaveLength(2)
    expect(book.invites.size).toBe(0)
    expect(cancelInvitesInvolving(book, 'zzz')).toEqual([])
  })
})

describe('spawned pods', () => {
  it('take exactly two seats, refuse a third, and dissolve when emptied', () => {
    const book = newRoomBook()
    const def = { id: 'pod-spawn-1', kind: 'pod' as const, name: 'Grab Pod 1', capacity: 2, joinable: true, dynamic: true, isSpawned: true, door: pos(10, 11) }
    spawnRoom(book, def)
    expect(joinRoom(book, 'pod-spawn-1', 'a', NOW)).toEqual({ ok: true, seat: 0 })
    expect(joinRoom(book, 'pod-spawn-1', 'b', NOW)).toEqual({ ok: true, seat: 1 })
    expect(joinRoom(book, 'pod-spawn-1', 'c', NOW)).toEqual({ ok: false, reason: 'full' })

    leaveRoom(book, 'pod-spawn-1', 'a')
    expect(book.rooms.has('pod-spawn-1')).toBe(true)
    leaveRoom(book, 'pod-spawn-1', 'b')
    expect(book.rooms.has('pod-spawn-1')).toBe(false)
  })

  it('never dissolve street rooms', () => {
    const book = newRoomBook()
    joinRoom(book, 'pod-north', 'a', NOW)
    leaveRoom(book, 'pod-north', 'a')
    expect(book.rooms.has('pod-north')).toBe(true)
  })

  it('appear in summaries with their landing spot while alive, and vanish after', () => {
    const book = newRoomBook()
    const before = roomSummaries(book, NOW).filter((r) => r.id.startsWith('pod-spawn'))
    expect(before).toEqual([])

    spawnRoom(book, {
      id: 'pod-spawn-7',
      kind: 'pod',
      name: 'Grab Pod 7',
      capacity: 2,
      joinable: true,
      dynamic: true,
      isSpawned: true,
      door: pos(10, 11),
    })
    joinRoom(book, 'pod-spawn-7', 'a', NOW)
    const summaries = roomSummaries(book, NOW)
    const spawned = summaries.find((r) => r.id === 'pod-spawn-7')
    expect(spawned?.door).toEqual({ x: 10, y: 11 })
    expect(spawned?.occupancy).toBe(1)
    expect(spawned?.status).toBe('open')
    // Static rooms are untouched by the spawned append.
    expect(summaries.find((r) => r.id === 'pod-north')?.door).toBeUndefined()

    leaveAllRooms(book, 'a')
    expect(roomSummaries(book, NOW).some((r) => r.id === 'pod-spawn-7')).toBe(false)
  })

  it('keeps the gesture from grabbing anyone holding a room seat', () => {
    const book = newRoomBook()
    joinRoom(book, 'pod-north', 'a', NOW)
    expect(occupiesAnyRoom(book, 'a')).toBe(true)
    expect(occupiesAnyRoom(book, 'b')).toBe(false)
    leaveRoom(book, 'pod-north', 'a')
    expect(occupiesAnyRoom(book, 'a')).toBe(false)
  })
})

describe('grab-gesture geometry', () => {
  it('lands the pod midway between the two avatars, inside the walk bounds', () => {
    expect(podSpawnPos(pos(10, 11), pos(12, 11))).toEqual({ x: 11, y: 11 })
    // The midpoint clamps into the band when the pair hugs its edge.
    const clamped = podSpawnPos(pos(1, 1), pos(29, 11))
    expect(clamped.y).toBeGreaterThanOrEqual(10.2)
  })

  it('picks the nearest avatar within the click radius and nothing further', () => {
    const peers = [
      { id: 'a', x: 10, y: 10 },
      { id: 'b', x: 10.5, y: 10 },
    ]
    expect(peerNear(peers, pos(10.4, 10))?.id).toBe('b')
    expect(peerNear(peers, pos(10.2, 10))?.id).toBe('a')
    expect(peerNear(peers, pos(12, 10))).toBeNull()
  })

  it('teleports avatars server-side, clamped like any other move', () => {
    const book = newPeerBook()
    book.peers.set('a', { id: 'a', name: 'A', color: '#f26d6d', hat: 'cap', x: 15, y: 11 })
    expect(teleportPeer(book, 'a', pos(16, 11))?.x).toBe(16)
    expect(teleportPeer(book, 'a', pos(-5, -5))).toMatchObject({ x: 0.8, y: 10.2 })
    expect(teleportPeer(book, 'ghost', pos(1, 1))).toBeNull()
  })
})

describe('street rooms are untouched by the gesture', () => {
  it('keeps the static room list exactly as mapped', () => {
    const book = newRoomBook()
    expect(ROOMS.some((d) => d.isSpawned)).toBe(false)
    expect(roomSummaries(book, NOW)).toHaveLength(ROOMS.length)
  })
})
