import { describe, expect, it } from 'vitest'
import { AVATAR_COLORS } from '@/lib/avatar-presets'
import { dueForFlush, MAX_STROKE_POINTS, sanitizeStroke } from '@/lib/whiteboard'

const COLOR = AVATAR_COLORS[0]

function stroke(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'stroke-1',
    color: COLOR,
    width: 3,
    points: [
      { x: 0.1, y: 0.1 },
      { x: 0.5, y: 0.5 },
    ],
    final: true,
    ...overrides,
  }
}

describe('sanitizeStroke', () => {
  it('passes a well-formed stroke through', () => {
    const raw = stroke()
    const clean = sanitizeStroke(raw)
    expect(clean).not.toBeNull()
    expect(clean?.id).toBe('stroke-1')
    expect(clean?.final).toBe(true)
    expect(clean?.points).toHaveLength(2)
  })

  it('rejects garbage, bad colors, and empty geometry', () => {
    expect(sanitizeStroke(null)).toBeNull()
    expect(sanitizeStroke('stroke')).toBeNull()
    expect(sanitizeStroke(stroke({ color: 'chartreuse' }))).toBeNull()
    expect(sanitizeStroke(stroke({ points: [] }))).toBeNull()
    expect(sanitizeStroke(stroke({ points: [{ x: 'a', y: 0.5 }] }))).toBeNull()
    expect(sanitizeStroke(stroke({ points: [{ x: 0.5, y: Number.NaN }] }))).toBeNull()
  })

  it('clamps points into the board and caps the width', () => {
    const clean = sanitizeStroke(stroke({ width: 99, points: [{ x: -3, y: 1.5 }] }))
    expect(clean?.width).toBe(12)
    expect(clean?.points).toEqual([{ x: 0, y: 1 }])
  })

  it('truncates pathological strokes to the point ceiling instead of dropping them', () => {
    const points = Array.from({ length: MAX_STROKE_POINTS + 100 }, (_, i) => ({ x: i / 1000, y: 0.5 }))
    const clean = sanitizeStroke(stroke({ points }))
    expect(clean?.points).toHaveLength(MAX_STROKE_POINTS)
  })

  it('treats a missing final flag as an in-flight update', () => {
    const clean = sanitizeStroke(stroke({ final: undefined }))
    expect(clean?.final).toBe(false)
  })
})

describe('dueForFlush batching policy', () => {
  it('holds back under both bounds', () => {
    expect(dueForFlush(0, 5, 1_000, 1_200)).toBe(false)
  })

  it('flushes on the time window even with few points', () => {
    expect(dueForFlush(0, 2, 1_000, 1_500)).toBe(true)
  })

  it('flushes on the point ceiling even without time passing', () => {
    expect(dueForFlush(0, 25, 1_000, 1_000)).toBe(true)
  })

  it('never flushes what was already sent', () => {
    expect(dueForFlush(25, 25, 1_000, 9_000)).toBe(false)
  })
})
