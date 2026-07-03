import { db } from '@/lib/db'
import { isAuthenticated } from '@/lib/auth'
import { notFound, redirect } from 'next/navigation'
import LicenseDetailClient from './LicenseDetailClient'

export default async function LicenseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  if (!(await isAuthenticated())) redirect('/login')

  const { id } = await params
  const license = await db.license.findUnique({
    where: { id },
    include: {
      customer: true,
      product: { select: { id: true, name: true, slug: true, keyId: true } },
      instances: { orderBy: { lastSeenAt: 'desc' } },
      auditEvents: { orderBy: { createdAt: 'desc' }, take: 20 },
    },
  })

  if (!license) notFound()

  // BigInt latestSequence is not JSON-serializable — stringify before the RSC boundary
  const serializable = {
    ...license,
    instances: license.instances.map((i) => ({ ...i, latestSequence: i.latestSequence.toString() })),
  }
  return <LicenseDetailClient license={JSON.parse(JSON.stringify(serializable))} />
}
