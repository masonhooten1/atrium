'use client'

// The in-room whiteboard: a shared canvas surface for huddle zones and the
// boardroom. Strokes batch in flight — points accumulate locally and flush
// on a short timer while drawing — and whatever is unsent flushes on room
// exit (and on page unload), so leaving is never a loss. The server persists
// final strokes per room and re-serves them as history on the next join.
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { Socket } from 'socket.io-client'
import type { ClientToServerEvents, ServerToClientEvents } from '@/lib/protocol'
import {
  dueForFlush,
  sanitizeStroke,
  type StrokeData,
  type StrokePoint,
} from '@/lib/whiteboard'

type RoomSocket = Socket<ServerToClientEvents, ClientToServerEvents>

const STROKE_WIDTH = 3
// Skip pointer samples closer than this (normalized units) — dense event
// streams otherwise pile identical points onto the polyline.
const MIN_POINT_DISTANCE = 0.002

function drawStroke(ctx: CanvasRenderingContext2D, stroke: StrokeData, w: number, h: number): void {
  const pts = stroke.points
  if (pts.length === 0) return
  ctx.strokeStyle = stroke.color
  ctx.lineWidth = stroke.width
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(pts[0].x * w, pts[0].y * h)
  if (pts.length === 1) {
    // A tap is a dot, not an invisible zero-length path.
    ctx.lineTo(pts[0].x * w + 0.01, pts[0].y * h + 0.01)
  }
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x * w, pts[i].y * h)
  ctx.stroke()
}

