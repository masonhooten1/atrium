'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import JoinPanel from './JoinPanel'
import RoomView, { type ActiveRoom } from './RoomView'
import { drawWorld, screenDirToWorldDir, screenToIso, type AvatarDraw, type DoorDraw } from './world/renderer'
import { clampToWorld, SPAWN, stepToward, type Vec2 } from '@/lib/world'
import { removePeer, snapshot, upsertPeer, newPeerBook, type PeerBook } from '@/lib/presence'
import { doorNear, peerNear, zoneAt, ROOMS } from '@/lib/rooms'
import type { JoinAck, PodInviteAck, PodInviteOutcome, RoomJoinAck, RoomSummary, WebRTCPacket } from '@/lib/protocol'
import type { StrokeData } from '@/lib/whiteboard'
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
  // Huddle zone the avatar currently stands in (zone id or null) — change
  // detection lives in the loop so React state only flips on transitions.
  zoneId: string | null
}

export default function WorldCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const socketRef = useRef<Socket | null>(null)
  // WebRTC signaling is captured at the socket level from the moment the
  // transport exists — a relayed offer can outrun RoomView's mount, and
  // socket.io drops events nobody is listening for.
  const signalSinkRef = useRef<((p: WebRTCPacket) => void) | null>(null)
  const pendingSignalsRef = useRef<WebRTCPacket[]>([])
  // Whiteboard strokes get the same capture: a room-mate can be drawing the
  // moment we join, before the room view mounts.
  const whiteboardSinkRef = useRef<((stroke: StrokeData) => void) | null>(null)
  const pendingWhiteboardRef = useRef<StrokeData[]>([])
  const [profile, setProfile] = useState<AvatarProfile | null>(null)
  const profileRef = useRef<AvatarProfile | null>(null)
  const [roster, setRoster] = useState<RosterRow[]>([])
  const [rooms, setRooms] = useState<RoomSummary[]>([])
  const [activeRoom, setActiveRoom] = useState<ActiveRoom | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [zoneOffer, setZoneOffer] = useState<string | null>(null)
  // Grab-gesture surface: an incoming invite to answer and our own invite
  // awaiting an answer. Refs mirror both for the socket handlers, which are
  // registered once and would otherwise read stale state.
  const [incoming, setIncoming] = useState<{ inviteId: string; fromName: string } | null>(null)
  const [pendingInvite, setPendingInvite] = useState<{ inviteId: string; targetName: string } | null>(null)
  const incomingRef = useRef<{ inviteId: string; fromName: string } | null>(null)
  const pendingInviteRef = useRef<{ inviteId: string; targetName: string } | null>(null)
  // Refs mirror the state the canvas loop and socket callbacks read without
  // re-subscribing: door summaries, and the room we are currently inside.
  const roomsRef = useRef<RoomSummary[]>([])
  const activeRoomRef = useRef<ActiveRoom | null>(null)
  const simRef = useRef<Sim>({
    self: null,
    keys: new Set(),
    clickTarget: null,
    cam: { ...SPAWN },
    book: newPeerBook(),
    renders: new Map(),
    zoneId: null,
  })

  // Join presence: the ack is the truth — the server places us at spawn and
  // answers with the world as it is. Also the recovery path after a reconnect,
  // when the server has dropped our old incarnation and its id changed.
  const joinPresence = useCallback((socket: Socket) => {
    const p = profileRef.current
    if (!p) return
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

  // Ask the server for a seat. The ack is the truth: a refusal shows on the
  // door as a toast, never as a silent failure — and after a reconnect it
  // drops the stale room view instead.
  const requestRoomJoin = useCallback((roomId: string, onRefused?: () => void) => {
    socketRef.current?.emit('room:join', { roomId }, (ack: RoomJoinAck) => {
      if (!ack.ok) {
        onRefused?.()
        const summary = roomsRef.current.find((r) => r.id === roomId)
        const name = summary?.name ?? roomId
        setToast(
          ack.reason === 'full'
            ? `${name} is full (${summary?.capacity ?? '?'} seats taken).`
            : ack.reason === 'reserved'
              ? `${name} is reserved for an upcoming meeting.`
              : `${name} is not open yet.`,
        )
        return
      }
      activeRoomRef.current = {
        id: ack.room.id,
        name: ack.room.name,
        kind: ack.room.kind,
        capacity: ack.room.capacity,
        peers: ack.peers,
        strokes: ack.strokes,
      }
      setActiveRoom(activeRoomRef.current)
      setZoneOffer(null)
    })
  }, [])

  // Send the grab gesture: invite a nearby avatar into a fresh pod. The ack
  // is the truth about why nothing happened — refusals surface as toasts,
  // never silence.
  const invitePeer = useCallback((targetId: string, targetName: string) => {
    socketRef.current?.emit('pod:invite', { targetId }, (ack: PodInviteAck) => {
      if (!ack.ok) {
        setToast(
          ack.reason === 'range'
            ? `Walk closer to ${targetName} to grab a pod.`
            : ack.reason === 'outstanding'
              ? 'You already have a pod invite out.'
              : ack.reason === 'busy'
                ? `${targetName} is in a room right now.`
                : `${targetName} is not on the street right now.`,
        )
        return
      }
      const pending = { inviteId: ack.inviteId, targetName }
      pendingInviteRef.current = pending
      setPendingInvite(pending)
    })
  }, [])

  const handleJoin = useCallback((p: AvatarProfile) => {
    profileRef.current = p
    setProfile(p)

    // Bring the transport up (or reuse it after a reconnect) and join the
    // street. WebSocket-only: the polling fallback's upgrade churn under load
    // is the one transport failure the street cannot survive gracefully.
    let socket = socketRef.current
    if (!socket) {
      socket = io(undefined, { transports: ['websocket'] })
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
      socket.on('room:summary', ({ rooms: summaries }) => {
        roomsRef.current = summaries
        setRooms(summaries)
      })
      socket.on('room:peer', ({ roomId, peer, kind }) => {
        // Membership updates for the room we are inside: the tiles follow.
        setActiveRoom((cur) => {
          if (!cur || cur.id !== roomId) return cur
          if (kind === 'joined' && !cur.peers.some((p) => p.id === peer.id)) {
            return { ...cur, peers: [...cur.peers, peer] }
          }
          if (kind === 'left') return { ...cur, peers: cur.peers.filter((p) => p.id !== peer.id) }
          return cur
        })
      })
      socket.on('room:webrtc', (p) => {
        // Dispatch to the room view when it is listening; otherwise hold the
        // packet for the drain when the view mounts.
        if (signalSinkRef.current) signalSinkRef.current(p)
        else pendingSignalsRef.current.push(p)
      })
      socket.on('whiteboard:stroke', ({ roomId, stroke }) => {
        if (activeRoomRef.current?.id !== roomId) return
        if (whiteboardSinkRef.current) whiteboardSinkRef.current(stroke)
        else pendingWhiteboardRef.current.push(stroke)
      })
      socket.on('pod:incoming', ({ inviteId, from }) => {
        const next = { inviteId, fromName: from.name }
        incomingRef.current = next
        setIncoming(next)
      })
      socket.on('pod:resolved', ({ inviteId, outcome, pod }) => {
        // Capture who this was about before clearing — the toast names the no.
        // (Only the inviter ever sees 'declined'; the target is the decliner.)
        const pending = pendingInviteRef.current
        const pendingName = pending && pending.inviteId === inviteId ? pending.targetName : null
        incomingRef.current = null
        setIncoming(null)
        pendingInviteRef.current = null
        setPendingInvite(null)
        if (outcome === 'accepted' && pod) {
          // The server teleported us: snap our avatar to the pod and open the
          // room through the same seat-claiming path as a door.
          const sim = simRef.current
          if (sim.self) {
            sim.self.pos = { ...pod.pos }
            sim.self.render = { ...pod.pos }
            sim.clickTarget = null
          }
          requestRoomJoin(pod.roomId)
          return
        }
        // Nothing materializes on a no: name the no so it is not silence.
        if (outcome === 'declined') setToast(`${pendingName ?? 'They'} declined the pod invite.`)
        else if (outcome === 'expired') setToast('The pod invite expired — nothing was opened.')
        else if (outcome === 'unavailable') setToast('The pod invite fell through — someone stepped into a room.')
      })
      socket.on('connect', () => {
        // A reconnect hands us a new socket id, and the server has already
        // dropped the old incarnation: rebuild presence from a fresh join and
        // re-claim the seat in any room we were holding.
        const sock = socketRef.current
        if (!sock || !profileRef.current) return
        const sim = simRef.current
        sim.book.peers.clear()
        sim.renders.clear()
        sim.self = null
        joinPresence(sock)
        const room = activeRoomRef.current
        if (room) {
          requestRoomJoin(room.id, () => {
            // Someone took the seat while we were gone — back to the street.
            activeRoomRef.current = null
            setActiveRoom(null)
          })
        }
      })
    }

    joinPresence(socket)
  }, [joinPresence, requestRoomJoin])

  // Door-click entry: one room at a time, the same arbitration path a
  // reconnect uses.
  const joinRoomById = useCallback(
    (roomId: string) => {
      if (activeRoomRef.current) return
      requestRoomJoin(roomId)
    },
    [requestRoomJoin],
  )

  const leaveRoomById = useCallback((roomId: string) => {
    socketRef.current?.emit('room:leave', { roomId })
    activeRoomRef.current = null
    setActiveRoom(null)
  }, [])

  // Refusal toasts fade — they mark a moment, not a state.
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 3500)
    return () => window.clearTimeout(timer)
  }, [toast])

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
      const worldPt = screenToIso({
        x: e.clientX - rect.left - width / 2,
        y: e.clientY - rect.top - height / 2,
      })
      const world = clampToWorld({ x: worldPt.x + sim.cam.x, y: worldPt.y + sim.cam.y })
      // A click on a door pad is a join request, not a walk target. Refusals
      // come back on the ack and surface as a toast.
      const door = doorNear(ROOMS, world)
      if (door) {
        if (!door.joinable) {
          setToast(`${door.name} is a layout stub for now — not open yet.`)
          return
        }
        joinRoomById(door.id)
        return
      }
      // Clicking an avatar is the grab gesture: invite them into a fresh pod.
      // Picking runs on the eased render positions — what is actually drawn —
      // while the server re-checks range against authoritative positions.
      const hit = peerNear(
        snapshot(sim.book).map((info) => {
          const r = sim.renders.get(info.id) ?? { x: info.x, y: info.y }
          return { id: info.id, name: info.name, x: r.x, y: r.y }
        }),
        world,
      )
      if (hit) {
        if (activeRoomRef.current) return
        invitePeer(hit.id, hit.name)
        return
      }
      sim.clickTarget = world
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

      // Huddle zones are doors that follow you: standing inside one raises
      // the join affordance for that zone's pod.
      const zone = self ? zoneAt(ROOMS, self.pos) : null
      if ((zone?.id ?? null) !== sim.zoneId) {
        sim.zoneId = zone?.id ?? null
        setZoneOffer(zone?.id ?? null)
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
      // Door pads and labels read the latest summary; positions come from the
      // static room defs so pads render even before the first snapshot.
      const summaryById = new Map(roomsRef.current.map((r) => [r.id, r]))
      const doors: DoorDraw[] = ROOMS.map((def) => {
        const summary = summaryById.get(def.id)
        const booking = summary?.booking ?? null
        return {
          roomId: def.id,
          kind: def.kind,
          x: def.door.x,
          y: def.door.y,
          label: def.name,
          status: summary?.status ?? 'open',
          occupancy: summary?.occupancy ?? 0,
          capacity: def.capacity,
          bookingLabel: booking
            ? `${booking.live ? 'Now' : 'Next'}: ${booking.title} ${new Date(booking.startsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
            : null,
        }
      })
      // Spawned pods materialize on the street: a booth and pad at their
      // landing spot, rendered from the summary like any other door.
      for (const s of roomsRef.current) {
        if (!s.door || ROOMS.some((def) => def.id === s.id)) continue
        doors.push({
          roomId: s.id,
          kind: s.kind,
          x: s.door.x,
          y: s.door.y,
          label: s.name,
          status: s.status,
          occupancy: s.occupancy,
          capacity: s.capacity,
          bookingLabel: null,
        })
      }
      drawWorld({ ctx, width, height, cam: sim.cam, time: now, self: selfDraw, peers: peerDraws, doors })
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
    // joinRoomById and invitePeer are stable useCallbacks; the sim is a ref.
    // The effect subscribes once for the lifetime of the component.
  }, [joinRoomById, invitePeer])

  // The doors panel: static rooms plus any pod the grab gesture spawned —
  // spawned rows ride their summary (name, capacity, joinable) while alive.
  const doorRows = [
    ...ROOMS.map((def) => ({ id: def.id, name: def.name, capacity: def.capacity, joinable: def.joinable })),
    ...rooms
      .filter((r) => r.door && !ROOMS.some((def) => def.id === r.id))
      .map((r) => ({ id: r.id, name: r.name, capacity: r.capacity, joinable: r.joinable })),
  ]

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

      {/* Doors read the live summary — open/full with occupancy, reserved with
          the next booking, or a stub until its slice lands. Clicking a row is
          a convenience twin of clicking the pad on the canvas. */}
      <aside
        data-testid="doors"
        className="absolute right-4 top-40 z-10 w-60 rounded-xl border border-white/10 bg-slate-900/80 px-4 py-3 text-sm backdrop-blur"
      >
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Doors</div>
        <ul className="mt-2 space-y-1.5">
          {doorRows.map((row) => {
            const summary = rooms.find((r) => r.id === row.id)
            const status = summary?.status ?? 'open'
            return (
              <li key={row.id}>
                <button
                  type="button"
                  data-testid={`door-${row.id}`}
                  onClick={() => joinRoomById(row.id)}
                  className="w-full rounded-lg px-2 py-1 text-left hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={!row.joinable || !!activeRoom}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-slate-100">{row.name}</span>
                    <span
                      className={`text-[10px] font-semibold uppercase ${
                        status === 'full'
                          ? 'text-rose-300'
                          : status === 'reserved'
                            ? 'text-amber-300'
                            : 'text-emerald-300'
                      }`}
                    >
                      {status} {summary ? `${summary.occupancy}/${row.capacity}` : `0/${row.capacity}`}
                    </span>
                  </span>
                  {summary?.booking ? (
                    <span className="block text-[10px] text-amber-200/80">
                      {summary.booking.live ? 'Now' : 'Next'}: {summary.booking.title} ·{' '}
                      {new Date(summary.booking.startsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  ) : null}
                </button>
              </li>
            )
          })}
        </ul>
      </aside>

      {/* Huddle zones are doors that follow you — a chip, not a fixed place. */}
      {zoneOffer && !activeRoom ? (
        <div
          data-testid="zone-offer"
          className="absolute bottom-6 left-1/2 z-20 flex -translate-x-1/2 items-center gap-3 rounded-full border border-emerald-400/40 bg-slate-900/90 px-4 py-2 text-sm text-slate-100 shadow-lg"
        >
          <span>Huddle zone — join {ROOMS.find((r) => r.id === zoneOffer)?.name}?</span>
          <button
            type="button"
            data-testid="zone-join"
            onClick={() => joinRoomById(zoneOffer)}
            className="rounded-full bg-emerald-500 px-3 py-1 text-xs font-semibold text-slate-950 hover:bg-emerald-400"
          >
            Join
          </button>
        </div>
      ) : null}

      {/* The grab gesture's two chips: an invite to answer, and our own invite
          awaiting an answer. Neither materializes anything on its own. */}
      {incoming && !activeRoom ? (
        <div
          data-testid="pod-incoming"
          className="absolute bottom-24 left-1/2 z-30 flex -translate-x-1/2 items-center gap-3 rounded-full border border-sky-400/40 bg-slate-900/90 px-4 py-2 text-sm text-slate-100 shadow-lg"
        >
          <span>{incoming.fromName} wants to grab a pod with you</span>
          <button
            type="button"
            data-testid="pod-accept"
            onClick={() => {
              const inviteId = incoming.inviteId
              incomingRef.current = null
              setIncoming(null)
              socketRef.current?.emit(
                'pod:invite:respond',
                { inviteId, accept: true },
                (ack: { ok: true; outcome: PodInviteOutcome } | { ok: false; reason: 'unknown' | 'not-target' }) => {
                  if (!ack.ok) setToast('That pod invite is no longer there.')
                },
              )
            }}
            className="rounded-full bg-sky-500 px-3 py-1 text-xs font-semibold text-slate-950 hover:bg-sky-400"
          >
            Accept
          </button>
          <button
            type="button"
            data-testid="pod-decline"
            onClick={() => {
              const inviteId = incoming.inviteId
              incomingRef.current = null
              setIncoming(null)
              // The ack is not decoration: the server refuses unacked
              // responds outright, so a bare emit would leave the inviter
              // waiting out the full 30 s expiry on a no that already
              // happened.
              socketRef.current?.emit(
                'pod:invite:respond',
                { inviteId, accept: false },
                (ack: { ok: true; outcome: PodInviteOutcome } | { ok: false; reason: 'unknown' | 'not-target' }) => {
                  if (!ack.ok) setToast('That pod invite is no longer there.')
                },
              )
            }}
            className="rounded-full border border-slate-500 px-3 py-1 text-xs font-semibold text-slate-200 hover:bg-white/5"
          >
            Decline
          </button>
        </div>
      ) : null}
      {pendingInvite && !activeRoom ? (
        <div
          data-testid="pod-pending"
          className="absolute bottom-40 left-1/2 z-20 -translate-x-1/2 rounded-full border border-white/10 bg-slate-900/80 px-4 py-2 text-sm text-slate-300 shadow-lg"
        >
          Waiting for {pendingInvite.targetName} to answer…
        </div>
      ) : null}

      {toast ? (
        <div
          data-testid="door-toast"
          role="status"
          className="absolute left-1/2 top-16 z-40 -translate-x-1/2 rounded-lg border border-rose-400/40 bg-slate-900/95 px-4 py-2 text-sm text-rose-100 shadow-lg"
        >
          {toast}
        </div>
      ) : null}

      {activeRoom && socketRef.current ? (
        <RoomView
          socket={socketRef.current}
          selfName={profile?.name ?? ''}
          selfColor={profile?.color ?? '#f26d6d'}
          room={activeRoom}
          onLeave={() => leaveRoomById(activeRoom.id)}
          signalSink={signalSinkRef}
          pendingSignals={pendingSignalsRef}
          whiteboardSink={whiteboardSinkRef}
          pendingWhiteboard={pendingWhiteboardRef}
        />
      ) : null}

      {!profile && <JoinPanel onJoin={handleJoin} />}
    </div>
  )
}