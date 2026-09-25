// The v1 world: one street, the central Atrium hall, storefront shells.
// Grid coordinates are tile units — x runs along the street, y is depth.
// Avatars are points (floats), not tiles.

export const GRID_W = 30
export const GRID_D = 20

export interface Vec2 {
  x: number
  y: number
}

// Walkable band: the back sidewalk (with the hall plaza), the street, and the
// front sidewalk. The server clamps every position into this rectangle, so an
// avatar cannot leave the street bounds even if a client asks to.
export const WALK_BOUNDS = { minX: 0.8, maxX: 29.2, minY: 10.2, maxY: 17.8 } as const

// Spawn on the plaza in front of the hall.
export const SPAWN: Vec2 = { x: 15, y: 11 }

export function clampToWorld(p: Vec2): Vec2 {
  // Non-finite input (NaN, Infinity) resolves to spawn rather than poisoning
  // the world with an unrenderable position.
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return { ...SPAWN }
  return {
    x: Math.min(Math.max(p.x, WALK_BOUNDS.minX), WALK_BOUNDS.maxX),
    y: Math.min(Math.max(p.y, WALK_BOUNDS.minY), WALK_BOUNDS.maxY),
  }
}

export function isWalkable(p: Vec2): boolean {
  return (
    p.x >= WALK_BOUNDS.minX &&
    p.x <= WALK_BOUNDS.maxX &&
    p.y >= WALK_BOUNDS.minY &&
    p.y <= WALK_BOUNDS.maxY
  )
}

// Advance pos toward target by at most speed * dt, landing exactly on target
// when reached. Pure so both the client sim and tests can share it.
export function stepToward(pos: Vec2, target: Vec2, speed: number, dt: number): Vec2 {
  const dx = target.x - pos.x
  const dy = target.y - pos.y
  const dist = Math.hypot(dx, dy)
  const step = speed * dt
  if (dist <= step || dist === 0) return { x: target.x, y: target.y }
  return { x: pos.x + (dx / dist) * step, y: pos.y + (dy / dist) * step }
}

// --- Ground map -------------------------------------------------------------

export type GroundKind = 'g' | 's' | 'r' | 'p' // grass | sidewalk | road | plaza

// 20 rows of 30 tiles: grass behind, sidewalk + plaza, road, sidewalk, grass.
const G = 'g'.repeat(30)
const S = 'ssssssssssssssssssssssssssssss'
const R = 'rrrrrrrrrrrrrrrrrrrrrrrrrrrrrr'
const PLAZA_ROW = 'ssssssssssss' + 'pppppppp' + 'ssssssssss'

const GROUND_ROWS: string[] = [
  G, G, G, G, G, G, G, G, G, G,
  PLAZA_ROW,
  PLAZA_ROW,
  R, R, R, R,
  S, S,
  G, G,
]

export function groundAt(i: number, j: number): GroundKind {
  const row = GROUND_ROWS[j]
  return (row?.[i] as GroundKind | undefined) ?? 'g'
}

// --- Buildings and props ----------------------------------------------------

export interface Building {
  x: number
  y: number
  w: number
  d: number
  /** height in tiles (screen height = h * TILE_H) */
  h: number
  wall: string
  trim: string
  windows?: boolean
  sign?: string
  door?: boolean
}

export const BUILDINGS: Building[] = [
  // The central hall — taller, signed, with a street-facing door.
  { x: 12, y: 4, w: 8, d: 6, h: 4.2, wall: '#3d4d75', trim: '#2a3654', windows: true, sign: 'ATRIUM', door: true },
  // Storefront shells (static per the locked decisions — commerce is deferred).
  { x: 2, y: 6, w: 6, d: 4, h: 2.3, wall: '#544a6b', trim: '#39334e', windows: true },
  { x: 22, y: 6, w: 6, d: 4, h: 2.3, wall: '#4a5d55', trim: '#33403a', windows: true },
  { x: 9.5, y: 8, w: 2, d: 2, h: 1.3, wall: '#6b4a3f', trim: '#4a332c', windows: true },
  { x: 20.5, y: 8, w: 2, d: 2, h: 1.3, wall: '#6b5a3f', trim: '#4a3f2c', windows: true },
]

export interface Prop {
  kind: 'lamp' | 'planter' | 'tree'
  x: number
  y: number
}

export const PROPS: Prop[] = [
  { kind: 'lamp', x: 3.5, y: 10.6 },
  { kind: 'lamp', x: 9.5, y: 10.6 },
  { kind: 'lamp', x: 21.5, y: 10.6 },
  { kind: 'lamp', x: 27.5, y: 10.6 },
  { kind: 'lamp', x: 3.5, y: 17.4 },
  { kind: 'lamp', x: 9.5, y: 17.4 },
  { kind: 'lamp', x: 21.5, y: 17.4 },
  { kind: 'lamp', x: 27.5, y: 17.4 },
  { kind: 'planter', x: 11.2, y: 10.5 },
  { kind: 'planter', x: 20.8, y: 10.5 },
  { kind: 'tree', x: 1.2, y: 4.2 },
  { kind: 'tree', x: 28.6, y: 5.1 },
]
