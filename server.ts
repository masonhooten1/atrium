import { createServer } from 'node:http'
import { parse } from 'node:url'
import next from 'next'
import { Server as SocketServer } from 'socket.io'
import { SPAWN } from './src/lib/world'
import { acceptMove, joinPeer, newPeerBook, removePeer, snapshot, upsertPeer } from './src/lib/presence'
import {
  joinRoom,
  leaveAllRooms,
  leaveRoom,
  newRoomBook,
  roomSummaries,
  sharedRoom,
  sweepBookings,
} from './src/lib/room-state'
import type { ClientToServerEvents, ServerToClientEvents } from './src/lib/protocol'

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
// disconnect — a client can never hold a seat it did not get from here.
const roomBook = newRoomBook()

async function main() {
  const app = next({ dev })
  const handle = app.getRequestHandler()
  await app.prepare()

  const httpServer = createServer((req, res) => {
    handle(req, res, parse(req.url ?? '/', true))
  })

  const io = new SocketServer<ClientToServerEvents, ServerToClientEvents>(httpServer)

  // Door state goes to everyone: any join, leave or disconnect can flip a
  // door between open, full and reserved.
  const broadcastSummary = (): void => {
    const now = Date.now()
    sweepBookings(roomBook, now)
    io.emit('room:summary', { rooms: roomSummaries(roomBook, now) })
  }

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

    socket.on('room:join', (p, ack) => {
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
      ack({
        ok: true,
        room: { id: roomId, name: state.def.name, kind: state.def.kind, capacity: state.def.capacity },
        peers: occupants,
      })
      socket.to(`room:${roomId}`).emit('room:peer', { roomId, peer, kind: 'joined' })
      broadcastSummary()
    })

    socket.on('room:leave', (p) => {
      const roomId = typeof p?.roomId === 'string' ? p.roomId : ''
      if (!leaveRoom(roomBook, roomId, socket.id)) return
      socket.leave(`room:${roomId}`)
      const peer = book.peers.get(socket.id)
      if (peer) io.to(`room:${roomId}`).emit('room:peer', { roomId, peer, kind: 'left' })
      broadcastSummary()
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

    socket.on('disconnecting', () => {
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
      if (leftRooms.length > 0) broadcastSummary()
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

  httpServer.listen(port, () => {
    console.log(`atrium ready on http://localhost:${port}${dev ? ' (dev)' : ''}`)
  })

  const shutdown = (): void => {
    clearInterval(flush)
    io.close()
    httpServer.close(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

void main()
