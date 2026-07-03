import { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAdminAuth } from '@/lib/auth'

const RevokeSchema = z.object({
  reason: z.string().min(1).max(1000),
})

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const err = await requireAdminAuth(req)
  if (err) return err

  const { id } = await params

  let body: unknown
  try { body = await req.json() } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const parsed = RevokeSchema.safeParse(body)
  if (!parsed.success) return Response.json({ error: 'reason required' }, { status: 400 })
  const { reason } = parsed.data

  const license = await db.license.findUnique({ where: { id } })
  if (!license) return Response.json({ error: 'not found' }, { status: 404 })
  if (license.status === 'revoked') {
    return Response.json({ error: 'already revoked' }, { status: 409 })
  }

  const revokedAt = new Date()
  try {
    await db.$transaction(async (tx) => {
      // Guarded update: a concurrent revoke between the check above and here
      // must not double-revoke or double-audit.
      const updated = await tx.license.updateMany({
        where: { id, status: { not: 'revoked' } },
        data: { status: 'revoked', revokedAt, revokeReason: reason },
      })
      if (updated.count === 0) throw new Error('already_revoked')

      await tx.auditEvent.create({
        data: { licenseId: id, type: 'REVOKE', payload: { reason } },
      })
    })
  } catch (e: unknown) {
    if (e instanceof Error && e.message === 'already_revoked') {
      return Response.json({ error: 'already revoked' }, { status: 409 })
    }
    throw e
  }

  return Response.json({ ok: true, status: 'revoked', revokedAt })
}
