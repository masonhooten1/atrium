// Isometric 2.5D renderer — no 3D engine. Depth comes from a painter's
// algorithm (drawables sorted by x+y) and the parallax read comes from a
// camera-following canvas plus a slower-panning skyline layer.
import { BUILDINGS, GRID_D, GRID_W, groundAt, PROPS } from '@/lib/world'
import { ROOMS, type RoomDef, type RoomZone } from '@/lib/rooms'
import type { Building, Prop } from '@/lib/world'
import type { HatId } from '@/lib/avatar-presets'
import type { Vec2 } from '@/lib/world'

export const TILE_W = 64
export const TILE_H = 32
export const TILE_HW = TILE_W / 2
export const TILE_HH = TILE_H / 2

// Linear isometric projection (no camera): +x goes down-right, +y down-left.
export function isoToScreen(p: Vec2): Vec2 {
  return { x: (p.x - p.y) * TILE_HW, y: (p.x + p.y) * TILE_HH }
}

// Inverse projection — used for click-to-move.
export function screenToIso(p: Vec2): Vec2 {
  const a = p.x / TILE_HW
  const b = p.y / TILE_HH
  return { x: (a + b) / 2, y: (b - a) / 2 }
}

// Convert a unit screen-space input direction into a unit world-space walking
// direction, so arrow keys move the avatar the way they point on screen.
export function screenDirToWorldDir(s: Vec2): Vec2 {
  const wx = (s.x / TILE_HW + s.y / TILE_HH) / 2
  const wy = (s.y / TILE_HH - s.x / TILE_HW) / 2
  const len = Math.hypot(wx, wy)
  return len === 0 ? { x: 0, y: 0 } : { x: wx / len, y: wy / len }
}

export interface AvatarDraw {
  id: string
  name: string
  color: string
  hat: HatId
  x: number
  y: number
  moving: boolean
  isSelf?: boolean
}

export interface DrawWorldArgs {
  ctx: CanvasRenderingContext2D
  width: number
  height: number
  cam: Vec2
  time: number
  self: AvatarDraw | null
  peers: AvatarDraw[]
  // Live door state per room — what the pads and labels show on the street.
  doors: DoorDraw[]
}

// One door's live state, already resolved by the caller from the room summary.
export interface DoorDraw {
  roomId: string
  kind: RoomDef['kind']
  x: number
  y: number
  label: string
  status: 'open' | 'full' | 'reserved' | 'stub'
  occupancy: number
  capacity: number
  bookingLabel: string | null
}

const DOOR_COLORS: Record<DoorDraw['status'], string> = {
  open: '#5cc98f',
  full: '#f26d6d',
  reserved: '#e8b44a',
  stub: '#8a93a8',
}

const STATE_WORD: Record<DoorDraw['status'], string> = {
  open: 'OPEN',
  full: 'FULL',
  reserved: 'RESERVED',
  stub: 'STUB',
}

// Axis-aligned world rect corners in isometric draw order.
function rectPts(x: number, y: number, w: number, d: number): Vec2[] {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + d },
    { x, y: y + d },
  ]
}

