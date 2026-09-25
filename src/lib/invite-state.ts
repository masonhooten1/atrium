// Pure grab-gesture invite state. The server is the only writer: invites are
// created, answered, expired, and cancelled here — never trusted from the
// client. `now` is always injected so tests can freeze time around the 30 s
// expiry timer, mirroring the room-state module's discipline.
import type { Vec2 } from './world'

// An invite is a street-distance conversation: close enough to talk, and the
// server re-checks it — a client cannot invite across the whole map.
export const INVITE_RANGE_TILES = 4

// Unanswered invites die after 30 s — a no by silence, with nothing spawned.
export const INVITE_EXPIRY_MS = 30_000

export interface Invite {
  id: string
  inviterId: string
  targetId: string
  createdAt: number
}

export interface InviteBook {
  invites: Map<string, Invite>
  // inviter id -> their one outstanding invite: the no-stacking rule.
  byInviter: Map<string, string>
  expiryMs: number
  nextId: number
}

export function newInviteBook(expiryMs: number = INVITE_EXPIRY_MS): InviteBook {
  return { invites: new Map(), byInviter: new Map(), expiryMs, nextId: 1 }
}

export type InviteCreateReason = 'self' | 'range' | 'outstanding'

export type InviteCreateResult = { ok: true; invite: Invite } | { ok: false; reason: InviteCreateReason }

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

// Create an invite: never to yourself, only within street range, and one
// outstanding per inviter — a second click while one is pending does not stack.
export function createInvite(
  book: InviteBook,
  p: { inviterId: string; targetId: string; inviterPos: Vec2; targetPos: Vec2; now: number },
): InviteCreateResult {
  if (p.inviterId === p.targetId) return { ok: false, reason: 'self' }
  if (dist(p.inviterPos, p.targetPos) > INVITE_RANGE_TILES) return { ok: false, reason: 'range' }
  const outstandingId = book.byInviter.get(p.inviterId)
  if (outstandingId !== undefined) {
    const outstanding = book.invites.get(outstandingId)
    if (outstanding && p.now - outstanding.createdAt < book.expiryMs) {
      return { ok: false, reason: 'outstanding' }
    }
    // Stale mapping past expiry (the sweeper has not run yet): drop it and
    // continue rather than locking the inviter out until the next sweep.
    book.invites.delete(outstandingId)
    book.byInviter.delete(p.inviterId)
  }
  const invite: Invite = {
    id: `inv-${book.nextId++}`,
    inviterId: p.inviterId,
    targetId: p.targetId,
    createdAt: p.now,
  }
  book.invites.set(invite.id, invite)
  book.byInviter.set(invite.inviterId, invite.id)
  return { ok: true, invite }
}

// Move every unanswered invite past its expiry out of the book. Returns the
// expired invites so the server can tell both parties — silence resolves as a
// no, and nothing materializes.
export function sweepInvites(book: InviteBook, now: number): Invite[] {
  const expired: Invite[] = []
  for (const invite of book.invites.values()) {
    if (now - invite.createdAt >= book.expiryMs) expired.push(invite)
  }
  for (const invite of expired) dropInvite(book, invite)
  return expired
}

export type InviteRespondReason = 'unknown' | 'not-target'

export type InviteRespondResult = { ok: true; invite: Invite } | { ok: false; reason: InviteRespondReason }

// Answer an invite. Only the target may answer, and only before expiry —
// anything else is a stale or lying client. The invite is consumed either way:
// one question, one answer.
export function respondInvite(book: InviteBook, inviteId: string, responderId: string, now: number): InviteRespondResult {
  sweepInvites(book, now)
  const invite = book.invites.get(inviteId)
  if (!invite) return { ok: false, reason: 'unknown' }
  if (responderId !== invite.targetId) return { ok: false, reason: 'not-target' }
  dropInvite(book, invite)
  return { ok: true, invite }
}

// Disconnect cleanup: every outstanding invite involving this peer — as
// inviter or target — dies with the socket.
export function cancelInvitesInvolving(book: InviteBook, peerId: string): Invite[] {
  const cancelled: Invite[] = []
  for (const invite of book.invites.values()) {
    if (invite.inviterId === peerId || invite.targetId === peerId) cancelled.push(invite)
  }
  for (const invite of cancelled) dropInvite(book, invite)
  return cancelled
}

function dropInvite(book: InviteBook, invite: Invite): void {
  book.invites.delete(invite.id)
  const mapping = book.byInviter.get(invite.inviterId)
  if (mapping === invite.id) book.byInviter.delete(invite.inviterId)
}
