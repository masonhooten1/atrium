// Shared avatar identity vocabulary. The server re-validates every profile
// through sanitizeProfile — clients are never trusted with raw values.

export const AVATAR_COLORS = ['#f26d6d', '#e8b44a', '#5cc98f', '#4aa8e8', '#a78bfa', '#f07ab8'] as const

export const HAT_IDS = ['none', 'cap', 'tophat', 'beret', 'crown'] as const

export type HatId = (typeof HAT_IDS)[number]

export const MAX_NAME_LENGTH = 24

export interface AvatarProfile {
  name: string
  color: string
  hat: HatId
}

// Server-side: trim, cap length, and fall back to defaults for anything that
// is not one of the known presets.
export function sanitizeProfile(p: { name: unknown; color: unknown; hat: unknown }): AvatarProfile {
  const rawName = typeof p.name === 'string' ? p.name.trim() : ''
  const name = rawName.slice(0, MAX_NAME_LENGTH) || 'Visitor'
  const color = (AVATAR_COLORS as readonly string[]).includes(p.color as string)
    ? (p.color as string)
    : AVATAR_COLORS[0]
  const hat = (HAT_IDS as readonly string[]).includes(p.hat as string) ? (p.hat as HatId) : 'none'
  return { name, color, hat }
}
