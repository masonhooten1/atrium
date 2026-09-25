import { createServer } from 'node:http'
import { parse } from 'node:url'
import next from 'next'
import { Server as SocketServer } from 'socket.io'
import { SPAWN } from './src/lib/world'
import { acceptMove, joinPeer, newPeerBook, removePeer, snapshot, teleportPeer, upsertPeer } from './src/lib/presence'
import {
  joinRoom,
  leaveAllRooms,
  leaveRoom,
  occupiesAnyRoom,
  roomSummaries,
  sharedRoom,
  spawnRoom,
} from './src/lib/room-state'
import { createInvite, cancelInvitesInvolving, newInviteBook, respondInvite, sweepInvites } from './src/lib/invite-state'
import { podSpawnPos } from './src/lib/rooms'
import { getDb } from './src/lib/db'
import { bindIo, broadcastSummaries, getRoomBook } from './src/lib/server/runtime'
import { appendStroke, ensureRoomRows, listStrokes } from './src/lib/server/store'
import { sanitizeStroke } from './src/lib/whiteboard'
import type { ClientToServerEvents, PodInviteOutcome, PodSpawnInfo, ServerToClientEvents } from './src/lib/protocol'
import type { RoomDef } from './src/lib/rooms'

// One process hosts the app and the realtime layer: Next handles HTTP through
// this server, Socket.IO rides on the same listener for presence, room state
// and WebRTC signaling.
const port = Number(process.env.PORT ?? 3000)
const dev = process.env.NODE_ENV !== 'production'

// Server-side broadcast throttle: moves accumulate in `dirty` and flush at
// ~15 Hz so a chatty client cannot flood the street with packets.
const BROADCAST_MS = 1000 / 15

// The street's presence state. The server is authoritative: joins and moves
// are validated here, clients only render what they receive.
const book = newPeerBook()
const dirty = new Set<string>()

// Room occupancy: the server hands out seats and frees them on leave or
// disconnect — a client can never hold a seat it did not get from here. The
// book is the process-wide runtime instance so Next API routes (bookings)
// read and refresh the same world state.
const roomBook = getRoomBook()

// Grab-gesture invites: one outstanding per inviter, 30 s expiry, and only
// the server can spawn the pod on a yes. Spawned pods are in-memory like the
// room book — they exist while occupied and dissolve when emptied.
const inviteBook = newInviteBook()
let spawnedPods = 0

