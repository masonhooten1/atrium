'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import JoinPanel from './JoinPanel'
import { drawWorld, screenDirToWorldDir, screenToIso, type AvatarDraw } from './world/renderer'
import { clampToWorld, SPAWN, stepToward, type Vec2 } from '@/lib/world'
import { removePeer, snapshot, upsertPeer, newPeerBook, type PeerBook } from '@/lib/presence'
import type { JoinAck } from '@/lib/protocol'
import type { AvatarProfile } from '@/lib/avatar-presets'

const SPEED = 3.5 // world tiles per second
const MOVE_SEND_MS = 1000 / 15 // client-side send throttle, ~15 Hz

interface RosterRow {
  id: string
  name: string
  color: string
  hat: string
  x: number
  y: number
}

// Mutable sim state lives in refs — the render loop touches it at 60 fps;
// React state is only used for the join panel and the presence roster.
// `book` holds authoritative peer state; `renders` holds client-side easing
// positions keyed by peer id — animation data stays out of the pure state.
interface Sim {
  self: { id: string; pos: Vec2; render: Vec2; moving: boolean } | null
  keys: Set<string>
  clickTarget: Vec2 | null
  cam: Vec2
  book: PeerBook
  renders: Map<string, Vec2>
}

export default function WorldCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const socketRef = useRef<Socket | null>(null)
  const [profile, setProfile] = useState<AvatarProfile | null>(null)
  const profileRef = useRef<AvatarProfile | null>(null)
  const [roster, setRoster] = useState<RosterRow[]>([])
  const simRef = useRef<Sim>({
    self: null,
    keys: new Set(),
    clickTarget: null,
    cam: { ...SPAWN },
    book: newPeerBook(),
    renders: new Map(),
  })

  const handleJoin = useCallback((p: AvatarProfile) => {
    profileRef.current = p
    setProfile(p)

    // Bring the transport up (or reuse it after a reconnect) and join the
    // street. The server places us at spawn and answers with the world.
    let socket = socketRef.current
    if (!socket) {
      socket = io()
      socketRef.current = socket
      const sim = simRef.current
      socket.on('presence:state', ({ peers }) => {
        // Full snapshot on (re)connect: replaces everything we knew.
        sim.book.peers.clear()
        sim.renders.clear()
        const selfId = sim.self?.id
        for (const peer of peers) {
          if (selfId && peer.id === selfId) continue
          upsertPeer(sim.book, peer)
          sim.renders.set(peer.id, { x: peer.x, y: peer.y })
        }
      })
      socket.on('presence:peer', ({ peer, kind }) => {
        if (sim.self && peer.id === sim.self.id) return
        if (kind === 'left') {
          removePeer(sim.book, peer.id)
          sim.renders.delete(peer.id)
        } else {
          if (!sim.renders.has(peer.id)) sim.renders.set(peer.id, { x: peer.x, y: peer.y })
          upsertPeer(sim.book, peer)
        }
      })
    }

    socket.emit('presence:join', p, (ack: JoinAck) => {
      if (!ack.ok) return
      simRef.current.self = {
        id: ack.self.id,
        pos: { x: ack.self.x, y: ack.self.y },
        render: { x: ack.self.x, y: ack.self.y },
        moving: false,
      }
      simRef.current.cam = { x: ack.self.x, y: ack.self.y }
      simRef.current.book.peers.clear()
      simRef.current.renders.clear()
      for (const peer of ack.peers) {
        if (peer.id === ack.self.id) continue
        upsertPeer(simRef.current.book, peer)
        simRef.current.renders.set(peer.id, { x: peer.x, y: peer.y })
      }
    })
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const sim = simRef.current

    let width = window.innerWidth
    let height = window.innerHeight
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const resize = (): void => {
      width = window.innerWidth
      height = window.innerHeight
      canvas.width = width * dpr
      canvas.height = height * dpr
    }
    resize()
    window.addEventListener('resize', resize)

    const onKeyDown = (e: KeyboardEvent): void => {
      if (!e.key.startsWith('Arrow')) return
      if (sim.self) e.preventDefault()
      sim.keys.add(e.key)
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      sim.keys.delete(e.key)
    }
    const onBlur = (): void => {
      sim.keys.clear()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)

    const onClick = (e: MouseEvent): void => {
      const rect = canvas.getBoundingClientRect()
      const rel = screenToIso({
        x: e.clientX - rect.left - width / 2,
        y: e.clientY - rect.top - height / 2,
      })
      sim.clickTarget = clampToWorld({ x: rel.x + sim.cam.x, y: rel.y + sim.cam.y })
    }
    canvas.addEventListener('click', onClick)

    let raf = 0
    let last = performance.now()
    let lastSent = { x: Number.NaN, y: Number.NaN }
    let lastSendAt = 0
    const loop = (now: number): void => {
      raf = requestAnimationFrame(loop)
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now

      const self = sim.self
      if (self) {
        const ix = (sim.keys.has('ArrowRight') ? 1 : 0) - (sim.keys.has('ArrowLeft') ? 1 : 0)
        const iy = (sim.keys.has('ArrowDown') ? 1 : 0) - (sim.keys.has('ArrowUp') ? 1 : 0)
        if (ix !== 0 || iy !== 0) {
          // Arrow keys win over any pending click target.
          sim.clickTarget = null
          const dir = screenDirToWorldDir({ x: ix, y: iy })
          self.pos = clampToWorld({
            x: self.pos.x + dir.x * SPEED * dt,
            y: self.pos.y + dir.y * SPEED * dt,
          })
          self.moving = true
        } else if (sim.clickTarget) {
          const before = self.pos
          self.pos = clampToWorld(stepToward(self.pos, sim.clickTarget, SPEED, dt))
          self.moving = self.pos.x !== before.x || self.pos.y !== before.y
          if (self.pos.x === sim.clickTarget.x && self.pos.y === sim.clickTarget.y) {
            sim.clickTarget = null
          }
        } else {
          self.moving = false
        }
        // Local sim is immediate; peers arrive from the server and ease.
        self.render = { ...self.pos }

        // Send our position at most ~15 Hz, only when it changed.
        if (now - lastSendAt >= MOVE_SEND_MS && (self.pos.x !== lastSent.x || self.pos.y !== lastSent.y)) {
          lastSendAt = now
          lastSent = { x: self.pos.x, y: self.pos.y }
          socketRef.current?.emit('presence:move', { x: self.pos.x, y: self.pos.y })
        }
      }

      // Peers ease toward their last server-known position.
      const peerEase = Math.min(1, 10 * dt)
      for (const [id, r] of sim.renders) {
        const info = sim.book.peers.get(id)
        if (!info) continue
        r.x += (info.x - r.x) * peerEase
        r.y += (info.y - r.y) * peerEase
      }

      // Camera eases toward the self avatar — the parallax depth feel.
      const camTarget = self ? self.render : SPAWN
      sim.cam = {
        x: sim.cam.x + (camTarget.x - sim.cam.x) * Math.min(1, dt * 4),
        y: sim.cam.y + (camTarget.y - sim.cam.y) * Math.min(1, dt * 4),
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const p = profileRef.current
      const selfDraw: AvatarDraw | null =
        self && p
          ? { id: self.id, name: p.name, color: p.color, hat: p.hat, x: self.render.x, y: self.render.y, moving: self.moving, isSelf: true }
          : null
      const peerDraws: AvatarDraw[] = snapshot(sim.book).map((info) => {
        const r = sim.renders.get(info.id) ?? { x: info.x, y: info.y }
        return {
          id: info.id,
          name: info.name,
          color: info.color,
          hat: info.hat,
          x: r.x,
          y: r.y,
          moving: Math.abs(r.x - info.x) + Math.abs(r.y - info.y) > 0.05,
          isSelf: false,
        }
      })
      drawWorld({ ctx, width, height, cam: sim.cam, time: now, self: selfDraw, peers: peerDraws })
    }
    raf = requestAnimationFrame(loop)

    const rosterTimer = window.setInterval(() => {
      const s = simRef.current
      const p = profileRef.current
      const rows: RosterRow[] =
        s.self && p ? [{ id: s.self.id, name: p.name, color: p.color, hat: p.hat, x: s.self.pos.x, y: s.self.pos.y }] : []
      for (const info of snapshot(s.book)) {
        rows.push({ id: info.id, name: info.name, color: info.color, hat: info.hat, x: info.x, y: info.y })
      }
      setRoster(rows)
    }, 200)

    return () => {
      cancelAnimationFrame(raf)
      window.clearInterval(rosterTimer)
      window.removeEventListener('resize', resize)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      canvas.removeEventListener('click', onClick)
      socketRef.current?.disconnect()
      socketRef.current = null
    }
  }, [])

  return (
    <div className="relative h-screen w-screen overflow-hidden">
      <canvas ref={canvasRef} data-testid="world-canvas" className="absolute inset-0 h-full w-full" />

      <header className="pointer-events-none absolute left-4 top-4 z-10">
        <h1 className="text-xl font-bold tracking-tight text-white">Atrium</h1>
        <p className="text-xs text-slate-400">One street, coming online.</p>
      </header>

      <aside
        data-testid="roster"
        className="absolute right-4 top-4 z-10 rounded-xl border border-white/10 bg-slate-900/80 px-4 py-3 text-sm backdrop-blur"
      >
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          On the street · {roster.length}
        </div>
        <ul className="mt-2 space-y-1">
          {roster.map((r) => (
            <li
              key={r.id}
              data-testid={`peer-${r.name}`}
              data-x={r.x.toFixed(2)}
              data-y={r.y.toFixed(2)}
              className="flex items-center gap-2"
            >
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: r.color }} />
              <span className="text-slate-100">
                {r.name} · {r.hat}
              </span>
            </li>
          ))}
        </ul>
      </aside>

      {!profile && <JoinPanel onJoin={handleJoin} />}
    </div>
  )
}