import { describe, it, expect, beforeEach } from 'vitest'
import { POST } from '@/app/api/v1/heartbeat/route'
import { NextRequest } from 'next/server'
import { randomUUID } from 'crypto'
import {
  truncateAll,
  createProduct,
  createCustomer,
  createLicense,
  generateInstanceKeypair,
} from '@/__tests__/helpers'
import { canonicalJson, verifyInstanceSignature } from '@/lib/crypto'
import type { InstanceKeypair } from '@/__tests__/helpers'

function heartbeatReq(body: object): NextRequest {
  return new NextRequest('http://localhost/api/v1/heartbeat', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  })
}

function buildHeartbeatBody(opts: {
  licenseId: string
  instanceId: string
  sequence: number
  keypair: InstanceKeypair
  isFirst?: boolean
  overrides?: Record<string, unknown>
}) {
  const { licenseId, instanceId, sequence, keypair, isFirst, overrides } = opts
  const nonce = randomUUID()

  const body: Record<string, unknown> = {
    license_id: licenseId,
    instance_id: instanceId,
    sequence,
    nonce,
    version: '1.0.0',
    now: new Date().toISOString(),
    ...overrides,
  }

  if (isFirst) {
    body.instance_public_key = keypair.publicKeyB64
  }

  const { signature: _sig, instance_public_key: _ipk, ...toSign } = body
  body.signature = keypair.signPayload(toSign)

  return body
}

