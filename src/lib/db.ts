// Prisma client singleton. server.ts (the socket layer) and Next's compiled
// API routes share one process but not one module graph — Next bundles its
// own copy of every import — so the client hangs off globalThis where both
// graphs see the same instance. This is the pattern Prisma documents for
// exactly this setup. Constructed lazily: unit tests never pay for it.
import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as typeof globalThis & {
  __atriumPrisma?: PrismaClient
}

export function getDb(): PrismaClient {
  globalForPrisma.__atriumPrisma ??= new PrismaClient()
  return globalForPrisma.__atriumPrisma
}
