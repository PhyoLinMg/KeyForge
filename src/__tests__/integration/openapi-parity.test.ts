import { describe, it, expect, beforeEach } from 'vitest'
import { readdirSync } from 'fs'
import { join, resolve, sep } from 'path'
import { randomUUID } from 'crypto'
import { buildOpenApiDocument } from '@/lib/openapi'
import {
  adminRequest,
  adminJsonPost,
  unauthRequest,
  truncateAll,
  createProduct,
  createCustomer,
  createLicense,
  generateInstanceKeypair,
  TEST_PASSWORD,
} from '@/__tests__/helpers'
import { NextRequest } from 'next/server'
import { POST as LOGIN_POST } from '@/app/api/auth/login/route'
import { POST as LOGOUT_POST } from '@/app/api/auth/logout/route'
import { GET as CUSTOMERS_GET, POST as CUSTOMERS_POST } from '@/app/api/admin/customers/route'
import { GET as PRODUCTS_GET, POST as PRODUCTS_POST } from '@/app/api/admin/products/route'
import { GET as LICENSES_GET, POST as LICENSES_POST } from '@/app/api/admin/licenses/route'
import { GET as LICENSE_DETAIL_GET } from '@/app/api/admin/licenses/[id]/route'
import { POST as REVOKE_POST } from '@/app/api/admin/licenses/[id]/revoke/route'
import { POST as REBIND_POST } from '@/app/api/admin/licenses/[id]/rebind/route'
import { POST as PRUNE_POST } from '@/app/api/admin/audit/prune/route'
import { POST as VALIDATE_POST } from '@/app/api/v1/validate/route'
import { POST as HEARTBEAT_POST } from '@/app/api/v1/heartbeat/route'
import { db } from '@/lib/db'

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const

// Routes intentionally absent from the spec. Adding a route here must be a
// deliberate decision — anything not listed must be documented in openapi.ts.
const UNDOCUMENTED_PATHS = new Set([
  '/api/health',        // trivial liveness probe
  '/api/openapi.json',  // the spec itself
  '/api/proxy/{path}',  // deployment-specific reverse proxy, not part of the product API
])

const API_DIR = resolve(__dirname, '../../app/api')

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return routeFiles(full)
    return entry.name === 'route.ts' ? [full] : []
  })
}

// src/app/api/admin/licenses/[id]/route.ts → /api/admin/licenses/{id}
function specPathFor(file: string): string {
  const segments = file
    .slice(API_DIR.length, -'/route.ts'.length)
    .split(sep)
    .filter(Boolean)
    .map((seg) => seg.replace(/^\[(?:\.\.\.)?(.+?)\]$/, '{$1}'))
  return '/api/' + segments.join('/')
}

async function exportedMethods(file: string): Promise<string[]> {
  const mod: Record<string, unknown> = await import(file)
  return HTTP_METHODS.filter((m) => typeof mod[m] === 'function')
}

