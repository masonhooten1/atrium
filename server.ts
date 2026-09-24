import { createServer } from 'node:http'
import { parse } from 'node:url'
import next from 'next'
import { Server as SocketServer } from 'socket.io'

const port = Number(process.env.PORT ?? 3000)
const dev = process.env.NODE_ENV !== 'production'

// One process hosts the app and the realtime layer: Next handles HTTP through
// this server, Socket.IO rides on the same listener for presence, room state
// and WebRTC signaling. Those event contracts arrive in their own slices — the
// transport is live from the scaffold onward.
async function main() {
  const app = next({ dev })
  const handle = app.getRequestHandler()
  await app.prepare()

  const httpServer = createServer((req, res) => {
    handle(req, res, parse(req.url ?? '/', true))
  })

  const io = new SocketServer(httpServer)
  io.on('connection', (socket) => {
    console.log(`socket connected: ${socket.id}`)
  })

  httpServer.listen(port, () => {
    console.log(`atrium ready on http://localhost:${port}${dev ? ' (dev)' : ''}`)
  })
}

void main()
