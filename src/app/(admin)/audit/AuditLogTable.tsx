'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import clsx from 'clsx'
import { eventTypeClass } from '@/app/(admin)/licenses/_lib/format'

export type AuditRow = {
  id: string
  type: string
  payload: unknown
  createdAt: string
  licenseId: string | null
  customerName: string | null
  productName: string | null
}

const TYPE_LABEL: Record<string, string> = {
  ISSUE: 'ISSUE', REVOKE: 'REVOKE', RENEW: 'RENEW',
  HEARTBEAT: 'HB', HEARTBEAT_FAIL: 'HB FAIL', ADMIN_LOGIN: 'ADMIN',
  AUDIT_PRUNE: 'PRUNE', AUDIT_PRUNE_REJECTED: 'PRUNE REJ',
}
const TYPE_ACCENT: Record<string, string> = {
  ISSUE: '#3dd68c', REVOKE: '#f06060', RENEW: '#5ab4f0',
  HEARTBEAT: '#4a5578', HEARTBEAT_FAIL: '#f09050', ADMIN_LOGIN: '#a87af5',
  AUDIT_PRUNE: '#4a5578', AUDIT_PRUNE_REJECTED: '#f09050',
}

function fmtUtc(iso: string) {
  return { date: iso.slice(0, 10), time: iso.slice(11, 19) }
}

const FILTER_TYPES = ['ISSUE', 'REVOKE', 'RENEW', 'HEARTBEAT', 'HEARTBEAT_FAIL', 'ADMIN_LOGIN']

export default function AuditLogTable({ events }: { events: AuditRow[] }) {
  const [active, setActive] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const rows = useMemo(() => {
    let r = events
    if (active.size > 0) r = r.filter(e => active.has(e.type))
    if (search.trim()) {
      const q = search.toLowerCase()
      r = r.filter(e =>
        e.customerName?.toLowerCase().includes(q) ||
        e.licenseId?.toLowerCase().includes(q) ||
        e.productName?.toLowerCase().includes(q) ||
        e.type.toLowerCase().includes(q),
      )
    }
    return r
  }, [events, active, search])

  function toggleType(t: string) {
    setActive(prev => {
      const n = new Set(prev)
      if (n.has(t)) n.delete(t)
      else n.add(t)
      return n
    })
  }

  function toggleExp(id: string) {
    setExpanded(prev => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }

  return (
    <div className="px-8 py-5">
      {/* Filter + search */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        {FILTER_TYPES.map(t => {
          const on = active.has(t)
          const typeCls = eventTypeClass(t)
          return (
            <button
              key={t}
              onClick={() => toggleType(t)}
              className={clsx(
                'font-[inherit] text-[9px] tracking-[0.18em] px-[9px] py-[3px] cursor-pointer transition-all duration-100 uppercase',
                on ? `${typeCls} aud-badge` : 'bd fg-muted bg-transparent',
              )}
            >
              {TYPE_LABEL[t] ?? t}
            </button>
          )
        })}

        <div className="ml-auto flex items-center gap-3">
          <span className="text-[9px] tracking-[0.15em] fg-muted">{rows.length}/{events.length}</span>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="customer · license · product"
            className="aud-search font-[inherit] bg-transparent bd fg-t2 px-3 py-[5px] text-[11px] w-60 transition-[border-color] duration-[150ms]"
          />
        </div>
      </div>

      {/* Column headers */}
      <div className="grid grid-cols-[88px_150px_1fr_120px_20px] px-3 py-1 text-[9px] tracking-[0.2em] fg-muted bdb mb-0.5 uppercase">
        <span>Type</span><span>Timestamp UTC</span><span>License · Customer</span><span>Product</span><span />
      </div>

      {/* Rows */}
      {rows.length === 0 ? (
        <div className="py-12 text-center text-[10px] fg-muted tracking-[0.25em]">— NO EVENTS MATCH —</div>
      ) : (
        rows.map((e) => {
          const typeCls = eventTypeClass(e.type)
          const { date, time } = fmtUtc(e.createdAt)
          const isExp = expanded.has(e.id)
          const accent = TYPE_ACCENT[e.type] ?? '#4a5578'

          return (
            <div key={e.id} className="slide-in">
              <button
                onClick={() => toggleExp(e.id)}
                className={clsx(
                  'aud-row-btn w-full grid grid-cols-[88px_150px_1fr_120px_20px] px-3 py-2 bdb cursor-pointer transition-[background,border-left-color] duration-100 text-left font-[inherit] items-center',
                  isExp ? `${typeCls} aud-row-expanded` : 'aud-row-collapsed bg-transparent',
                )}
                onMouseEnter={el => { if (!isExp) el.currentTarget.style.borderLeftColor = accent + '60' }}
                onMouseLeave={el => { if (!isExp) el.currentTarget.style.borderLeftColor = 'transparent' }}
              >
                {/* Badge */}
                <div>
                  <span className={`${typeCls} aud-badge inline-block text-[8px] font-semibold tracking-[0.15em] px-1.5 py-0.5 font-[inherit] uppercase`}>
                    {TYPE_LABEL[e.type] ?? e.type}
                  </span>
                </div>

                {/* Timestamp */}
                <div>
                  <div className="text-[10px] fg-t2">{date}</div>
                  <div className="text-[9px] fg-muted">{time}</div>
                </div>

                {/* License + customer */}
                <div className="overflow-hidden">
                  <div className="text-[10px] fg-t2">
                    {e.licenseId ? (
                      <><span>{e.licenseId.slice(0, 8)}</span><span className="fg-muted">…</span></>
                    ) : '—'}
                  </div>
                  {e.customerName && (
                    <div className="text-[9px] fg-muted truncate">{e.customerName}</div>
                  )}
                </div>

                {/* Product */}
                <div className="text-[10px] fg-muted truncate">{e.productName ?? '—'}</div>

                {/* Expand */}
                <div className="flex items-center justify-center">
                  <span className={clsx('text-[13px] fg-muted inline-block transition-transform duration-[150ms] leading-none', isExp && 'rotate-90')}>
                    ›
                  </span>
                </div>
              </button>

              {isExp && (
                <div className="px-3 pb-2.5 pl-3.5">
                  <div className={`${typeCls} aud-expand-box px-3.5 py-2.5`}>
                    <pre className={`${typeCls} aud-expand-text text-[11px] leading-7 whitespace-pre-wrap break-all m-0 font-[inherit]`}>
                      {JSON.stringify(e.payload, null, 2)}
                    </pre>
                    <div className={`${typeCls} aud-expand-footer mt-2.5 pt-2.5 text-[9px] tracking-[0.1em] flex justify-between items-center font-[inherit]`}>
                      <span className="aud-expand-text opacity-40">evt/{e.id}</span>
                      {e.licenseId && (
                        <Link
                          href={`/licenses/${e.licenseId}`}
                          className="aud-expand-text opacity-60 no-underline text-[9px]"
                          onClick={ev => ev.stopPropagation()}
                        >
                          → view license
                        </Link>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )
        })
      )}

      <div className="py-3.5 text-center text-[9px] fg-muted tracking-[0.22em] uppercase">
        Immutable · Append-Only · {events.length} Total Records
      </div>
    </div>
  )
}
