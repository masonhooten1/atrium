// Typed socket contracts shared by the client and the server. The server is
// the sole authority: joins, moves, room capacity, and signaling relay are
// validated there; clients only render what they receive.
import type { AvatarProfile, HatId } from './avatar-presets'
import type { RoomKind } from './rooms'
import type { StrokeData } from './whiteboard'

export type { StrokeData, StrokePoint } from './whiteboard'

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
  // Present only for spawned pods — static door positions live in the defs.
  door?: { x: number; y: number }
}

export type RoomJoinAck =
  | {
      ok: true
      room: { id: string; name: string; kind: RoomKind; capacity: number }
      // Everyone already inside (excluding the joiner), for tile rendering.
      peers: PeerInfo[]
      // The room's whiteboard history, served atomically with the seat:
      // new joiners get the batch first, then live stroke events.
      strokes: StrokeData[]
    }
  | { ok: false; reason: RoomRefusal }

// --- Grab gesture ------------------------------------------------------------

// Outcomes of a pod invite: accepted (pod spawned, both teleported inside),
// declined, expired (30 s silence), or unavailable (someone stepped into a
// room before the answer landed). Nothing materializes on any outcome but
// accepted.
export type PodInviteOutcome = 'accepted' | 'declined' | 'expired' | 'unavailable'

// Where the spawned pod landed: both parties teleport here and every street
// client renders the booth at this spot.
export interface PodSpawnInfo {
  roomId: string
  name: string
  pos: { x: number; y: number }
}

export type PodInviteAck =
  | { ok: true; inviteId: string }
  | { ok: false; reason: 'self' | 'range' | 'outstanding' | 'busy' | 'unknown-peer' }

// WebRTC relay envelope: session descriptions and ICE candidates ride the
// same event; the server forwards unopened, but only between sockets that
// share a room.
// One relayed WebRTC signaling message, as the server forwards it.
export type WebRTCPacket = { signal: RTCSignal; from: string }

export type RTCSignal =
  | { kind: 'desc'; description: RTCSessionDescriptionInit }
  | { kind: 'ice'; candidate: RTCIceCandidateInit }

// --- Whiteboard --------------------------------------------------------------

// In-room drawing surface (huddle zones and the boardroom). The server
// validates and persists final strokes, and relays every update to the
// sender's room-mates — never back to the sender, who renders locally.

export interface ServerToClientEvents {
  'presence:state': (p: { peers: PeerInfo[] }) => void
  'presence:peer': (p: { peer: PeerInfo; kind: 'joined' | 'moved' | 'left' }) => void
  // Full door-state snapshot: on street join and after any occupancy change.
  'room:summary': (p: { rooms: RoomSummary[] }) => void
  'room:peer': (p: { roomId: string; peer: PeerInfo; kind: 'joined' | 'left' }) => void
  'room:webrtc': (p: { signal: RTCSignal; from: string }) => void
  'room:share': (p: { roomId: string; peerId: string; sharing: boolean }) => void
  'pod:incoming': (p: { inviteId: string; from: PeerInfo }) => void
  'pod:resolved': (p: { inviteId: string; outcome: PodInviteOutcome; pod: PodSpawnInfo | null }) => void
  'whiteboard:stroke': (p: { roomId: string; stroke: StrokeData }) => void
}

export interface ClientToServerEvents {
  'presence:join': (p: AvatarProfile, ack: (r: JoinAck) => void) => void
  'presence:move': (p: { x: number; y: number }) => void
  'room:join': (p: { roomId: string }, ack: (r: RoomJoinAck) => void) => void
  'room:leave': (p: { roomId: string }) => void
  'room:webrtc': (p: { signal: RTCSignal; to: string }) => void
  'room:share': (p: { roomId: string; sharing: boolean }) => void
  'pod:invite': (p: { targetId: string }, ack: (r: PodInviteAck) => void) => void
  'pod:invite:respond': (
    p: { inviteId: string; accept: boolean },
    ack: (r: { ok: true; outcome: PodInviteOutcome } | { ok: false; reason: 'unknown' | 'not-target' }) => void,
  ) => void
  'whiteboard:stroke': (p: { roomId: string; stroke: StrokeData }) => void
}