async function main() {
  const db = getDb()
  // Static rooms get their rows before the first socket connects: strokes
  // and bookings reference them, and SQLite enforces the foreign keys.
  await ensureRoomRows(db)

  const app = next({ dev })
  const handle = app.getRequestHandler()
  await app.prepare()

  const httpServer = createServer((req, res) => {
    handle(req, res, parse(req.url ?? '/', true))
  })

  const io = new SocketServer<ClientToServerEvents, ServerToClientEvents>(httpServer)
  bindIo(io)

  io.on('connection', (socket) => {
    socket.on('presence:join', (profile, ack) => {
      const peer = joinPeer(book, socket.id, profile, SPAWN)
      upsertPeer(book, peer)
      // The joiner gets the world as it is (including their own echo, which
      // the client drops from its peer map); everyone else sees them join.
      ack({ ok: true, self: peer, peers: snapshot(book) })
      // Doors come with the world so the street renders complete.
      socket.emit('room:summary', { rooms: roomSummaries(roomBook, Date.now()) })
      socket.broadcast.emit('presence:peer', { peer, kind: 'joined' })
    })

    socket.on('presence:move', (p) => {
      if (acceptMove(book, socket.id, p)) dirty.add(socket.id)
    })

    socket.on('room:join', async (p, ack) => {
      const peer = book.peers.get(socket.id)
      const roomId = typeof p?.roomId === 'string' ? p.roomId : ''
      if (!peer || !ack || !roomId) {
        ack?.({ ok: false, reason: 'closed' })
        return
      }
      const result = joinRoom(roomBook, roomId, socket.id, Date.now())
      if (!result.ok) {
        ack({ ok: false, reason: result.reason })
        return
      }
      const state = roomBook.rooms.get(roomId)
      if (!state) {
        ack({ ok: false, reason: 'closed' })
        return
      }
      socket.join(`room:${roomId}`)
      const occupants = [...state.occupants.keys()]
        .filter((id) => id !== socket.id)
        .map((id) => book.peers.get(id))
        .filter((q) => q !== undefined)
      // Whiteboard history rides with the seat: the joiner's board is full
      // from the first frame. Spawned pods have no surface, so no read.
      const strokes = state.def.isSpawned ? [] : await listStrokes(db, roomId)
      ack({
        ok: true,
        room: { id: roomId, name: state.def.name, kind: state.def.kind, capacity: state.def.capacity },
        peers: occupants,
        strokes,
      })
      socket.to(`room:${roomId}`).emit('room:peer', { roomId, peer, kind: 'joined' })
      broadcastSummaries()
    })

    socket.on('room:leave', (p) => {
      const roomId = typeof p?.roomId === 'string' ? p.roomId : ''
      if (!leaveRoom(roomBook, roomId, socket.id)) return
      socket.leave(`room:${roomId}`)
      const peer = book.peers.get(socket.id)
      if (peer) io.to(`room:${roomId}`).emit('room:peer', { roomId, peer, kind: 'left' })
      broadcastSummaries()
    })

    socket.on('room:webrtc', (p) => {
      const { signal, to } = p ?? {}
      if (!signal || typeof to !== 'string') return
      // The relay is room-scoped: two sockets can only exchange signaling if
      // the server has both in the same room. SDP is forwarded unopened.
      // The relay is room-scoped: two sockets can only exchange signaling if
      // the server has both in the same room. SDP is forwarded unopened.
      if (!sharedRoom(roomBook, socket.id, to)) return
      io.to(to).emit('room:webrtc', { signal, from: socket.id })
    })

    socket.on('room:share', (p) => {
      const roomId = typeof p?.roomId === 'string' ? p.roomId : ''
      const state = roomBook.rooms.get(roomId)
      if (!state || !state.occupants.has(socket.id)) return
      io.to(`room:${roomId}`).emit('room:share', { roomId, peerId: socket.id, sharing: Boolean(p.sharing) })
    })

    socket.on('whiteboard:stroke', async (p) => {
      const roomId = typeof p?.roomId === 'string' ? p.roomId : ''
      const state = roomBook.rooms.get(roomId)
      // Only a seated room-mate can draw, and only in a room with a board —
      // spawned grab-pods have no whiteboard surface.
      if (!state || state.def.isSpawned || !state.occupants.has(socket.id)) return
      const stroke = sanitizeStroke(p.stroke)
      if (!stroke) return
      // The final version persists before it is relayed: a fast leave-and-
      // rejoin must read this stroke from history, never miss it.
      if (stroke.final) {
        try {
          await appendStroke(db, roomId, stroke)
        } catch (err) {
          // The room still sees the stroke live; the console says loudly
          // that this one will not survive a restart.
          console.error('whiteboard stroke persist failed', err)
        }
      }
      socket.to(`room:${roomId}`).emit('whiteboard:stroke', { roomId, stroke })
    })

    socket.on('pod:invite', (p, ack) => {
      if (!ack) return
      const targetId = typeof p?.targetId === 'string' ? p.targetId : ''
      const inviter = book.peers.get(socket.id)
      const target = targetId ? book.peers.get(targetId) : undefined
      if (!inviter || !target) {
        ack({ ok: false, reason: 'unknown-peer' })
        return
      }
      if (targetId === socket.id) {
        ack({ ok: false, reason: 'self' })
        return
      }
      // The gesture starts meetings on the street: anyone already holding a
      // room seat is out of reach until they come back out.
      if (occupiesAnyRoom(roomBook, socket.id) || occupiesAnyRoom(roomBook, targetId)) {
        ack({ ok: false, reason: 'busy' })
        return
      }
      const result = createInvite(inviteBook, {
        inviterId: socket.id,
        targetId,
        inviterPos: { x: inviter.x, y: inviter.y },
        targetPos: { x: target.x, y: target.y },
        now: Date.now(),
      })
      if (!result.ok) {
        ack(result)
        return
      }
      ack({ ok: true, inviteId: result.invite.id })
      io.to(targetId).emit('pod:incoming', { inviteId: result.invite.id, from: inviter })
    })

    socket.on('pod:invite:respond', (p, ack) => {
      if (!ack) return
      const inviteId = typeof p?.inviteId === 'string' ? p.inviteId : ''
      const result = respondInvite(inviteBook, inviteId, socket.id, Date.now())
      if (!result.ok) {
        ack(result)
        return
      }
      const { invite } = result
      const resolved = (outcome: PodInviteOutcome, pod: PodSpawnInfo | null): void => {
        io.to(invite.inviterId).emit('pod:resolved', { inviteId, outcome, pod })
        io.to(invite.targetId).emit('pod:resolved', { inviteId, outcome, pod })
      }
      // A no spawns nothing — the street is exactly as it was.
      if (p?.accept !== true) {
        ack({ ok: true, outcome: 'declined' })
        resolved('declined', null)
        return
      }
      // A yes that can no longer be honored spawns nothing either.
      const inviter = book.peers.get(invite.inviterId)
      const target = book.peers.get(invite.targetId)
      if (
        !inviter ||
        !target ||
        occupiesAnyRoom(roomBook, invite.inviterId) ||
        occupiesAnyRoom(roomBook, invite.targetId)
      ) {
        ack({ ok: true, outcome: 'unavailable' })
        resolved('unavailable', null)
        return
      }
      // The yes: spawn a fresh two-seat pod between the two avatars, hand out
      // both seats, and teleport them — server-authoritative presence moves;
      // the clients render what happened.
      spawnedPods += 1
      const pos = podSpawnPos(inviter, target)
      const def: RoomDef = {
        id: `pod-spawn-${spawnedPods}`,
        kind: 'pod',
        name: `Grab Pod ${spawnedPods}`,
        capacity: 2,
        joinable: true,
        dynamic: true,
        isSpawned: true,
        door: pos,
      }
      spawnRoom(roomBook, def)
      for (const peerId of [invite.inviterId, invite.targetId]) {
        teleportPeer(book, peerId, pos)
        dirty.add(peerId)
        joinRoom(roomBook, def.id, peerId, Date.now())
        io.sockets.sockets.get(peerId)?.join(`room:${def.id}`)
      }
      ack({ ok: true, outcome: 'accepted' })
      resolved('accepted', { roomId: def.id, name: def.name, pos })
      // Each side learns about the other the way a door join would announce
      // it, after the resolved event has opened their room view.
      io.to(invite.inviterId).emit('room:peer', { roomId: def.id, peer: target, kind: 'joined' })
      io.to(invite.targetId).emit('room:peer', { roomId: def.id, peer: inviter, kind: 'joined' })
      broadcastSummaries()
    })

    socket.on('disconnecting', () => {
      // Outstanding invites die with the socket: the other side hears a
      // resolution, never silence.
      for (const invite of cancelInvitesInvolving(inviteBook, socket.id)) {
        const other = invite.inviterId === socket.id ? invite.targetId : invite.inviterId
        io.to(other).emit('pod:resolved', { inviteId: invite.id, outcome: 'unavailable', pod: null })
      }
      // Rooms first: every seat this socket held frees, and room-mates learn
      // before the presence layer removes the avatar from the street.
      const leftRooms = leaveAllRooms(roomBook, socket.id)
      const peer = book.peers.get(socket.id)
      for (const roomId of leftRooms) {
        if (peer) io.to(`room:${roomId}`).emit('room:peer', { roomId, peer, kind: 'left' })
      }
      const left = removePeer(book, socket.id)
      dirty.delete(socket.id)
      if (left) socket.broadcast.emit('presence:peer', { peer: left, kind: 'left' })
      if (leftRooms.length > 0) broadcastSummaries()
    })
  })

  const flush = setInterval(() => {
    if (dirty.size === 0) return
    for (const id of dirty) {
      const peer = book.peers.get(id)
      if (peer) io.emit('presence:peer', { peer, kind: 'moved' })
    }
    dirty.clear()
  }, BROADCAST_MS)

  // Invite expiry: unanswered invites die at 30 s and both parties hear the
  // no. Sweeping every second bounds how late the notice can arrive.
  const inviteSweep = setInterval(() => {
    for (const invite of sweepInvites(inviteBook, Date.now())) {
      io.to(invite.inviterId).emit('pod:resolved', { inviteId: invite.id, outcome: 'expired', pod: null })
      io.to(invite.targetId).emit('pod:resolved', { inviteId: invite.id, outcome: 'expired', pod: null })
    }
  }, 1_000)

  httpServer.listen(port, () => {
    console.log(`atrium ready on http://localhost:${port}${dev ? ' (dev)' : ''}`)
  })

  const shutdown = (): void => {
    clearInterval(flush)
    clearInterval(inviteSweep)
    io.close()
    httpServer.close(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

void main()
