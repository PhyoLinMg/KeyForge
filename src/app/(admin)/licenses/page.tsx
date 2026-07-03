import Link from 'next/link'
import { db } from '@/lib/db'
import { isAuthenticated } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { statusClass, statusBorderClass, tierLabel } from './_lib/format'

export default async function LicensesPage() {
  if (!(await isAuthenticated())) redirect('/login')

  // List shows the newest 500; stats count everything in the DB
  const [licenses, statusCounts] = await Promise.all([
    db.license.findMany({
      orderBy: { issuedAt: 'desc' },
      take: 500,
      include: {
        customer: { select: { name: true } },
        product: { select: { name: true, slug: true } },
        _count: { select: { instances: true } },
      },
    }),
    db.license.groupBy({ by: ['status'], _count: { _all: true } }),
  ])

  const countOf = (status: string) => statusCounts.find(s => s.status === status)?._count._all ?? 0
  const total = statusCounts.reduce((sum, s) => sum + s._count._all, 0)
  const active = countOf('active')
  const revoked = countOf('revoked')

  return (
    <>
      <div className="px-8 pt-8">
        {/* Header */}
        <div className="flex items-end justify-between pb-6 bdb">
          <div>
            <p className="text-[9px] tracking-[0.28em] fg-muted mb-2 uppercase">Keyforge</p>
            <h1 className="text-[20px] font-semibold fg-t1 m-0 tracking-[-0.02em]">Licenses</h1>
          </div>
          <Link
            href="/licenses/new"
            className="text-[10px] tracking-[0.2em] fg-dark bg-amber px-[18px] py-[9px] no-underline uppercase font-semibold transition-[background] duration-100"
          >
            Issue License →
          </Link>
        </div>

        {/* Stats */}
        <div className="flex gap-8 py-[18px] bdb">
          <Stat label="Total" value={total} />
          <Stat label="Active" value={active} colorCls="fg-green" />
          <Stat label="Revoked" value={revoked} colorCls="fg-red" />
        </div>
      </div>

      {/* List */}
      <div className="py-4">
        {licenses.length === 0 ? (
          <div className="px-8 py-12 text-[11px] fg-muted tracking-[0.15em]">No licenses issued yet.</div>
        ) : (
          licenses.map((l) => (
            <Link
              key={l.id}
              href={`/licenses/${l.id}`}
              className={`lic-row block px-8 py-3.5 ${statusBorderClass(l.status)} bdb no-underline transition-[background] duration-100`}
            >
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2.5 mb-1">
                    <span className="text-[13px] font-medium fg-t1">{l.customer.name}</span>
                    <span className="text-[9px] fg-muted">·</span>
                    <span className="text-[11px] fg-t2">{l.product.name}</span>
                    <span className="text-[8px] tracking-[0.18em] fg-muted bd-b px-[5px] py-px uppercase">
                      {tierLabel(l.tier)}
                    </span>
                  </div>
                  <div className="flex gap-4 text-[10px] fg-muted">
                    <span>Expires {new Date(l.expiresAt).toLocaleDateString('en-CA')}</span>
                    <span>{l._count.instances} instance{l._count.instances !== 1 ? 's' : ''}</span>
                    <span className="font-[inherit]">{l.id.slice(0, 8)}…</span>
                  </div>
                </div>
                <div className={`text-[9px] tracking-[0.18em] ${statusClass(l.status)} uppercase shrink-0`}>
                  {l.status}
                </div>
              </div>
            </Link>
          ))
        )}
      </div>
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