describe('POST /api/v1/heartbeat', () => {
  let licenseId: string
  let instanceId: string
  let keypair: InstanceKeypair

  beforeEach(async () => {
    await truncateAll()
    const product = await createProduct()
    const customer = await createCustomer()
    const license = await createLicense({ productId: product.id, customerId: customer.id })
    licenseId = license.id

    instanceId = randomUUID()
    keypair = generateInstanceKeypair()
  })

  // ── First heartbeat (bind) ───────────────────────────────────────────────

  it('first heartbeat binds the instance and returns ok', async () => {
    const body = buildHeartbeatBody({
      licenseId,
      instanceId,
      sequence: 1,
      keypair,
      isFirst: true,
    })
    const res = await POST(heartbeatReq(body))
    expect(res.status).toBe(200)

    const result = await res.json()
    expect(result.status).toBe('ok')
    expect(result.signature).toBeTruthy()
    expect(result.enforcement.state).toBe('VALID')

    const { db } = await import('@/lib/db')
    const license = await db.license.findUnique({
      where: { id: licenseId },
      include: { instances: true },
    })
    expect(license!.instanceId).toBe(instanceId)
    expect(license!.instances).toHaveLength(1)
    expect(license!.instances[0].publicKey).toBe(keypair.publicKeyB64)
  })

  it('first heartbeat without instance_public_key returns 400', async () => {
    const body = buildHeartbeatBody({
      licenseId,
      instanceId,
      sequence: 1,
      keypair,
      isFirst: false, // omit instance_public_key
    })
    const res = await POST(heartbeatReq(body))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('instance_public_key_required_on_first_heartbeat')
  })

  // ── Subsequent heartbeat ─────────────────────────────────────────────────

  it('subsequent heartbeat with correct signature succeeds', async () => {
    // Bind first
    const firstBody = buildHeartbeatBody({
      licenseId,
      instanceId,
      sequence: 1,
      keypair,
      isFirst: true,
    })
    await POST(heartbeatReq(firstBody))

    // Subsequent
    const secondBody = buildHeartbeatBody({
      licenseId,
      instanceId,
      sequence: 2,
      keypair,
    })
    const res = await POST(heartbeatReq(secondBody))
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('ok')
  })

  it('heartbeat with replayed sequence returns 400', async () => {
    const firstBody = buildHeartbeatBody({
      licenseId,
      instanceId,
      sequence: 1,
      keypair,
      isFirst: true,
    })
    await POST(heartbeatReq(firstBody))

    const replayBody = buildHeartbeatBody({
      licenseId,
      instanceId,
      sequence: 1,
      keypair,
    })
    const res = await POST(heartbeatReq(replayBody))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('replay_rejected')
  })

  it('stale sequence with wrong signature returns 401, not replay_rejected (no sequence oracle)', async () => {
    const firstBody = buildHeartbeatBody({
      licenseId,
      instanceId,
      sequence: 5,
      keypair,
      isFirst: true,
    })
    await POST(heartbeatReq(firstBody))

    // Unauthenticated probe: stale sequence + garbage signature.
    // Must fail signature check, not reveal that the sequence is stale.
    const probeBody = buildHeartbeatBody({
      licenseId,
      instanceId,
      sequence: 3,
      keypair,
    })
    probeBody.signature = 'AAAA'
    const res = await POST(heartbeatReq(probeBody))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('invalid_signature')
  })

  it('heartbeat with wrong signature returns 401', async () => {
    const firstBody = buildHeartbeatBody({
      licenseId,
      instanceId,
      sequence: 1,
      keypair,
      isFirst: true,
    })
    await POST(heartbeatReq(firstBody))

    const otherKeypair = generateInstanceKeypair()
    const badBody = buildHeartbeatBody({
      licenseId,
      instanceId,
      sequence: 2,
      keypair: otherKeypair, // wrong key
    })
    const res = await POST(heartbeatReq(badBody))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('invalid_signature')
  })

  it('different instance_id on bound license returns 409', async () => {
    const firstBody = buildHeartbeatBody({
      licenseId,
      instanceId,
      sequence: 1,
      keypair,
      isFirst: true,
    })
    await POST(heartbeatReq(firstBody))

    const otherKeypair = generateInstanceKeypair()
    const otherInstanceId = randomUUID()
    const conflictBody = buildHeartbeatBody({
      licenseId,
      instanceId: otherInstanceId,
      sequence: 1,
      keypair: otherKeypair,
      isFirst: true,
    })
    const res = await POST(heartbeatReq(conflictBody))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('license_already_bound')
  })

  // ── Revoked license ──────────────────────────────────────────────────────

  it('heartbeat on revoked license returns revoked response', async () => {
    const { db } = await import('@/lib/db')
    await db.license.update({
      where: { id: licenseId },
      data: { status: 'revoked', revokedAt: new Date(), revokeReason: 'test' },
    })

    const body = buildHeartbeatBody({
      licenseId,
      instanceId,
      sequence: 1,
      keypair,
      isFirst: true,
    })
    const res = await POST(heartbeatReq(body))
    expect(res.status).toBe(200)

    const result = await res.json()
    expect(result.status).toBe('revoked')
    expect(result.enforcement.state).toBe('REVOKED')
  })

  // ── Validation ───────────────────────────────────────────────────────────

  it('returns 400 for missing fields', async () => {
    const res = await POST(heartbeatReq({ license_id: licenseId }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('missing_fields')
  })

  it('returns 400 for invalid license_id UUID', async () => {
    const body = buildHeartbeatBody({
      licenseId: 'not-a-uuid',
      instanceId,
      sequence: 1,
      keypair,
      isFirst: true,
    })
    const res = await POST(heartbeatReq(body))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_license_id')
  })

  it('returns 400 for invalid instance_id UUID', async () => {
    const body = buildHeartbeatBody({
      licenseId,
      instanceId: 'not-a-uuid',
      sequence: 1,
      keypair,
      isFirst: true,
    })
    const res = await POST(heartbeatReq(body))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_instance_id')
  })

  it('returns 400 for invalid sequence', async () => {
    const body = buildHeartbeatBody({
      licenseId,
      instanceId,
      sequence: -1,
      keypair,
      isFirst: true,
    })
    const res = await POST(heartbeatReq(body))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_sequence')
  })

  it('returns 404 for non-existent license', async () => {
    const fake = randomUUID()
    const body = buildHeartbeatBody({
      licenseId: fake,
      instanceId,
      sequence: 1,
      keypair,
      isFirst: true,
    })
    const res = await POST(heartbeatReq(body))
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('license_not_found')
  })

  // ── Defensive guard: null publicKey ──────────────────────────────────────

  it('returns 500 instance_key_missing if bound instance has null publicKey', async () => {
    // Bind the instance
    const firstBody = buildHeartbeatBody({
      licenseId,
      instanceId,
      sequence: 1,
      keypair,
      isFirst: true,
    })
    await POST(heartbeatReq(firstBody))

    // Corrupt the DB: null out publicKey to simulate the defensive edge case
    const { db } = await import('@/lib/db')
    await db.instance.update({
      where: { instanceUuid: instanceId },
      data: { publicKey: null },
    })

    const secondBody = buildHeartbeatBody({
      licenseId,
      instanceId,
      sequence: 2,
      keypair,
    })
    const res = await POST(heartbeatReq(secondBody))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('instance_key_missing')
  })

  // ── Response signing ─────────────────────────────────────────────────────

  it('response signature verifies against the product public key', async () => {
    const body = buildHeartbeatBody({
      licenseId,
      instanceId,
      sequence: 1,
      keypair,
      isFirst: true,
    })
    const res = await POST(heartbeatReq(body))
    const result = await res.json()

    const { db } = await import('@/lib/db')
    const license = await db.license.findUnique({
      where: { id: licenseId },
      include: { product: true },
    })

    const { signature, ...responseBody } = result
    const valid = verifyInstanceSignature(
      canonicalJson(responseBody),
      signature,
      license!.product.publicKeyB64,
    )
    expect(valid).toBe(true)
  })

  // ── Nonce replay ─────────────────────────────────────────────────────────

  it('rejects replayed nonce', async () => {
    const firstBody = buildHeartbeatBody({
      licenseId,
      instanceId,
      sequence: 1,
      keypair,
      isFirst: true,
    })
    await POST(heartbeatReq(firstBody))

    // Replay the exact same body (same nonce, same sequence)
    const res = await POST(heartbeatReq(firstBody))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('replay_rejected')
  })

  // ── Rate limiting ────────────────────────────────────────────────────────

  it('returns 429 after 5 requests from same license within 1 minute', async () => {
    // Rate limiter reset between tests by vitest.setup.ts (__resetForTesting)
    let lastRes: Response | null = null
    for (let i = 1; i <= 6; i++) {
      const body = buildHeartbeatBody({
        licenseId,
        instanceId,
        sequence: i,
        keypair,
        isFirst: i === 1,
      })
      lastRes = await POST(heartbeatReq(body))
    }
    expect(lastRes!.status).toBe(429)
    expect((await lastRes!.json()).error).toBe('rate_limited')
  })
})