describe('OpenAPI spec ↔ implementation parity', () => {
  const doc = buildOpenApiDocument() as {
    paths: Record<string, Record<string, { responses: Record<string, unknown> }>>
  }

  // ── Level 1: every route is documented, every documented path exists ──────

  it('every implemented route+method is documented (or explicitly allowlisted)', async () => {
    const missing: string[] = []
    for (const file of routeFiles(API_DIR)) {
      const specPath = specPathFor(file)
      if (UNDOCUMENTED_PATHS.has(specPath)) continue
      for (const method of await exportedMethods(file)) {
        if (!doc.paths[specPath]?.[method.toLowerCase()]) {
          missing.push(`${method} ${specPath}`)
        }
      }
    }
    expect(missing, `implemented but not in openapi.ts: ${missing.join(', ')}`).toEqual([])
  })

  it('every documented path+method has an implementation', async () => {
    const implemented = new Set<string>()
    for (const file of routeFiles(API_DIR)) {
      const specPath = specPathFor(file)
      for (const method of await exportedMethods(file)) {
        implemented.add(`${method.toLowerCase()} ${specPath}`)
      }
    }
    const stale: string[] = []
    for (const [specPath, methods] of Object.entries(doc.paths)) {
      for (const method of Object.keys(methods)) {
        if (!implemented.has(`${method} ${specPath}`)) stale.push(`${method} ${specPath}`)
      }
    }
    expect(stale, `documented but no route exports it: ${stale.join(', ')}`).toEqual([])
  })

  // ── Level 2: observed response statuses are documented ────────────────────
  //
  // Each scenario asserts two things: the endpoint behaves as expected
  // (status matches), and that status is documented in openapi.ts.

  function documentedStatuses(specPath: string, method: string): Set<string> {
    return new Set(Object.keys(doc.paths[specPath]?.[method]?.responses ?? {}))
  }

  function assertObserved(specPath: string, method: string, expected: number, res: Response) {
    expect(res.status, `${method.toUpperCase()} ${specPath}: scenario expected ${expected}, got ${res.status}`).toBe(expected)
    const documented = documentedStatuses(specPath, method)
    expect(
      documented.has(String(res.status)),
      `${method.toUpperCase()} ${specPath} returned ${res.status} but spec documents only: ${[...documented].sort().join(', ')}`,
    ).toBe(true)
  }

  beforeEach(truncateAll)

  // Shared fixtures
  async function issueLicenseViaApi() {
    const product = await createProduct()
    const customer = await createCustomer()
    const req = await adminRequest('http://localhost/api/admin/licenses', {
      method: 'POST',
      body: JSON.stringify({
        productId: product.id,
        customerId: customer.id,
        tier: 'pro',
        expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
      }),
      headers: { 'Content-Type': 'application/json' },
    })
    const res = await LICENSES_POST(req)
    return { res, body: await res.clone().json(), product, customer }
  }

  function jsonPost(url: string, body: object): NextRequest {
    return new NextRequest(url, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  it('POST /api/auth/login — 200, 401, 429', async () => {
    const path = '/api/auth/login'
    const login = (body: object) => LOGIN_POST(jsonPost(`http://localhost${path}`, body))

    assertObserved(path, 'post', 200, await login({ email: process.env.ADMIN_EMAIL!, password: TEST_PASSWORD }))
    assertObserved(path, 'post', 401, await login({ email: process.env.ADMIN_EMAIL!, password: 'wrong' }))

    // 10 attempts per 15 min per IP — drive the shared bucket to exhaustion
    let last: Response | undefined
    for (let i = 0; i < 12; i++) {
      last = await login({ email: 'x@x.x', password: 'wrong' })
      if (last.status === 429) break
    }
    assertObserved(path, 'post', 429, last!)
  })

  it('POST /api/auth/logout — 200', async () => {
    const res = await LOGOUT_POST(unauthRequest('http://localhost/api/auth/logout', { method: 'POST' }))
    assertObserved('/api/auth/logout', 'post', 200, res)
  })

  it('GET|POST /api/admin/customers — 200, 401, 201, 400', async () => {
    const path = '/api/admin/customers'
    assertObserved(path, 'get', 200, await CUSTOMERS_GET(await adminRequest(`http://localhost${path}`)))
    assertObserved(path, 'get', 401, await CUSTOMERS_GET(unauthRequest(`http://localhost${path}`)))
    assertObserved(path, 'post', 201, await CUSTOMERS_POST(await adminJsonPost(`http://localhost${path}`, { name: 'Acme' })))
    assertObserved(path, 'post', 400, await CUSTOMERS_POST(await adminJsonPost(`http://localhost${path}`, {})))
  })

  it('GET|POST /api/admin/products — 200, 401, 201, 400, 409', async () => {
    const path = '/api/admin/products'
    assertObserved(path, 'get', 200, await PRODUCTS_GET(await adminRequest(`http://localhost${path}`)))
    assertObserved(path, 'get', 401, await PRODUCTS_GET(unauthRequest(`http://localhost${path}`)))

    const make = async () => PRODUCTS_POST(await adminJsonPost(`http://localhost${path}`, { name: 'Parity', slug: 'parity' }))
    assertObserved(path, 'post', 201, await make())
    assertObserved(path, 'post', 409, await make())
    assertObserved(path, 'post', 400, await PRODUCTS_POST(await adminJsonPost(`http://localhost${path}`, {})))
  })

  it('GET|POST /api/admin/licenses — 200, 401, 201, 400, 404', async () => {
    const path = '/api/admin/licenses'
    assertObserved(path, 'get', 200, await LICENSES_GET(await adminRequest(`http://localhost${path}`)))
    assertObserved(path, 'get', 401, await LICENSES_GET(unauthRequest(`http://localhost${path}`)))

    const { res } = await issueLicenseViaApi()
    assertObserved(path, 'post', 201, res)
    assertObserved(path, 'post', 400, await LICENSES_POST(await adminJsonPost(`http://localhost${path}`, {})))
    assertObserved(path, 'post', 404, await LICENSES_POST(await adminJsonPost(`http://localhost${path}`, {
      productId: randomUUID(),
      customerId: randomUUID(),
      tier: 'pro',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    })))
  })

  it('GET /api/admin/licenses/{id} — 200, 404, 401', async () => {
    const path = '/api/admin/licenses/{id}'
    const { body } = await issueLicenseViaApi()

    const ok = await LICENSE_DETAIL_GET(
      await adminRequest(`http://localhost/api/admin/licenses/${body.id}`),
      { params: Promise.resolve({ id: body.id }) },
    )
    assertObserved(path, 'get', 200, ok)

    const missingId = randomUUID()
    const missing = await LICENSE_DETAIL_GET(
      await adminRequest(`http://localhost/api/admin/licenses/${missingId}`),
      { params: Promise.resolve({ id: missingId }) },
    )
    assertObserved(path, 'get', 404, missing)

    const unauth = await LICENSE_DETAIL_GET(
      unauthRequest(`http://localhost/api/admin/licenses/${body.id}`),
      { params: Promise.resolve({ id: body.id }) },
    )
    assertObserved(path, 'get', 401, unauth)
  })

  it('POST /api/admin/licenses/{id}/revoke — 200, 409, 400, 404, 401', async () => {
    const path = '/api/admin/licenses/{id}/revoke'
    const { body } = await issueLicenseViaApi()
    const revoke = async (id: string, reqBody: object) =>
      REVOKE_POST(await adminJsonPost(`http://localhost/api/admin/licenses/${id}/revoke`, reqBody), {
        params: Promise.resolve({ id }),
      })

    assertObserved(path, 'post', 200, await revoke(body.id, { reason: 'parity' }))
    assertObserved(path, 'post', 409, await revoke(body.id, { reason: 'again' }))
    assertObserved(path, 'post', 400, await revoke(body.id, {}))
    assertObserved(path, 'post', 404, await revoke(randomUUID(), { reason: 'gone' }))

    const unauth = await REVOKE_POST(
      unauthRequest(`http://localhost/api/admin/licenses/${body.id}/revoke`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'x' }),
        headers: { 'Content-Type': 'application/json' },
      }),
      { params: Promise.resolve({ id: body.id }) },
    )
    assertObserved(path, 'post', 401, unauth)
  })

  it('POST /api/admin/licenses/{id}/rebind — 200, 404, 409, 401', async () => {
    const path = '/api/admin/licenses/{id}/rebind'
    const rebind = async (id: string) =>
      REBIND_POST(await adminJsonPost(`http://localhost/api/admin/licenses/${id}/rebind`, {}), {
        params: Promise.resolve({ id }),
      })

    const product = await createProduct()
    const customer = await createCustomer()
    const bound = await createLicense(
      { productId: product.id, customerId: customer.id },
      { instanceId: randomUUID() },
    )
    assertObserved(path, 'post', 200, await rebind(bound.id))
    assertObserved(path, 'post', 404, await rebind(randomUUID()))

    const revoked = await createLicense(
      { productId: product.id, customerId: customer.id },
      { status: 'revoked' },
    )
    assertObserved(path, 'post', 409, await rebind(revoked.id))

    const unauth = await REBIND_POST(
      unauthRequest(`http://localhost/api/admin/licenses/${bound.id}/rebind`, { method: 'POST' }),
      { params: Promise.resolve({ id: bound.id }) },
    )
    assertObserved(path, 'post', 401, unauth)
  })

  it('POST /api/admin/audit/prune — 200, 400, 401', async () => {
    const path = '/api/admin/audit/prune'
    assertObserved(path, 'post', 200, await PRUNE_POST(await adminJsonPost(`http://localhost${path}`, { days: 120 })))
    assertObserved(path, 'post', 400, await PRUNE_POST(await adminJsonPost(`http://localhost${path}`, { days: 30 })))
    assertObserved(path, 'post', 401, await PRUNE_POST(unauthRequest(`http://localhost${path}`, { method: 'POST' })))
  })

  it('POST /api/v1/validate — 200, 400, 422, 404, 429', async () => {
    const path = '/api/v1/validate'
    const validate = (body: object) => VALIDATE_POST(jsonPost(`http://localhost${path}`, body))

    const { body } = await issueLicenseViaApi()
    assertObserved(path, 'post', 200, await validate({ license_text: body.licenseText }))
    assertObserved(path, 'post', 400, await validate({}))
    assertObserved(path, 'post', 422, await validate({ license_text: 'garbage' }))

    await db.auditEvent.deleteMany({ where: { licenseId: body.id } })
    await db.license.delete({ where: { id: body.id } })
    assertObserved(path, 'post', 404, await validate({ license_text: body.licenseText }))

    // 30 req/min shared bucket — drive to exhaustion
    let last: Response | undefined
    for (let i = 0; i < 31; i++) {
      last = await validate({})
      if (last.status === 429) break
    }
    assertObserved(path, 'post', 429, last!)
  })

  it('POST /api/v1/heartbeat — 200, 400, 404, 409, 401, 429', async () => {
    const path = '/api/v1/heartbeat'
    const heartbeat = (body: object) => HEARTBEAT_POST(jsonPost(`http://localhost${path}`, body))

    const product = await createProduct()
    const customer = await createCustomer()
    const kp = generateInstanceKeypair()

    // 200: first heartbeat binds
    const license = await createLicense({ productId: product.id, customerId: customer.id })
    const instanceId = randomUUID()
    const fields: Record<string, unknown> = {
      license_id: license.id,
      instance_id: instanceId,
      sequence: 1,
      nonce: randomUUID(),
      instance_public_key: kp.publicKeyB64,
    }
    const { instance_public_key: _ipk, ...toSign } = fields
    fields.signature = kp.signPayload(toSign)
    assertObserved(path, 'post', 200, await heartbeat(fields))

    // 400: missing fields
    assertObserved(path, 'post', 400, await heartbeat({}))

    // 404: unknown license (signature not reached)
    assertObserved(path, 'post', 404, await heartbeat({
      license_id: randomUUID(),
      instance_id: randomUUID(),
      sequence: 1,
      nonce: randomUUID(),
      signature: 'AAAA',
    }))

    // 409: bound to a different instance
    assertObserved(path, 'post', 409, await heartbeat({
      license_id: license.id,
      instance_id: randomUUID(),
      sequence: 2,
      nonce: randomUUID(),
      signature: 'AAAA',
    }))

    // 401: bound instance, garbage signature
    assertObserved(path, 'post', 401, await heartbeat({
      license_id: license.id,
      instance_id: instanceId,
      sequence: 2,
      nonce: randomUUID(),
      signature: 'AAAA',
    }))

    // 429: 5 req/min per license+IP — drive this license's bucket to exhaustion
    let last: Response | undefined
    for (let i = 0; i < 7; i++) {
      last = await heartbeat({
        license_id: license.id,
        instance_id: instanceId,
        sequence: 3,
        nonce: randomUUID(),
        signature: 'AAAA',
      })
      if (last.status === 429) break
    }
    assertObserved(path, 'post', 429, last!)
  })
})