export function drawWorld({ ctx, width, height, cam, time, self, peers, doors }: DrawWorldArgs): void {
  const cx = width / 2
  const cy = height / 2
  const toScreen: ToScreen = (p) => {
    const rel = isoToScreen({ x: p.x - cam.x, y: p.y - cam.y })
    return { x: rel.x + cx, y: rel.y + cy }
  }

  drawSky(ctx, width, height, time)
  drawSkyline(ctx, width, toScreen, cam)
  drawGround(ctx, toScreen)
  drawRoomGround(ctx, doors, toScreen, time)

  const avatars: AvatarDraw[] = [...peers, ...(self ? [self] : [])]

  // World objects first, depth-sorted (painter's algorithm). Avatars render in
  // a second, always-on-top pass: every building sits north of the walkable
  // band on this map, so an avatar can never legitimately be behind one.
  const worldObjects: { depth: number; draw: () => void }[] = []
  for (const b of BUILDINGS) {
    worldObjects.push({ depth: b.x + b.w + b.y + b.d, draw: () => drawBuilding(ctx, b, toScreen, time) })
  }
  for (const prop of PROPS) {
    worldObjects.push({ depth: prop.x + prop.y, draw: () => drawProp(ctx, prop, toScreen, time) })
  }
  // Phone booths for the pods — small glass boxes beside their door pads.
  // Static pods sit at their def's door; spawned pods materialize at the
  // landing spot their summary reports.
  const staticRoomIds = new Set(ROOMS.map((d) => d.id))
  const addPodBooth = (at: Vec2): void => {
    const booth: Building = {
      x: at.x - 0.45,
      y: at.y - 1.2,
      w: 0.9,
      d: 0.9,
      h: 1.7,
      wall: '#31405f',
      trim: '#232f4a',
    }
    worldObjects.push({ depth: booth.x + booth.w + booth.y + booth.d, draw: () => drawBuilding(ctx, booth, toScreen, time) })
  }
  for (const def of ROOMS) {
    if (def.kind === 'pod') addPodBooth(def.door)
  }
  for (const door of doors) {
    if (door.kind !== 'pod' || staticRoomIds.has(door.roomId)) continue
    addPodBooth({ x: door.x, y: door.y })
  }
  worldObjects.sort((m, n) => m.depth - n.depth)
  for (const d of worldObjects) d.draw()

  const avatarsSorted = [...avatars].sort((m, n) => m.x + m.y - (n.x + n.y))
  for (const a of avatarsSorted) drawAvatar(ctx, a, toScreen, time)

  // Labels in a third pass so names stay readable over sprites.
  ctx.textAlign = 'center'
  ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif'
  for (const a of avatarsSorted) drawLabel(ctx, a, toScreen)
  for (const door of doors) drawDoorLabel(ctx, door, toScreen)
}

// --- Shared helpers ----------------------------------------------------------

type ToScreen = (p: Vec2) => Vec2

const up = (p: Vec2, lift: number): Vec2 => ({ x: p.x, y: p.y - lift })

function poly(ctx: CanvasRenderingContext2D, pts: Vec2[]): void {
  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
  ctx.closePath()
}

function mod(v: number, m: number): number {
  return ((v % m) + m) % m
}

function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16)
  const clamp = (v: number): number => Math.max(0, Math.min(255, v + amt))
  const r = clamp((n >> 16) & 0xff)
  const g = clamp((n >> 8) & 0xff)
  const b = clamp(n & 0xff)
  return `rgb(${r}, ${g}, ${b})`
}

function faceQuad(
  ctx: CanvasRenderingContext2D,
  a: Vec2,
  b: Vec2,
  topA: Vec2,
  topB: Vec2,
  fill: string,
): void {
  poly(ctx, [a, b, topB, topA])
  ctx.fillStyle = fill
  ctx.fill()
}

// --- Sky and skyline (parallax layer) ----------------------------------------

const STARS = (() => {
  // Deterministic PRNG so the sky is identical every frame and every client.
  let s = 7
  const rnd = (): number => (s = (s * 16807) % 2147483647) / 2147483647
  return Array.from({ length: 110 }, () => ({
    x: rnd(),
    y: rnd() * 0.75,
    r: 0.5 + rnd() * 1.1,
    ph: rnd() * Math.PI * 2,
  }))
})()

function drawSky(ctx: CanvasRenderingContext2D, width: number, height: number, time: number): void {
  const grad = ctx.createLinearGradient(0, 0, 0, height)
  grad.addColorStop(0, '#0a0f22')
  grad.addColorStop(0.55, '#1a2440')
  grad.addColorStop(1, '#0d1326')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, width, height)
  for (const s of STARS) {
    const tw = 0.35 + 0.35 * Math.abs(Math.sin(time / 900 + s.ph))
    ctx.globalAlpha = tw
    ctx.fillStyle = '#dbe4ff'
    ctx.fillRect(s.x * width, s.y * height, s.r, s.r)
  }
  ctx.globalAlpha = 1
}

