// First-run onboarding core: where the guided walk starts, the waypoints it
// teaches with, when a step counts as arrived, and how the completion record
// is stored. Pure on purpose — the component owns sockets, timers and React
// state; this module owns the meaning, and the tests pin the geometry.
import { AVATAR_COLORS, HAT_IDS, MAX_NAME_LENGTH, type AvatarProfile, type HatId } from './avatar-presets'
import type { Vec2 } from './world'

// localStorage key for the onboarding record: the styled profile plus when
// the walk completed. A returning visitor with a valid record skips straight
// into the world; a missing or corrupt one reads as a fresh visitor.
export const ONBOARDING_KEY = 'atrium.onboarding.v1'

export interface OnboardingRecord {
  profile: AvatarProfile
  completedAt: number
}

// The walk begins at the west end of the back sidewalk — the long way from
// the hall, so both lessons have room — and ends on the plaza in front of
// the hall's east face. Every point below stays clear of every door pad's
// click radius (the unit tests pin this): the walk must never join a room
// by accident, and the completion click must never fall on a door.
export const ONBOARDING_START: Vec2 = { x: 2.5, y: 11 }
export const WAYPOINT_KEYS: Vec2 = { x: 9, y: 11 }
export const HALL_TARGET: Vec2 = { x: 18.5, y: 10.8 }

// Arrival slack in world tiles: close enough to the ring that walking — not
// precision — is the lesson. A click that lands slightly off the ring still
// completes the step it was aiming at.
export const ARRIVE_RADIUS = 1.1

export interface WalkStep {
  target: Vec2
  hint: string
  ringLabel: string
}

// The teaching order: keys first on the open sidewalk, then click-to-move
// aimed at the hall. Arriving at HALL_TARGET completes the walk from any
// step — a visitor who click-walks straight there has learned enough.
export const WALK_STEPS: WalkStep[] = [
  { target: WAYPOINT_KEYS, hint: 'Use the arrow keys to walk to the glowing ring', ringLabel: 'Walk here' },
  { target: HALL_TARGET, hint: 'Now click anywhere on the street — walk to the Atrium hall', ringLabel: 'The Atrium hall' },
]

export function hasArrived(pos: Vec2, target: Vec2, radius = ARRIVE_RADIUS): boolean {
  return Math.hypot(target.x - pos.x, target.y - pos.y) <= radius
}

// Validate a stored record's shape. The server re-sanitizes every profile on
// presence:join — clients are never trusted — so this guards the render and
// the skip decision only: a blob with an unknown color or hat is treated as
// no record at all, sending that visitor back through onboarding.
export function parseOnboardingRecord(raw: string | null): OnboardingRecord | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const rec = parsed as Record<string, unknown>
  const profile = rec.profile
  if (typeof profile !== 'object' || profile === null) return null
  const p = profile as Record<string, unknown>
  if (typeof p.name !== 'string' || p.name.length === 0 || p.name.length > MAX_NAME_LENGTH) return null
  const color = p.color as string
  const hat = p.hat as HatId
  if (!(AVATAR_COLORS as readonly string[]).includes(color)) return null
  if (!(HAT_IDS as readonly string[]).includes(hat)) return null
  if (typeof rec.completedAt !== 'number' || !Number.isFinite(rec.completedAt)) return null
  return { profile: { name: p.name, color, hat }, completedAt: rec.completedAt }
}

// Storage is a parameter, not a global: tests use a Map-backed fake, the
// component passes window.localStorage.
export function readOnboardingRecord(store: Pick<Storage, 'getItem'> | null): OnboardingRecord | null {
  return parseOnboardingRecord(store?.getItem(ONBOARDING_KEY) ?? null)
}

export function writeOnboardingRecord(
  store: Pick<Storage, 'setItem'>,
  profile: AvatarProfile,
  completedAt: number,
): void {
  const record: OnboardingRecord = { profile, completedAt }
  store.setItem(ONBOARDING_KEY, JSON.stringify(record))
}
