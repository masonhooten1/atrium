// Typed socket contracts shared by the client and the server. The server is
// the sole authority: joins, moves, room capacity, and signaling relay are
// validated there; clients only render what they receive.
import type { AvatarProfile, HatId } from './avatar-presets'
import type { RoomKind } from './rooms'

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

// --- Rooms -------------------------------------------------------------------

// 'closed' = unknown room or the stage layout stub (client disables those
// doors; reaching it means a lying or stale client).
export type RoomRefusal = 'full' | 'reserved' | 'closed'

export interface RoomBookingInfo {
  title: string
  startsAt: number
  // True once the booking window has opened ("Now:") vs upcoming ("Next:").
  live: boolean
}

export interface RoomSummary {
  id: string
  kind: RoomKind
  name: string
  capacity: number
  occupancy: number
  status: 'open' | 'full' | 'reserved' | 'stub'
  joinable: boolean
  dynamic: boolean
  booking: RoomBookingInfo | null
}

export type RoomJoinAck =
  | {
      ok: true
      room: { id: string; name: string; kind: RoomKind; capacity: number }
      // Everyone already inside (excluding the joiner), for tile rendering.
      peers: PeerInfo[]
    }
  | { ok: false; reason: RoomRefusal }

// WebRTC relay envelope: session descriptions and ICE candidates ride the
// same event; the server forwards unopened, but only between sockets that
// share a room.
// One relayed WebRTC signaling message, as the server forwards it.
export type WebRTCPacket = { signal: RTCSignal; from: string }

export type RTCSignal =
  | { kind: 'desc'; description: RTCSessionDescriptionInit }
  | { kind: 'ice'; candidate: RTCIceCandidateInit }

export interface ServerToClientEvents {
  'presence:state': (p: { peers: PeerInfo[] }) => void
  'presence:peer': (p: { peer: PeerInfo; kind: 'joined' | 'moved' | 'left' }) => void
  // Full door-state snapshot: on street join and after any occupancy change.
  'room:summary': (p: { rooms: RoomSummary[] }) => void
  'room:peer': (p: { roomId: string; peer: PeerInfo; kind: 'joined' | 'left' }) => void
  'room:webrtc': (p: { signal: RTCSignal; from: string }) => void
  'room:share': (p: { roomId: string; peerId: string; sharing: boolean }) => void
}

export interface ClientToServerEvents {
  'presence:join': (p: AvatarProfile, ack: (r: JoinAck) => void) => void
  'presence:move': (p: { x: number; y: number }) => void
  'room:join': (p: { roomId: string }, ack: (r: RoomJoinAck) => void) => void
  'room:leave': (p: { roomId: string }) => void
  'room:webrtc': (p: { signal: RTCSignal; to: string }) => void
  'room:share': (p: { roomId: string; sharing: boolean }) => void
}
