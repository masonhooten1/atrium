// The guided walk's pure core: pin the geometry the e2e depends on (the walk
// must never join a room by accident and must end at the hall), the arrival
// check, and the storage record contract.
import { describe, expect, it } from 'vitest'
import { doorNear, ROOMS } from '../src/lib/rooms'
import { WALK_BOUNDS } from '../src/lib/world'
import {
  ARRIVE_RADIUS,
  HALL_TARGET,
  ONBOARDING_KEY,
  ONBOARDING_START,
  WALK_STEPS,
  hasArrived,
  parseOnboardingRecord,
  readOnboardingRecord,
  writeOnboardingRecord,
} from '../src/lib/onboarding'

describe('walk geometry', () => {
  it('keeps every walk point inside the walkable bounds', () => {
    for (const p of [ONBOARDING_START, ...WALK_STEPS.map((s) => s.target)]) {
      expect(p.x).toBeGreaterThanOrEqual(WALK_BOUNDS.minX)
      expect(p.x).toBeLessThanOrEqual(WALK_BOUNDS.maxX)
      expect(p.y).toBeGreaterThanOrEqual(WALK_BOUNDS.minY)
      expect(p.y).toBeLessThanOrEqual(WALK_BOUNDS.maxY)
    }
  })

  it('keeps walk points clear of every door pad click radius', () => {
    // ONBOARDING_START guards the join moment (a stray click must not join a
    // room); the targets guard the lesson clicks (a ring click must walk,
    // never join).
    for (const p of [ONBOARDING_START, ...WALK_STEPS.map((s) => s.target)]) {
      expect(doorNear(ROOMS, p), `point ${p.x},${p.y} sits on a door pad`).toBeNull()
    }
  })

  it('teaches keys first and ends at the hall', () => {
    expect(WALK_STEPS.length).toBeGreaterThanOrEqual(2)
    expect(WALK_STEPS[0].target).toEqual({ x: 9, y: 11 })
    const last = WALK_STEPS[WALK_STEPS.length - 1]
    expect(last.target).toEqual(HALL_TARGET)
  })
})

describe('hasArrived', () => {
  it('arrives at the target, inside the radius, and not outside it', () => {
    expect(hasArrived(HALL_TARGET, HALL_TARGET)).toBe(true)
    expect(hasArrived({ x: HALL_TARGET.x + ARRIVE_RADIUS - 0.01, y: HALL_TARGET.y }, HALL_TARGET)).toBe(true)
    expect(hasArrived({ x: HALL_TARGET.x + ARRIVE_RADIUS + 0.01, y: HALL_TARGET.y }, HALL_TARGET)).toBe(false)
  })
})

// Minimal Storage stand-in over a Map — the record API takes the store as a
// parameter, so tests never need a DOM.
function fakeStorage(): { store: Map<string, string>; getItem(k: string): string | null; setItem(k: string, v: string): void } {
  const store = new Map<string, string>()
  return {
    store,
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, v),
  }
}

describe('onboarding record', () => {
  const profile = { name: 'Pilot', color: '#a78bfa', hat: 'crown' as const }

  it('round-trips a completed walk', () => {
    const storage = fakeStorage()
    writeOnboardingRecord(storage, profile, 1_725_000_000_000)
    expect(storage.store.get(ONBOARDING_KEY)).toContain('"name":"Pilot"')
    const record = readOnboardingRecord(storage)
    expect(record).toEqual({ profile, completedAt: 1_725_000_000_000 })
  })

  it('reads absence, corruption and shape errors as no record', () => {
    expect(readOnboardingRecord(null)).toBeNull()
    expect(readOnboardingRecord(fakeStorage())).toBeNull()
    expect(parseOnboardingRecord('not json at all')).toBeNull()
    expect(parseOnboardingRecord('42')).toBeNull()
    expect(parseOnboardingRecord(JSON.stringify({ profile: { name: 'P', color: 'nope', hat: 'cap' }, completedAt: 1 }))).toBeNull()
    expect(parseOnboardingRecord(JSON.stringify({ profile: { name: 'P', color: '#a78bfa', hat: 'sombrero' }, completedAt: 1 }))).toBeNull()
    expect(parseOnboardingRecord(JSON.stringify({ profile: { name: '', color: '#a78bfa', hat: 'cap' }, completedAt: 1 }))).toBeNull()
    expect(parseOnboardingRecord(JSON.stringify({ profile: { name: 'x'.repeat(25), color: '#a78bfa', hat: 'cap' }, completedAt: 1 }))).toBeNull()
    expect(parseOnboardingRecord(JSON.stringify({ profile, completedAt: 'yesterday' }))).toBeNull()
  })
})
