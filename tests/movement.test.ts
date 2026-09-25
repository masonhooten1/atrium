import { describe, expect, it } from 'vitest'
import { clampToWorld, WALK_BOUNDS } from '@/lib/world'
import { acceptMove, joinPeer, newPeerBook } from '@/lib/presence'

describe('clampToWorld', () => {
  it('keeps in-bounds points unchanged', () => {
    const p = { x: 15, y: 12 }
    expect(clampToWorld(p)).toEqual(p)
  })

  it('clamps positions beyond the street bounds on every axis', () => {
    expect(clampToWorld({ x: 500, y: 12 }).x).toBe(WALK_BOUNDS.maxX)
    expect(clampToWorld({ x: -50, y: 12 }).x).toBe(WALK_BOUNDS.minX)
    expect(clampToWorld({ x: 15, y: 500 }).y).toBe(WALK_BOUNDS.maxY)
    expect(clampToWorld({ x: 15, y: -500 }).y).toBe(WALK_BOUNDS.minY)
  })

  it('clamps a far-outlying point on both axes at once', () => {
    const clamped = clampToWorld({ x: 1e9, y: -1e9 })
    expect(clamped.x).toBe(WALK_BOUNDS.maxX)
    expect(clamped.y).toBe(WALK_BOUNDS.minY)
  })
})

describe('acceptMove (server-side clamp)', () => {
  it('clamps a lying client move into the street bounds', () => {
    const book = newPeerBook()
    joinPeer(book, 'sock-1', { name: 'Liar', color: '#f26d6d', hat: 'crown' }, { x: 15, y: 12 })

    const accepted = acceptMove(book, 'sock-1', { x: 500, y: 12 })
    expect(accepted).toEqual({ x: WALK_BOUNDS.maxX, y: 12 })
  })

  it('rejects malformed payloads and unknown sockets', () => {
    const book = newPeerBook()
    joinPeer(book, 'sock-1', { name: 'A', color: '#f26d6d', hat: 'cap' }, { x: 15, y: 12 })

    expect(acceptMove(book, 'sock-1', { x: Number.NaN, y: 12 })).toBeNull()
    expect(acceptMove(book, 'ghost', { x: 15, y: 12 })).toBeNull()
  })
})
