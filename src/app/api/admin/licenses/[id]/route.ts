import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAdminAuth } from '@/lib/auth'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const err = await requireAdminAuth(req)
  if (err) return err

  const { id } = await params
  const license = await db.license.findUnique({
    where: { id },
    include: {
      customer: true,
      product: { select: { id: true, name: true, slug: true, keyId: true } },
      instances: { orderBy: { lastSeenAt: 'desc' } },
      auditEvents: { orderBy: { createdAt: 'desc' }, take: 50 },
    },
  })

  if (!license) return Response.json({ error: 'not found' }, { status: 404 })
  return Response.json({
    ...license,
    // BigInt is not JSON-serializable — expose as string (UI types expect string)
    instances: license.instances.map((i) => ({ ...i, latestSequence: i.latestSequence.toString() })),
  })
}
