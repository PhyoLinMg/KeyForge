import { describe, it, expect, beforeEach } from 'vitest'
import { POST } from '@/app/api/v1/validate/route'
import { POST as LIST_POST } from '@/app/api/admin/licenses/route'
import { NextRequest } from 'next/server'
import {
  truncateAll,
  createProduct,
  createCustomer,
  adminRequest,
} from '@/__tests__/helpers'

function validateReq(body: object): NextRequest {
  return new NextRequest('http://localhost/api/v1/validate', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  })
}

async function issueLicense(productId: string, customerId: string): Promise<{ id: string; licenseText: string }> {
  const req = await adminRequest('http://localhost/api/admin/licenses', {
    method: 'POST',
    body: JSON.stringify({
      productId,
      customerId,
      tier: 'pro',
      expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
    }),
    headers: { 'Content-Type': 'application/json' },
  })
  const res = await LIST_POST(req)
  return res.json()
}

describe('POST /api/v1/validate', () => {
  let licenseText: string
  let licenseId: string

  beforeEach(async () => {
    await truncateAll()
    const product = await createProduct()
    const customer = await createCustomer()
    const license = await issueLicense(product.id, customer.id)
    licenseText = license.licenseText
    licenseId = license.id
  })

  // ── Happy path ───────────────────────────────────────────────────────────

  it('valid active license returns 200 with state=VALID', async () => {
    const res = await POST(validateReq({ license_text: licenseText }))
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.state).toBe('VALID')
    expect(body.license_id).toBe(licenseId)
    expect(body.tier).toBe('pro')
    expect(body.grace_period_days).toBe(21)
    expect(body.heartbeat_url).toBeTruthy()
    expect(body.new_license).toBeNull()
  })

  it('creates a VALIDATE audit event', async () => {
    await POST(validateReq({ license_text: licenseText }))

    const { db } = await import('@/lib/db')
    const events = await db.auditEvent.findMany({ where: { type: 'VALIDATE' } })
    expect(events).toHaveLength(1)
    expect(events[0].licenseId).toBe(licenseId)
  })

  // ── Revoked license ──────────────────────────────────────────────────────

  it('revoked license returns state=REVOKED', async () => {
    const { db } = await import('@/lib/db')
    await db.license.update({
      where: { id: licenseId },
      data: { status: 'revoked', revokedAt: new Date(), revokeReason: 'test' },
    })

    const res = await POST(validateReq({ license_text: licenseText }))
    expect(res.status).toBe(200)
    expect((await res.json()).state).toBe('REVOKED')
  })

  // ── Expired license ──────────────────────────────────────────────────────

  it('expired license returns state=EXPIRED', async () => {
    const { db } = await import('@/lib/db')
    await db.license.update({
      where: { id: licenseId },
      data: { expiresAt: new Date('2000-01-01') },
    })

    const res = await POST(validateReq({ license_text: licenseText }))
    expect(res.status).toBe(200)
    expect((await res.json()).state).toBe('EXPIRED')
  })

  // ── Signature / format errors ────────────────────────────────────────────

  it('tampered license text returns 422 invalid_license', async () => {
    // Decode payload, mutate a field, re-encode — still valid JSON + valid product_id
    // so parsing passes, but the original signature no longer matches.
    const dot = licenseText.lastIndexOf('.')
    const payloadB64 = licenseText.substring(0, dot)
    const sig = licenseText.substring(dot + 1)
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString())
    payload.tier = 'tampered'
    const tamperedB64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const res = await POST(validateReq({ license_text: `${tamperedB64}.${sig}` }))
    expect(res.status).toBe(422)
    expect((await res.json()).error).toBe('invalid_license')
  })

  it('malformed token (no dot separator) returns 422 malformed_license', async () => {
    const res = await POST(validateReq({ license_text: 'nodothere' }))
    expect(res.status).toBe(422)
    expect((await res.json()).error).toBe('malformed_license')
  })

  it('unknown product slug returns 422 invalid_license', async () => {
    // Build a token whose payload has a different product_id
    const { buildLicenseText } = await import('@/lib/crypto')
    const { generateProductKeypair } = await import('@/lib/crypto')
    const foreignKeypair = generateProductKeypair()
    const payload = {
      schema_version: 1,
      product_id: 'no-such-product',
      license_id: licenseId,
      customer_id: 'x',
      customer_name: 'x',
      instance_id: null,
      key_id: 'v1',
      issuer: 'x',
      tier: 'pro',
      features: [],
      limits: {},
      issued_at: '2026-01-01T00:00:00Z',
      not_before: '2026-01-01T00:00:00Z',
      expires_at: '2099-01-01T00:00:00Z',
      grace_period_days: 21,
      heartbeat_url: null,
    }
    const text = buildLicenseText(payload, foreignKeypair.privateKeyEnc)
    const res = await POST(validateReq({ license_text: text }))
    expect(res.status).toBe(422)
    expect((await res.json()).error).toBe('invalid_license')
  })

  it('valid sig but license not in DB returns 404', async () => {
    const { db } = await import('@/lib/db')
    await db.license.delete({ where: { id: licenseId } })

    const res = await POST(validateReq({ license_text: licenseText }))
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('license_not_found')
  })

  // ── Request validation ───────────────────────────────────────────────────

  it('missing license_text returns 400', async () => {
    const res = await POST(validateReq({}))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('license_text required')
  })

  it('invalid JSON body returns 400', async () => {
    const req = new NextRequest('http://localhost/api/v1/validate', {
      method: 'POST',
      body: 'not-json',
      headers: { 'Content-Type': 'application/json' },
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_json')
  })

  // ── Rate limiting ────────────────────────────────────────────────────────

  it('returns 429 after 30 requests from same IP within 1 minute', async () => {
    // The rate limiter is reset between tests by vitest.setup.ts
    let lastRes: Response | null = null
    for (let i = 0; i < 31; i++) {
      lastRes = await POST(validateReq({ license_text: licenseText }))
    }
    expect(lastRes!.status).toBe(429)
    expect((await lastRes!.json()).error).toBe('rate_limited')
  })
})