interface SkylineBox {
  x: number
  w: number
  h: number
}

function makeSkyline(seed: number, count: number, minH: number, maxH: number): SkylineBox[] {
  let s = seed
  const rnd = (): number => (s = (s * 16807) % 2147483647) / 2147483647
  const out: SkylineBox[] = []
  let x = 0
  for (let i = 0; i < count; i++) {
    const w = 40 + rnd() * 90
    out.push({ x, w, h: minH + rnd() * (maxH - minH) })
    x += w + 8 + rnd() * 40
  }
  return out
}

const SKYLINE_SPAN = 2400
const SKYLINE_FAR = makeSkyline(11, 26, 40, 110)
const SKYLINE_NEAR = makeSkyline(23, 22, 70, 150)

// Anchored vertically to the map's back edge but panning horizontally at a
// fraction of camera speed — the parallax depth cue.
function drawSkyline(ctx: CanvasRenderingContext2D, width: number, toScreen: ToScreen, cam: Vec2): void {
  const base = toScreen({ x: GRID_W / 2, y: 0 }).y + 6
  const drawLayer = (boxes: SkylineBox[], k: number, color: string, windows: boolean): void => {
    const layerOff = -(cam.x - cam.y) * TILE_HW * k
    ctx.fillStyle = color
    for (const b of boxes) {
      const x = mod(b.x + layerOff, SKYLINE_SPAN) - 300
      if (x > width + 200 || x + b.w < -200) continue
      ctx.fillRect(x, base - b.h, b.w, b.h)
      if (windows) {
        ctx.fillStyle = 'rgba(255, 210, 138, 0.3)'
        for (let wy = base - b.h + 14; wy < base - 12; wy += 24) {
          if ((Math.floor(b.x / 37) + Math.floor(wy)) % 3 === 0) ctx.fillRect(x + 8, wy, 6, 8)
          if ((Math.floor(b.x / 53) + Math.floor(wy)) % 3 === 0) ctx.fillRect(x + 20, wy, 6, 8)
        }
        ctx.fillStyle = color
      }
    }
  }
  drawLayer(SKYLINE_FAR, 0.18, '#101830', false)
  drawLayer(SKYLINE_NEAR, 0.32, '#16203c', true)
}

// --- Ground -------------------------------------------------------------------

const GROUND_STYLE: Record<string, { base: string; alt: string }> = {
  g: { base: '#24402e', alt: '#274532' },
  s: { base: '#2d3444', alt: '#303748' },
  r: { base: '#23262f', alt: '#252832' },
  p: { base: '#3a4258', alt: '#353d50' },
}

function drawGround(ctx: CanvasRenderingContext2D, toScreen: ToScreen): void {
  for (let j = 0; j < GRID_D; j++) {
    for (let i = 0; i < GRID_W; i++) {
      const style = GROUND_STYLE[groundAt(i, j)]
      poly(ctx, [
        toScreen({ x: i, y: j }),
        toScreen({ x: i + 1, y: j }),
        toScreen({ x: i + 1, y: j + 1 }),
        toScreen({ x: i, y: j + 1 }),
      ])
      ctx.fillStyle = (i + j) % 2 === 0 ? style.base : style.alt
      ctx.fill()
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.08)'
      ctx.lineWidth = 1
      ctx.stroke()
    }
  }
  // Lane dashes down the road centre.
  ctx.fillStyle = 'rgba(217, 180, 90, 0.45)'
  for (let i = 0; i < GRID_W; i += 2) {
    poly(ctx, [
      toScreen({ x: i + 0.3, y: 13.92 }),
      toScreen({ x: i + 0.7, y: 13.92 }),
      toScreen({ x: i + 0.7, y: 14.08 }),
      toScreen({ x: i + 0.3, y: 14.08 }),
    ])
    ctx.fill()
  }
}

