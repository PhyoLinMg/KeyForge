import { describe, it, expect, beforeEach } from 'vitest'
import { GET as LIST_GET, POST as LIST_POST } from '@/app/api/admin/licenses/route'
import { GET as DETAIL_GET } from '@/app/api/admin/licenses/[id]/route'
import { adminRequest, unauthRequest, truncateAll, createProduct, createCustomer } from '@/__tests__/helpers'
import { verifyLicenseText, parseLicensePayload } from '@/lib/crypto'

describe('Admin licenses API', () => {
  let productId: string
  let customerId: string

  beforeEach(async () => {
    await truncateAll()
    const product = await createProduct()
    const customer = await createCustomer()
    productId = product.id
    customerId = customer.id
  })

  // ── GET list ─────────────────────────────────────────────────────────────

  it('GET / returns empty paginated list initially', async () => {
    const req = await adminRequest('http://localhost/api/admin/licenses')
    const res = await LIST_GET(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual([])
    expect(body.pagination.total).toBe(0)
    expect(body.pagination.page).toBe(1)
    expect(res.headers.get('X-Total-Count')).toBe('0')
  })

  it('GET / returns 401 without auth', async () => {
    const req = unauthRequest('http://localhost/api/admin/licenses')
    const res = await LIST_GET(req)
    expect(res.status).toBe(401)
  })

  it('GET / strips licenseText from list view and returns paginated shape', async () => {
    const createReq = await adminRequest('http://localhost/api/admin/licenses', {
      method: 'POST',
      body: JSON.stringify({
        productId,
        customerId,
        tier: 'pro',
        expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
      }),
      headers: { 'Content-Type': 'application/json' },
    })
    await LIST_POST(createReq)

    const listReq = await adminRequest('http://localhost/api/admin/licenses')
    const res = await LIST_GET(listReq)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0]).not.toHaveProperty('licenseText')
    expect(body.data[0]).not.toHaveProperty('payloadJson')
    expect(body.pagination.total).toBe(1)
    expect(res.headers.get('X-Total-Count')).toBe('1')
  })

  // ── POST create ──────────────────────────────────────────────────────────

  it('POST / issues a license and returns 201', async () => {
    const req = await adminRequest('http://localhost/api/admin/licenses', {
      method: 'POST',
      body: JSON.stringify({
        productId,
        customerId,
        tier: 'pro',
        features: ['intake', 'reporting'],
        limits: { max_clients: 100 },
        expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
        gracePeriodDays: 21,
      }),
      headers: { 'Content-Type': 'application/json' },
    })
    const res = await LIST_POST(req)
    expect(res.status).toBe(201)

    const license = await res.json()
    expect(license.tier).toBe('pro')
    expect(license.licenseText).toBeTruthy()
    expect(license.customer.id).toBe(customerId)
    expect(license.product.id).toBe(productId)
  })

  it('POST / returns 400 when required fields are missing', async () => {
    const req = await adminRequest('http://localhost/api/admin/licenses', {
      method: 'POST',
      body: JSON.stringify({ productId }),
      headers: { 'Content-Type': 'application/json' },
    })
    const res = await LIST_POST(req)
    expect(res.status).toBe(400)
  })

  it('POST / returns 404 for non-existent product', async () => {
    const req = await adminRequest('http://localhost/api/admin/licenses', {
      method: 'POST',
      body: JSON.stringify({
        productId: '00000000-0000-0000-0000-000000000000',
        customerId,
        tier: 'pro',
        expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
      }),
      headers: { 'Content-Type': 'application/json' },
    })
    const res = await LIST_POST(req)
    expect(res.status).toBe(404)
  })

  it('POST / returns 404 for non-existent customer', async () => {
    const req = await adminRequest('http://localhost/api/admin/licenses', {
      method: 'POST',
      body: JSON.stringify({
        productId,
        customerId: '00000000-0000-0000-0000-000000000000',
        tier: 'pro',
        expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
      }),
      headers: { 'Content-Type': 'application/json' },
    })
    const res = await LIST_POST(req)
    expect(res.status).toBe(404)
  })

  it('POST / returns 401 without auth', async () => {
    const req = unauthRequest('http://localhost/api/admin/licenses', {
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
    expect(res.status).toBe(401)
  })

  // ── License signing round-trip ───────────────────────────────────────────

  it('issued license text verifies against the product public key', async () => {
    const createReq = await adminRequest('http://localhost/api/admin/licenses', {
      method: 'POST',
      body: JSON.stringify({
        productId,
        customerId,
        tier: 'starter',
        expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
      }),
      headers: { 'Content-Type': 'application/json' },
    })
    const res = await LIST_POST(createReq)
    const license = await res.json()

    const { db } = await import('@/lib/db')
    const product = await db.product.findUnique({ where: { id: productId } })

    expect(verifyLicenseText(license.licenseText, product!.publicKeyB64)).toBe(true)

    const payload = parseLicensePayload(license.licenseText)
    expect(payload.tier).toBe('starter')
    expect(payload.customer_id).toBe(customerId)
    expect(payload.instance_id).toBeNull()
  })

  it('POST / creates an ISSUE audit event', async () => {
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
    const license = await res.json()

    const { db } = await import('@/lib/db')
    const events = await db.auditEvent.findMany({ where: { type: 'ISSUE' } })
    expect(events).toHaveLength(1)
    expect(events[0].licenseId).toBe(license.id)
  })

  // ── GET detail ───────────────────────────────────────────────────────────

  it('GET /[id] returns full license with instances and audit events', async () => {
    const createReq = await adminRequest('http://localhost/api/admin/licenses', {
      method: 'POST',
      body: JSON.stringify({
        productId,
        customerId,
        tier: 'pro',
        expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
      }),
      headers: { 'Content-Type': 'application/json' },
    })
    const createRes = await LIST_POST(createReq)
    const { id } = await createRes.json()

    const detailReq = await adminRequest(`http://localhost/api/admin/licenses/${id}`)
    const res = await DETAIL_GET(detailReq, { params: Promise.resolve({ id }) })
    expect(res.status).toBe(200)

    const detail = await res.json()
    expect(detail.id).toBe(id)
    expect(detail.licenseText).toBeTruthy()
    expect(detail.instances).toEqual([])
    expect(detail.auditEvents.length).toBeGreaterThanOrEqual(1)
  })

  it('GET /[id] serializes a bound instance (BigInt latestSequence as string)', async () => {
    const createReq = await adminRequest('http://localhost/api/admin/licenses', {
      method: 'POST',
      body: JSON.stringify({
        productId,
        customerId,
        tier: 'pro',
        expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
      }),
      headers: { 'Content-Type': 'application/json' },
    })
    const createRes = await LIST_POST(createReq)
    const { id } = await createRes.json()

    const { db } = await import('@/lib/db')
    await db.instance.create({
      data: {
        licenseId: id,
        instanceUuid: crypto.randomUUID(),
        publicKey: 'AAAA',
        latestSequence: BigInt(42),
      },
    })

    const detailReq = await adminRequest(`http://localhost/api/admin/licenses/${id}`)
    const res = await DETAIL_GET(detailReq, { params: Promise.resolve({ id }) })
    expect(res.status).toBe(200)

    const detail = await res.json()
    expect(detail.instances).toHaveLength(1)
    expect(detail.instances[0].latestSequence).toBe('42')
  })

  it('GET /[id] returns 404 for unknown id', async () => {
    const req = await adminRequest('http://localhost/api/admin/licenses/nonexistent')
    const res = await DETAIL_GET(req, { params: Promise.resolve({ id: 'nonexistent' }) })
    expect(res.status).toBe(404)
  })

  it('GET /[id] returns 401 without auth', async () => {
    const req = unauthRequest('http://localhost/api/admin/licenses/some-id')
    const res = await DETAIL_GET(req, { params: Promise.resolve({ id: 'some-id' }) })
    expect(res.status).toBe(401)
  })
})
