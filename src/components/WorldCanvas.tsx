'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import JoinPanel from './JoinPanel'
import { drawWorld, screenDirToWorldDir, screenToIso, type AvatarDraw } from './world/renderer'
import { clampToWorld, SPAWN, stepToward, type Vec2 } from '@/lib/world'
import type { AvatarProfile } from '@/lib/avatar-presets'

const SPEED = 3.5 // world tiles per second

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
interface Sim {
  self: { pos: Vec2; render: Vec2; moving: boolean } | null
  keys: Set<string>
  clickTarget: Vec2 | null
  cam: Vec2
}

export default function WorldCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [profile, setProfile] = useState<AvatarProfile | null>(null)
  const profileRef = useRef<AvatarProfile | null>(null)
  const [roster, setRoster] = useState<RosterRow[]>([])
  const simRef = useRef<Sim>({
    self: null,
    keys: new Set(),
    clickTarget: null,
    cam: { ...SPAWN },
  })

  // Presence slice note: joining is local-only in this commit — the identity
  // picker exists so the renderer can be reviewed with a styled avatar.
  const handleJoin = useCallback((p: AvatarProfile) => {
    profileRef.current = p
    setProfile(p)
    simRef.current.self = {
      pos: { ...SPAWN },
      render: { ...SPAWN },
      moving: false,
    }
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
        // Local sim is immediate; the presence slice adds interpolation.
        self.render = { ...self.pos }
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
          ? { id: 'self', name: p.name, color: p.color, hat: p.hat, x: self.render.x, y: self.render.y, moving: self.moving, isSelf: true }
          : null
      drawWorld({ ctx, width, height, cam: sim.cam, time: now, self: selfDraw, peers: [] })
    }
    raf = requestAnimationFrame(loop)

    const rosterTimer = window.setInterval(() => {
      const s = simRef.current
      const p = profileRef.current
      setRoster(
        s.self && p
          ? [{ id: 'self', name: p.name, color: p.color, hat: p.hat, x: s.self.pos.x, y: s.self.pos.y }]
          : [],
      )
    }, 200)

    return () => {
      cancelAnimationFrame(raf)
      window.clearInterval(rosterTimer)
      window.removeEventListener('resize', resize)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      canvas.removeEventListener('click', onClick)
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
            <li key={r.id} data-testid={`peer-${r.name}`} data-x={r.x.toFixed(2)} data-y={r.y.toFixed(2)} className="flex items-center gap-2">
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