// --- Buildings ---------------------------------------------------------------

function drawBuilding(ctx: CanvasRenderingContext2D, b: Building, toScreen: ToScreen, time: number): void {
  const lift = b.h * TILE_H
  const A = toScreen({ x: b.x, y: b.y })
  const B = toScreen({ x: b.x + b.w, y: b.y })
  const C = toScreen({ x: b.x + b.w, y: b.y + b.d })
  const D = toScreen({ x: b.x, y: b.y + b.d })

  // East face (B–C) catches the dusk light; south face (D–C) is shaded.
  // topA/topB must pair with a/b: (C,B) → (up(C), up(B)); (D,C) → (up(D), up(C)).
  faceQuad(ctx, C, B, up(C, lift), up(B, lift), shade(b.wall, 8))
  faceQuad(ctx, D, C, up(D, lift), up(C, lift), shade(b.wall, -22))
  // Roof
  poly(ctx, [up(A, lift), up(B, lift), up(C, lift), up(D, lift)])
  ctx.fillStyle = b.trim
  ctx.fill()
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)'
  ctx.lineWidth = 1
  ctx.stroke()

  if (b.windows) drawWindows(ctx, C, B, lift, Math.round(b.w), time)
  if (b.door) drawDoor(ctx, D, C, lift)
  if (b.sign) drawSign(ctx, D, C, lift, b.sign)
}

// Windows on one building face: quads stretched along the base→end edge and
// lifted off the ground, with a soft flicker on a couple of them.
function drawWindows(
  ctx: CanvasRenderingContext2D,
  base: Vec2,
  end: Vec2,
  lift: number,
  count: number,
  time: number,
): void {
  const bottom = (t: number): Vec2 => ({
    x: base.x + (end.x - base.x) * t,
    y: base.y + (end.y - base.y) * t - lift * 0.3,
  })
  for (let k = 0; k < count; k++) {
    const t0 = 0.16 + (k / count) * 0.7
    const t1 = t0 + 0.5 / count
    const flicker = Math.sin(time / 1300 + k * 2.4) > 0.82 ? 0.35 : 0.85
    faceQuad(
      ctx,
      bottom(t0),
      bottom(t1),
      up(bottom(t0), lift * 0.42),
      up(bottom(t1), lift * 0.42),
      `rgba(255, 208, 138, ${flicker})`,
    )
  }
}

function drawDoor(ctx: CanvasRenderingContext2D, d: Vec2, c: Vec2, lift: number): void {
  const p = (t: number): Vec2 => ({ x: d.x + (c.x - d.x) * t, y: d.y + (c.y - d.y) * t })
  const topLift = lift * 0.45
  poly(ctx, [p(0.42), p(0.58), up(p(0.58), topLift), up(p(0.42), topLift)])
  ctx.fillStyle = '#151b2c'
  ctx.fill()
  // Warm light spilling from the doorway.
  poly(ctx, [up(p(0.45), 2), up(p(0.55), 2), up(p(0.58), topLift - 8), up(p(0.42), topLift - 6)])
  ctx.fillStyle = 'rgba(255, 200, 120, 0.5)'
  ctx.fill()
}

function drawSign(ctx: CanvasRenderingContext2D, d: Vec2, c: Vec2, lift: number, sign: string): void {
  const mid = { x: (d.x + c.x) / 2, y: (d.y + c.y) / 2 - lift * 0.68 }
  ctx.font = `700 ${Math.round(lift * 0.16)}px ui-sans-serif, system-ui, sans-serif`
  ctx.fillStyle = '#ffd28a'
  ctx.textAlign = 'center'
  ctx.fillText(sign, mid.x, mid.y)
}

// --- Props --------------------------------------------------------------------

