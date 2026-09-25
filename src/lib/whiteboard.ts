// Pure whiteboard stroke vocabulary shared by client and server. The server
// re-validates every stroke through sanitizeStroke — clients are never
// trusted with raw geometry, mirroring the sanitizeProfile discipline.
import { AVATAR_COLORS } from './avatar-presets'

export interface StrokePoint {
  x: number
  y: number
}

// One polyline in normalized coordinates (0..1 across the whiteboard
// surface, fixed aspect ratio box). In-flight strokes update by id —
// receivers replace the polyline wholesale — and `final` marks the version
// that gets persisted.
export interface StrokeData {
  id: string
  color: string
  width: number
  points: StrokePoint[]
  final: boolean
}

// Ceiling on points per stroke: the server truncates beyond this so one
// pathological stroke cannot balloon a row.
export const MAX_STROKE_POINTS = 400

// Client batching bounds: strokes accumulate in flight and flush when either
// bound trips — the time window or the point ceiling — so a long stroke
// streams live without a packet per point.
export const FLUSH_INTERVAL_MS = 500
export const FLUSH_MAX_POINTS = 25

// Should the in-flight stroke flush right now? Pure so the batching policy
// is unit-testable; `sentPoints` is how many of the stroke's points have
// already been sent.
export function dueForFlush(
  sentPoints: number,
  totalPoints: number,
  lastFlushAt: number,
  now: number,
  limits: { maxPoints?: number; maxMs?: number } = {},
): boolean {
  if (totalPoints <= sentPoints) return false
  const maxPoints = limits.maxPoints ?? FLUSH_MAX_POINTS
  const maxMs = limits.maxMs ?? FLUSH_INTERVAL_MS
  return totalPoints - sentPoints >= maxPoints || now - lastFlushAt >= maxMs
}

function sanitizePoint(raw: unknown): StrokePoint | null {
  if (typeof raw !== 'object' || raw === null) return null
  const p = raw as Record<string, unknown>
  if (typeof p.x !== 'number' || !Number.isFinite(p.x)) return null
  if (typeof p.y !== 'number' || !Number.isFinite(p.y)) return null
  const clamp = (v: number): number => Math.min(1, Math.max(0, v))
  return { x: clamp(p.x), y: clamp(p.y) }
}

// Server-side gate for both the socket event and (belt and braces) the relay
// a client receives. Returns null for anything malformed — a bad stroke is
// dropped, never coerced into geometry we did not see.
export function sanitizeStroke(input: unknown): StrokeData | null {
  if (typeof input !== 'object' || input === null) return null
  const raw = input as Record<string, unknown>

  const id = typeof raw.id === 'string' ? raw.id.trim().slice(0, 64) : ''
  if (!id) return null

  // Strokes draw in the author's avatar color — the palette is the check.
  if (!(AVATAR_COLORS as readonly string[]).includes(raw.color as string)) return null

  if (typeof raw.width !== 'number' || !Number.isFinite(raw.width)) return null
  const width = Math.min(12, Math.max(1, raw.width))

  if (!Array.isArray(raw.points)) return null
  const points = raw.points
    .slice(0, MAX_STROKE_POINTS)
    .map(sanitizePoint)
    .filter((p): p is StrokePoint => p !== null)
  if (points.length === 0) return null

  return { id, color: raw.color as string, width, points, final: raw.final === true }
}
