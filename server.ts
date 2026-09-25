import { createServer } from 'node:http'
import { parse } from 'node:url'
import next from 'next'
import { Server as SocketServer } from 'socket.io'
import { SPAWN } from './src/lib/world'
import { acceptMove, joinPeer, newPeerBook, removePeer, snapshot, upsertPeer } from './src/lib/presence'
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

async function main() {
  const app = next({ dev })
  const handle = app.getRequestHandler()
  await app.prepare()

  const httpServer = createServer((req, res) => {
    handle(req, res, parse(req.url ?? '/', true))
  })

  const io = new SocketServer<ClientToServerEvents, ServerToClientEvents>(httpServer)

  io.on('connection', (socket) => {
    socket.on('presence:join', (profile, ack) => {
      const peer = joinPeer(book, socket.id, profile, SPAWN)
      upsertPeer(book, peer)
      // The joiner gets the world as it is (including their own echo, which
      // the client drops from its peer map); everyone else sees them join.
      ack({ ok: true, self: peer, peers: snapshot(book) })
      socket.broadcast.emit('presence:peer', { peer, kind: 'joined' })
    })

    socket.on('presence:move', (p) => {
      if (acceptMove(book, socket.id, p)) dirty.add(socket.id)
    })

    socket.on('disconnecting', () => {
      const left = removePeer(book, socket.id)
      dirty.delete(socket.id)
      if (left) socket.broadcast.emit('presence:peer', { peer: left, kind: 'left' })
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
