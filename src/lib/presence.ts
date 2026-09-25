// Pure presence state transitions. The server uses PeerBook to arbitrate who
// is on the street; the client uses the same shapes to merge snapshots and
// broadcasts. Keeping these pure means both sides share one tested logic core.
import { clampToWorld } from './world'
import { sanitizeProfile } from './avatar-presets'
import type { PeerInfo } from './protocol'
import type { AvatarProfile } from './avatar-presets'

export interface PeerBook {
  peers: Map<string, PeerInfo>
}

export function newPeerBook(): PeerBook {
  return { peers: new Map() }
}

export function upsertPeer(book: PeerBook, peer: PeerInfo): void {
  book.peers.set(peer.id, peer)
}

export function removePeer(book: PeerBook, id: string): PeerInfo | null {
  const peer = book.peers.get(id)
  if (!peer) return null
  book.peers.delete(id)
  return peer
}

export function snapshot(book: PeerBook): PeerInfo[] {
  return [...book.peers.values()]
}

// Merge a full snapshot from the server (used by clients on connect).
export function replaceAll(book: PeerBook, peers: PeerInfo[]): void {
  book.peers = new Map(peers.map((p) => [p.id, p]))
}

// Server-side join: sanitize the profile, place the avatar, register the peer.
export function joinPeer(
  book: PeerBook,
  id: string,
  profile: AvatarProfile,
  spawn: { x: number; y: number },
): PeerInfo {
  const clean = sanitizeProfile(profile)
  const peer: PeerInfo = { id, ...clean, x: spawn.x, y: spawn.y }
  book.peers.set(id, peer)
  return peer
}

// Server-side move: the server clamps every position into the street bounds —
// a client cannot walk into the void by lying over the socket. Returns the
// accepted position, or null when the payload is malformed.
export function acceptMove(
  book: PeerBook,
  id: string,
  p: { x: number; y: number },
): { x: number; y: number } | null {
  const peer = book.peers.get(id)
  if (!peer) return null
  if (typeof p?.x !== 'number' || typeof p?.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
    return null
  }
  const clamped = clampToWorld({ x: p.x, y: p.y })
  peer.x = clamped.x
  peer.y = clamped.y
  return clamped
}
