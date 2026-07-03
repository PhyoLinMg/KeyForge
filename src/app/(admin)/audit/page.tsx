import { isAuthenticated } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { db } from '@/lib/db'
import AuditLogTable, { type AuditRow } from './AuditLogTable'

export const dynamic = 'force-dynamic'

export default async function AuditPage() {
  if (!(await isAuthenticated())) redirect('/login')

  const events = await db.auditEvent.findMany({
    orderBy: { createdAt: 'desc' },
    take: 500,
    include: {
      license: {
        include: {
          customer: { select: { name: true } },
          product: { select: { name: true } },
        },
      },
    },
  })

  // Count the full 30-day window in the DB — the 500 rows above are only the display page
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const grouped = await db.auditEvent.groupBy({
    by: ['type'],
    where: { createdAt: { gt: cutoff } },
    _count: { _all: true },
  })
  const countOf = (type: string) => grouped.find(g => g.type === type)?._count._all ?? 0

  const stats = {
    total: grouped.reduce((sum, g) => sum + g._count._all, 0),
    issued: countOf('ISSUE'),
    revoked: countOf('REVOKE'),
    failures: countOf('HEARTBEAT_FAIL'),
  }

  const latestAt = events[0]?.createdAt.toISOString() ?? null
  const isLive = latestAt !== null && Date.now() - new Date(latestAt).getTime() < 5 * 60 * 1000

  const rows: AuditRow[] = events.map(e => ({
    id: e.id,
    type: e.type,
    payload: e.payload,
    createdAt: e.createdAt.toISOString(),
    licenseId: e.licenseId,
    customerName: e.license?.customer.name ?? null,
    productName: e.license?.product.name ?? null,
  }))

  return (
    <>
      <div className="px-8 pt-8">
        {/* Header */}
        <div className="flex items-end justify-between pb-6 bdb">
          <div>
            <p className="text-[9px] tracking-[0.28em] fg-muted mb-2 uppercase">Keyforge</p>
            <h1 className="text-[20px] font-semibold fg-t1 m-0 tracking-[-0.02em]">Audit Log</h1>
            <p className="text-[11px] fg-t2 mt-1.5">Immutable record — last 500 events shown</p>
          </div>

          {isLive && (
            <div className="flex items-center gap-2 text-[9px] tracking-[0.22em] fg-muted">
              <span className="relative flex w-2 h-2">
                <span className="animate-ping absolute inline-flex rounded-full w-full h-full bg-green opacity-50" />
                <span className="relative inline-flex rounded-full w-2 h-2 bg-green" />
              </span>
              LIVE
            </div>
          )}
        </div>

        {/* Stats */}
        <div className="flex gap-8 py-[18px] bdb">
          <Stat label="30-Day Events" value={stats.total} />
          <Stat label="Issued" value={stats.issued} colorCls="fg-green" />
          <Stat label="Revoked" value={stats.revoked} colorCls="fg-red" />
          <Stat label="HB Failures" value={stats.failures} colorCls="fg-orange" />
        </div>
      </div>

      <AuditLogTable events={rows} />
    </>
  )
}

function Stat({ label, value, colorCls = 'fg-t2' }: { label: string; value: number; colorCls?: string }) {
  return (
    <div>
      <div className="text-[9px] tracking-[0.2em] fg-muted uppercase mb-[3px]">{label}</div>
      <div className={`text-[22px] font-semibold ${colorCls} tracking-[-0.03em]`}>{value}</div>
    </div>
  )
}