function drawLamp(ctx: CanvasRenderingContext2D, p: Vec2, time: number): void {
  const topY = p.y - 58
  const glow = ctx.createRadialGradient(p.x, topY, 2, p.x, topY, 36)
  glow.addColorStop(0, `rgba(255, 205, 130, ${0.16 + 0.05 * Math.sin(time / 500 + p.x)})`)
  glow.addColorStop(1, 'rgba(255, 205, 130, 0)')
  ctx.fillStyle = glow
  ctx.beginPath()
  ctx.arc(p.x, topY, 36, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = '#141a2a'
  ctx.lineWidth = 3.5
  ctx.beginPath()
  ctx.moveTo(p.x, p.y)
  ctx.lineTo(p.x, topY)
  ctx.stroke()
  ctx.fillStyle = '#ffd28a'
  ctx.beginPath()
  ctx.arc(p.x, topY, 4.5, 0, Math.PI * 2)
  ctx.fill()
}

function drawPlanter(ctx: CanvasRenderingContext2D, p: Vec2): void {
  const w = 0.35 * TILE_HW
  poly(ctx, [p, { x: p.x + w, y: p.y + w / 2 }, { x: p.x, y: p.y + w }, { x: p.x - w, y: p.y + w / 2 }])
  ctx.fillStyle = '#6b4a3f'
  ctx.fill()
  poly(ctx, [
    up(p, 10),
    up({ x: p.x + w, y: p.y + w / 2 }, 10),
    up({ x: p.x, y: p.y + w }, 10),
    up({ x: p.x - w, y: p.y + w / 2 }, 10),
  ])
  ctx.fillStyle = '#3f6b46'
  ctx.fill()
}

function drawTree(ctx: CanvasRenderingContext2D, p: Vec2): void {
  ctx.strokeStyle = '#2a2018'
  ctx.lineWidth = 5
  ctx.beginPath()
  ctx.moveTo(p.x, p.y)
  ctx.lineTo(p.x, p.y - 34)
  ctx.stroke()
  ctx.fillStyle = '#2f5540'
  ctx.beginPath()
  ctx.arc(p.x, p.y - 52, 20, 0, Math.PI * 2)
  ctx.fill()
  ctx.beginPath()
  ctx.arc(p.x - 12, p.y - 40, 14, 0, Math.PI * 2)
  ctx.fill()
  ctx.beginPath()
  ctx.arc(p.x + 10, p.y - 44, 15, 0, Math.PI * 2)
  ctx.fill()
}

function drawProp(ctx: CanvasRenderingContext2D, prop: Prop, toScreen: ToScreen, time: number): void {
  const p = toScreen(prop)
  if (prop.kind === 'lamp') {
    drawLamp(ctx, p, time)
  } else if (prop.kind === 'planter') {
    drawPlanter(ctx, p)
  } else {
    drawTree(ctx, p)
  }
}

// --- Avatars ------------------------------------------------------------------

function drawHat(ctx: CanvasRenderingContext2D, hat: HatId, x: number, y: number, color: string): void {
  switch (hat) {
    case 'cap':
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(x, y, 8.5, Math.PI, 0)
      ctx.fill()
      ctx.fillStyle = shade(color, -50)
      ctx.fillRect(x - 2, y - 2, 12, 3)
      break
    case 'tophat':
      ctx.fillStyle = '#1e2433'
      ctx.fillRect(x - 11, y - 2, 22, 3)
      ctx.fillRect(x - 6, y - 15, 14, 14)
      ctx.fillStyle = color
      ctx.fillRect(x - 11, y - 5, 22, 3.5)
      break
    case 'beret':
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.ellipse(x - 1, y - 8, 11, 5, -0.12, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillRect(x - 1, y - 21, 2.5, 5)
      break
    case 'crown':
      ctx.fillStyle = '#e8b44a'
      ctx.beginPath()
      ctx.moveTo(x - 9, y - 1)
      ctx.lineTo(x - 9, y - 9)
      ctx.lineTo(x - 4.5, y - 6)
      ctx.lineTo(x, y - 12)
      ctx.lineTo(x + 9, y - 6)
      ctx.lineTo(x + 9, y - 1)
      ctx.closePath()
      ctx.fill()
      break
    default:
      break
  }
}

function drawAvatar(ctx: CanvasRenderingContext2D, a: AvatarDraw, toScreen: ToScreen, time: number): void {
  const p = toScreen({ x: a.x, y: a.y })
  const bob = a.moving ? Math.sin(time / 110) * 1.6 : 0

  // contact shadow
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)'
  ctx.beginPath()
  ctx.ellipse(p.x, p.y + 2, 13, 6.5, 0, 0, Math.PI * 2)
  ctx.fill()

  // self marker
  if (a.isSelf) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)'
    ctx.lineWidth = 1.5
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.ellipse(p.x, p.y + 2, 17, 8.5, 0, 0, Math.PI * 2)
    ctx.stroke()
    ctx.setLineDash([])
  }

  // body
  ctx.fillStyle = a.color
  ctx.beginPath()
  ctx.roundRect(p.x - 9, p.y - 36 + bob, 18, 28, 9)
  ctx.fill()
  ctx.strokeStyle = shade(a.color, -45)
  ctx.lineWidth = 1.5
  ctx.stroke()

  // head
  ctx.fillStyle = '#ecd9bd'
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.25)'
  ctx.beginPath()
  ctx.arc(p.x, p.y - 42 + bob, 8, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()

  drawHat(ctx, a.hat, p.x, p.y - 47 + bob, a.color)
}