export default function Whiteboard({
  socket,
  roomId,
  selfColor,
  initialStrokes,
  // Live strokes can outrun this component's mount (a room-mate drawing the
  // moment we join). WorldCanvas captures them at the socket level; we drain
  // the buffer here, then take over the sink — the same pattern as WebRTC
  // signaling in RoomView.
  whiteboardSink,
  pendingWhiteboard,
}: {
  socket: RoomSocket
  roomId: string
  selfColor: string
  initialStrokes: StrokeData[]
  whiteboardSink: MutableRefObject<((stroke: StrokeData) => void) | null>
  pendingWhiteboard: MutableRefObject<StrokeData[]>
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // Strokes live in a ref (the 60fps redraw path reads it); `version` bumps
  // schedule the redraws. In-flight batching state rides alongside.
  const strokesRef = useRef<Map<string, StrokeData>>(new Map(initialStrokes.map((s) => [s.id, s])))
  const inFlightRef = useRef<StrokeData | null>(null)
  const sentPointsRef = useRef(0)
  const lastFlushAtRef = useRef(0)
  const [version, setVersion] = useState(0)

  const redraw = useCallback((): void => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const { width: w, height: h } = canvas.getBoundingClientRect()
    if (w === 0 || h === 0) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    for (const stroke of strokesRef.current.values()) drawStroke(ctx, stroke, w, h)
    if (inFlightRef.current) drawStroke(ctx, inFlightRef.current, w, h)
  }, [])

  useEffect(() => {
    setVersion((v) => v + 1)
  }, [])

  useEffect(() => {
    redraw()
  }, [version, redraw])

  // Keep the backing store matched to the box through layout changes.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const observer = new ResizeObserver(() => redraw())
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [redraw])

  const applyRemote = useCallback(
    (stroke: StrokeData): void => {
      const clean = sanitizeStroke(stroke)
      if (!clean) return
      strokesRef.current.set(clean.id, clean)
      setVersion((v) => v + 1)
    },
    [],
  )

  // Drain strokes that arrived before mount, then own the sink.
  useEffect(() => {
    for (const stroke of pendingWhiteboard.current) applyRemote(stroke)
    pendingWhiteboard.current = []
    whiteboardSink.current = applyRemote
    return () => {
      whiteboardSink.current = null
    }
  }, [applyRemote, whiteboardSink, pendingWhiteboard])

  // Live relay from room-mates (the server never echoes our own strokes back).
  useEffect(() => {
    const onStroke = ({ roomId: rid, stroke }: { roomId: string; stroke: StrokeData }): void => {
      if (rid !== roomId) return
      applyRemote(stroke)
    }
    socket.on('whiteboard:stroke', onStroke)
    return () => {
      socket.off('whiteboard:stroke', onStroke)
    }
  }, [socket, roomId, applyRemote])

  const emit = useCallback(
    (stroke: StrokeData): void => {
      socket.emit('whiteboard:stroke', { roomId, stroke })
    },
    [socket, roomId],
  )

  // Send the in-flight stroke's unsent points; `final` ends its lifecycle.
  const flushInFlight = useCallback(
    (final: boolean): void => {
      const stroke = inFlightRef.current
      if (!stroke || stroke.points.length === 0) return
      emit({ ...stroke, points: [...stroke.points], final })
      sentPointsRef.current = stroke.points.length
      lastFlushAtRef.current = Date.now()
    },
    [emit],
  )

  const endStroke = useCallback((): void => {
    const stroke = inFlightRef.current
    inFlightRef.current = null
    if (!stroke || stroke.points.length === 0) return
    emit({ ...stroke, points: [...stroke.points], final: true })
    strokesRef.current.set(stroke.id, { ...stroke, final: true })
    setVersion((v) => v + 1)
  }, [emit])

  // Room exit flushes whatever drawing had not been sent yet.
  useEffect(() => {
    return () => {
      flushInFlight(true)
    }
  }, [flushInFlight])

  // And so does closing or refreshing the page mid-room: the send is a
  // synchronous websocket frame, which survives unload.
  useEffect(() => {
    const onBeforeUnload = (): void => flushInFlight(true)
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [flushInFlight])

  // While drawing, keep long strokes streaming even if the pointer pauses.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const stroke = inFlightRef.current
      if (!stroke) return
      const now = Date.now()
      if (dueForFlush(sentPointsRef.current, stroke.points.length, lastFlushAtRef.current, now)) {
        flushInFlight(false)
      }
    }, 250)
    return () => window.clearInterval(timer)
  }, [flushInFlight])

  const toPoint = (e: React.PointerEvent<HTMLCanvasElement>): StrokePoint => {
    const rect = e.currentTarget.getBoundingClientRect()
    const clamp = (v: number): number => Math.min(1, Math.max(0, v))
    return {
      x: clamp((e.clientX - rect.left) / rect.width),
      y: clamp((e.clientY - rect.top) / rect.height),
    }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (inFlightRef.current) return
    e.currentTarget.setPointerCapture(e.pointerId)
    inFlightRef.current = {
      id: crypto.randomUUID(),
      color: selfColor,
      width: STROKE_WIDTH,
      points: [toPoint(e)],
      final: false,
    }
    sentPointsRef.current = 0
    lastFlushAtRef.current = Date.now()
    redraw()
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const stroke = inFlightRef.current
    if (!stroke) return
    const pt = toPoint(e)
    const last = stroke.points[stroke.points.length - 1]
    if (last && Math.abs(last.x - pt.x) + Math.abs(last.y - pt.y) < MIN_POINT_DISTANCE) return
    stroke.points.push(pt)
    const now = Date.now()
    if (dueForFlush(sentPointsRef.current, stroke.points.length, lastFlushAtRef.current, now)) {
      flushInFlight(false)
    }
    redraw()
  }

  return (
    <div
      data-testid="whiteboard"
      className="rounded-xl border border-white/10 bg-slate-900/60 p-2"
    >
      <div className="mb-1 flex items-center justify-between px-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
          Whiteboard · saves for the next meeting
        </span>
      </div>
      <canvas
        ref={canvasRef}
        data-testid="whiteboard-canvas"
        className="aspect-[3/1] w-full touch-none rounded-lg bg-white/95"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endStroke}
        onPointerCancel={endStroke}
      />
    </div>
  )
}
