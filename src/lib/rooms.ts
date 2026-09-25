// The meeting continuum on the street: room definitions and pure lookups.
// Positions are world tiles (see world.ts). The v1 map per the build spec:
// two phone-booth pods, two walk-in huddle zones, a boardroom door on the
// hall, and an amphitheater stage kept as a layout stub (not bookable yet).
import { clampToWorld, type Vec2 } from './world'

export type RoomKind = 'pod' | 'huddle' | 'boardroom' | 'stage'

export interface RoomZone {
  x: number
  y: number
  w: number
  d: number
}

export interface RoomDef {
  id: string
  kind: RoomKind
  name: string
  capacity: number
  joinable: boolean
  // Dynamic rooms (huddle pods) exist only while someone is inside — they
  // spawn on the first join and dissolve when they empty out.
  dynamic: boolean
  // Where the door pad sits on the street.
  door: Vec2
  // Huddle walk-in zone rect (world tiles). Present only for huddle rooms.
  zone?: RoomZone
  // Spawned pods are created by the grab gesture at accept time, never on the
  // static map; they ride the dynamic lifecycle (dissolve when empty).
  isSpawned?: boolean
}

export const ROOMS: RoomDef[] = [
  { id: 'pod-north', kind: 'pod', name: 'North Pod', capacity: 2, joinable: true, dynamic: false, door: { x: 5.5, y: 10.6 } },
  { id: 'pod-south', kind: 'pod', name: 'South Pod', capacity: 2, joinable: true, dynamic: false, door: { x: 24.5, y: 10.6 } },
  {
    id: 'huddle-west',
    kind: 'huddle',
    name: 'West Huddle',
    capacity: 4,
    joinable: true,
    dynamic: true,
    door: { x: 9.5, y: 16.9 },
    zone: { x: 7.6, y: 16.1, w: 3.8, d: 1.7 },
  },
  {
    id: 'huddle-east',
    kind: 'huddle',
    name: 'East Huddle',
    capacity: 4,
    joinable: true,
    dynamic: true,
    door: { x: 20.5, y: 16.9 },
    zone: { x: 18.6, y: 16.1, w: 3.8, d: 1.7 },
  },
  // The boardroom lives inside the hall — its door faces the plaza.
  { id: 'boardroom', kind: 'boardroom', name: 'Boardroom', capacity: 8, joinable: true, dynamic: false, door: { x: 16.5, y: 10.6 } },
  // Layout stub only: drawn on the map, never bookable or joinable in v1.
  { id: 'stage', kind: 'stage', name: 'Amphitheater', capacity: 0, joinable: false, dynamic: false, door: { x: 15, y: 16.6 } },
]

export function findRoomDef(defs: RoomDef[], id: string): RoomDef | null {
  return defs.find((d) => d.id === id) ?? null
}

// The huddle zone a street position falls inside, if any — walking into a
// zone raises the join affordance for that zone's spawned pod.
export function zoneAt(defs: RoomDef[], p: Vec2): RoomDef | null {
  for (const def of defs) {
    const z = def.zone
    if (!z) continue
    if (p.x >= z.x && p.x <= z.x + z.w && p.y >= z.y && p.y <= z.y + z.d) return def
  }
  return null
}

// Nearest door within `radius` world tiles of a click — canvas door hits
// resolve through the same server arbitration as the doors list.
export function doorNear(defs: RoomDef[], p: Vec2, radius = 0.9): RoomDef | null {
  let best: RoomDef | null = null
  let bestDist = radius
  for (const def of defs) {
    const dist = Math.hypot(def.door.x - p.x, def.door.y - p.y)
    if (dist <= bestDist) {
      best = def
      bestDist = dist
    }
  }
  return best
}

// Nearest peer within `radius` world tiles of a click — canvas avatar hits
// resolve to the grab gesture instead of a walk target.
export function peerNear<T extends { id: string; x: number; y: number }>(
  peers: T[],
  p: Vec2,
  radius = 1.2,
): T | null {
  let best: T | null = null
  let bestDist = radius
  for (const peer of peers) {
    const dist = Math.hypot(peer.x - p.x, peer.y - p.y)
    if (dist <= bestDist) {
      best = peer
      bestDist = dist
    }
  }
  return best
}

// Where a spawned pod lands: midway between the two people, clamped into the
// walkable band so the booth never materializes off-street.
export function podSpawnPos(a: Vec2, b: Vec2): Vec2 {
  return clampToWorld({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
}