function drawLabel(ctx: CanvasRenderingContext2D, a: AvatarDraw, toScreen: ToScreen): void {
  const p = toScreen({ x: a.x, y: a.y })
  ctx.lineWidth = 3
  ctx.strokeStyle = 'rgba(2, 6, 23, 0.85)'
  ctx.strokeText(a.name, p.x, p.y - 62)
  ctx.fillStyle = a.isSelf ? '#ffffff' : '#e2e8f0'
  ctx.fillText(a.name, p.x, p.y - 62)
}

// --- Rooms -------------------------------------------------------------------

// Ground-level room furniture: huddle rugs, the amphitheater tiers, and the
// live door pads. Drawn straight after the ground so avatars walk over them.
function drawRoomGround(
  ctx: CanvasRenderingContext2D,
  doors: DoorDraw[],
  toScreen: ToScreen,
  time: number,
): void {
  for (const def of ROOMS) {
    if (def.zone) drawRug(ctx, def.zone, toScreen)
    if (def.kind === 'stage') drawStageTiers(ctx, toScreen)
  }
  const byId = new Map(doors.map((d) => [d.roomId, d]))
  for (const def of ROOMS) {
    // Before the first summary arrives, doors render as open and empty.
    const door = byId.get(def.id) ?? {
      roomId: def.id,
      kind: def.kind,
      x: def.door.x,
      y: def.door.y,
      label: def.name,
      status: 'open' as const,
      occupancy: 0,
      capacity: def.capacity,
      bookingLabel: null,
    }
    drawDoorPad(ctx, door, toScreen, time)
    if (door.kind === 'boardroom') drawBoardroomPortal(ctx, door, toScreen, time)
  }
  // Spawned pods have no static def — their pads ride the doors list.
  const staticRoomIds = new Set(ROOMS.map((d) => d.id))
  for (const door of doors) {
    if (staticRoomIds.has(door.roomId)) continue
    drawDoorPad(ctx, door, toScreen, time)
  }
}

function drawRug(ctx: CanvasRenderingContext2D, zone: RoomZone, toScreen: ToScreen): void {
  poly(ctx, rectPts(zone.x, zone.y, zone.w, zone.d).map(toScreen))
  ctx.fillStyle = 'rgba(92, 201, 143, 0.14)'
  ctx.fill()
  ctx.setLineDash([7, 5])
  ctx.strokeStyle = 'rgba(92, 201, 143, 0.65)'
  ctx.lineWidth = 2
  ctx.stroke()
  ctx.setLineDash([])
}

