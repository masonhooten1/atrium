// Persistence integration test: state outlives the process. Seeds strokes
// and a booking through the live server, kills the server with SIGKILL
// (durability must not depend on a graceful shutdown path), boots a fresh
// server on the same SQLite file, and re-reads both through the public
// interfaces a client actually uses — the room:join ack, the booking API,
// and the door summary broadcast.
import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { io, type Socket } from 'socket.io-client'

const PORT = 3217
const BASE = `http://localhost:${PORT}`
const ROOM = 'boardroom'
const COLOR = '#f26d6d'

interface JoinOk {
  ok: true
  room: { id: string; name: string; kind: string; capacity: number }
  peers: unknown[]
  strokes: { id: string; points: { x: number; y: number }[]; final: boolean }[]
}

interface SummaryBroadcast {
  rooms: {
    id: string
    status: 'open' | 'full' | 'reserved' | 'stub'
    booking: { title: string; startsAt: number; live: boolean } | null
  }[]
}

const tmp = mkdtempSync(path.join(tmpdir(), 'atrium-persistence-'))
const dbPath = path.join(tmp, 'persistence.db')
const children: ChildProcess[] = []

afterAll(() => {
  for (const child of children) child.kill('SIGKILL')
  rmSync(tmp, { recursive: true, force: true })
})

function startServer(): ChildProcess {
  // Direct node + tsx loader: the spawned pid IS the server process. Wrapping
  // through npx would make SIGKILL kill only the wrapper and orphan the real
  // server holding the port.
  const child = spawn('node', ['--import', 'tsx', 'server.ts'], {
    cwd: process.cwd(),
    // Output inherited so a CI failure shows the server's own last words.
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, PORT: String(PORT), DATABASE_URL: `file:${dbPath}` },
  })
  children.push(child)
  return child
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitHealthy(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`)
      if (res.ok) return
    } catch {
      // not listening yet
    }
    await sleep(500)
  }
  throw new Error(`server did not become healthy within ${timeoutMs}ms`)
}

function stopHard(child: ChildProcess): Promise<void> {
  // Already exited (or already signalled): the exit event has fired or will
  // never fire — do not wait on it.
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    child.once('exit', () => resolve())
    // SIGKILL: durability must not depend on a graceful shutdown path.
    child.kill('SIGKILL')
  })
}

function connectPeer(name: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(BASE, { transports: ['websocket'] })
    socket.once('connect_error', (err: Error) => reject(err))
    socket.once('connect', () => {
      socket
        .timeout(10_000)
        .emit('presence:join', { name, color: COLOR, hat: 'none' }, (err: Error | null) => {
          if (err) reject(err)
          else resolve(socket)
        })
    })
  })
}

function joinBoardroom(socket: Socket): Promise<JoinOk> {
  return new Promise((resolve, reject) => {
    socket
      .timeout(10_000)
      .emit('room:join', { roomId: ROOM }, (err: Error | null, ack: JoinOk | { ok: false; reason: string }) => {
        if (err) reject(err)
        else if (ack.ok) resolve(ack)
        else reject(new Error(`room:join refused: ${ack.reason}`))
      })
  })
}

function drawFinalStroke(socket: Socket, id: string, y: number): void {
  socket.emit('whiteboard:stroke', {
    roomId: ROOM,
    stroke: {
      id,
      color: COLOR,
      width: 3,
      points: [
        { x: 0.1, y },
        { x: 0.7, y },
      ],
      final: true,
    },
  })
}

describe('persistence across a hard restart', () => {
  it(
    'strokes and bookings survive SIGKILL, reappearing on a fresh boot',
    { timeout: 240_000 },
    async () => {
      // Fresh database, real migrations — the same boot path CI uses.
      execSync('npx prisma migrate deploy', {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
        stdio: 'pipe',
      })

      // --- Session 1: draw strokes, book the room, then die hard. ----------
      const first = startServer()
      await waitHealthy()
      const author = await connectPeer('Scribe')
      const firstJoin = await joinBoardroom(author)
      expect(firstJoin.ok).toBe(true)
      expect(firstJoin.strokes).toEqual([]) // fresh board

      drawFinalStroke(author, 'stroke-alpha', 0.3)
      drawFinalStroke(author, 'stroke-beta', 0.7)

      const now = Date.now()
      // A LIVE window (start within the clock-skew allowance): a live booking
      // reads reserved on the door but still admits joins — exactly the
      // behavior session 2 needs to walk in and read the board.
      const bookingRes = await fetch(`${BASE}/api/bookings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          roomId: ROOM,
          title: 'Persistence probe',
          booker: 'Mason',
          startsAt: now - 30_000,
          endsAt: now + 30 * 60_000,
        }),
      })
      expect(bookingRes.status).toBe(201)
      author.disconnect()
      await stopHard(first)

      // --- Session 2: a new process over the same file. ---------------------
      const second = startServer()
      await waitHealthy()
      const survivor = await connectPeer('Returner')

      // The join broadcast doubles as the door read: it must arrive carrying
      // the hydrated booking — reserved, in session, by title.
      const summary = await new Promise<SummaryBroadcast>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no room:summary within 10s')), 10_000)
        survivor.once('room:summary', (p: SummaryBroadcast) => {
          clearTimeout(timer)
          resolve(p)
        })
      })
      const door = summary.rooms.find((r) => r.id === ROOM)
      expect(door?.status).toBe('reserved')
      expect(door?.booking?.title).toBe('Persistence probe')
      expect(door?.booking?.live).toBe(true)

      // And the board comes back full: the join ack carries every stroke —
      // accepted because the booking window is live, not upcoming.
      const secondJoin = await joinBoardroom(survivor)
      const ids = secondJoin.strokes.map((s) => s.id)
      expect(ids).toContain('stroke-alpha')
      expect(ids).toContain('stroke-beta')
      expect(secondJoin.strokes.every((s) => s.final)).toBe(true)

      const listRes = await fetch(`${BASE}/api/bookings?roomId=${ROOM}`)
      expect(listRes.ok).toBe(true)
      const list = (await listRes.json()) as { bookings: { title: string }[] }
      expect(list.bookings.map((b) => b.title)).toContain('Persistence probe')

      survivor.disconnect()
      await stopHard(second)
    },
  )
})
