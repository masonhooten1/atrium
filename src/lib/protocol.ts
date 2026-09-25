// Typed socket contracts shared by the client and the server. The server is
// the sole authority: joins, moves, and capacity decisions are validated there.
import type { AvatarProfile, HatId } from './avatar-presets'

export interface PeerInfo {
  id: string
  name: string
  color: string
  hat: HatId
  x: number
  y: number
}

export type JoinAck =
  | { ok: true; self: PeerInfo; peers: PeerInfo[] }
  | { ok: false; reason: 'overloaded' }

export interface ServerToClientEvents {
  'presence:state': (p: { peers: PeerInfo[] }) => void
  'presence:peer': (p: { peer: PeerInfo; kind: 'joined' | 'moved' | 'left' }) => void
}

export interface ClientToServerEvents {
  'presence:join': (p: AvatarProfile, ack: (r: JoinAck) => void) => void
  'presence:move': (p: { x: number; y: number }) => void
}