// The amphitheater stub: three tier bands and the stage platform draw only —
// the layout gesture (bookings, seating) is a later slice.
function drawStageTiers(ctx: CanvasRenderingContext2D, toScreen: ToScreen): void {
  const tiers: [number, number, number, number, string][] = [
    [13.1, 15.9, 3.8, 1.7, '#3b4256'],
    [13.45, 16.1, 3.1, 1.35, '#404759'],
    [13.8, 16.3, 2.4, 1.0, '#464e63'],
  ]
  for (const [x, y, w, d, color] of tiers) {
    poly(ctx, rectPts(x, y, w, d).map(toScreen))
    ctx.fillStyle = color
    ctx.fill()
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)'
    ctx.lineWidth = 1
    ctx.stroke()
  }
  // Raised stage platform at the back of the tiers.
  const platform: Building = { x: 14.1, y: 16.35, w: 1.8, d: 0.9, h: 0.5, wall: '#5a4a33', trim: '#3d3120' }
  drawBuilding(ctx, platform, toScreen, 0)
}

function drawDoorPad(ctx: CanvasRenderingContext2D, door: DoorDraw, toScreen: ToScreen, time: number): void {
  const color = DOOR_COLORS[door.status]
  const pulse = door.status === 'stub' ? 0.3 : 0.42 + 0.16 * Math.sin(time / 600)
  poly(ctx, rectPts(door.x - 0.4, door.y - 0.24, 0.8, 0.48).map(toScreen))
  ctx.globalAlpha = pulse
  ctx.fillStyle = color
  ctx.fill()
  ctx.globalAlpha = 1
  ctx.strokeStyle = color
  ctx.lineWidth = 1.5
  ctx.stroke()
}

// The boardroom door on the hall: a freestanding portal frame over its pad.
function drawBoardroomPortal(ctx: CanvasRenderingContext2D, door: DoorDraw, toScreen: ToScreen, time: number): void {
  const color = DOOR_COLORS[door.status]
  const base = toScreen({ x: door.x, y: door.y })
  const glow = 0.5 + 0.2 * Math.sin(time / 700)
  // Left pillar, right pillar, lintel — read as a doorway from the plaza.
  for (const [dx, h] of [[-14, 34], [10, 34]] as const) {
    ctx.fillStyle = '#1c2438'
    ctx.fillRect(base.x + dx, base.y - h - 8, 4, h)
  }
  ctx.fillStyle = '#1c2438'
  ctx.fillRect(base.x - 14, base.y - 46, 28, 5)
  ctx.globalAlpha = glow
  ctx.fillStyle = color
  ctx.fillRect(base.x - 9, base.y - 38, 18, 30)
  ctx.globalAlpha = 1
}

function drawDoorLabel(ctx: CanvasRenderingContext2D, door: DoorDraw, toScreen: ToScreen): void {
  const p = toScreen({ x: door.x, y: door.y })
  const line = `${door.label} · ${STATE_WORD[door.status]} ${door.occupancy}/${door.capacity}`
  ctx.font = '700 11px ui-sans-serif, system-ui, sans-serif'
  ctx.lineWidth = 3
  ctx.strokeStyle = 'rgba(2, 6, 23, 0.85)'
  ctx.strokeText(line, p.x, p.y - 52)
  ctx.fillStyle = DOOR_COLORS[door.status]
  ctx.fillText(line, p.x, p.y - 52)
  if (door.bookingLabel) {
    ctx.font = '500 10px ui-sans-serif, system-ui, sans-serif'
    ctx.lineWidth = 3
    ctx.strokeText(door.bookingLabel, p.x, p.y - 40)
    ctx.fillStyle = '#ffd28a'
    ctx.fillText(door.bookingLabel, p.x, p.y - 40)
  }
}
