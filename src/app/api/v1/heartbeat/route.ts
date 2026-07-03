import { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { canonicalJson, verifyInstanceSignature, signHeartbeatResponse } from '@/lib/crypto'
import { toRfc3339 } from '@/lib/license'
import { buildEnforcementInfo } from '@/lib/enforce'
import { getClientIp } from '@/lib/request'
import { allow, claimNonce } from '@/lib/ratelimit'
import type { Prisma } from '@prisma/client'

// POST /api/v1/heartbeat
// Body (JSON):
// {
//   license_id, instance_id, version, usage: {...},
//   now, nonce, sequence,
//   signature: base64url(Ed25519 over canonical_json of all other fields),
//   instance_public_key?: base64 SPKI DER (first heartbeat only)
// }

const HeartbeatBodySchema = z.object({
  license_id: z.string().uuid(),
  instance_id: z.string().uuid(),
  version: z.string().optional(),
  usage: z.record(z.string(), z.unknown()).optional(),
  now: z.string().optional(),
  nonce: z.string().min(1).max(256),
  sequence: z.number().int().min(0),
  signature: z.string().min(1),
  instance_public_key: z.string().optional(),
})

type ParsedBody = z.infer<typeof HeartbeatBodySchema>

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return hbError(400, 'invalid_json')
  }

  // Presence check first — preserves specific missing_fields error code for required fields
  const { license_id, instance_id, nonce, sequence, signature } = body
  if (!license_id || !instance_id || !nonce || sequence === undefined || !signature) {
    return hbError(400, 'missing_fields')
  }

  // Type/format validation — eliminates all `as T` casts on user-supplied fields
  const parsed = HeartbeatBodySchema.safeParse(body)
  if (!parsed.success) {
    const paths = new Set(parsed.error.issues.map(i => i.path[0] as string))
    if (paths.has('license_id')) return hbError(400, 'invalid_license_id')
    if (paths.has('instance_id')) return hbError(400, 'invalid_instance_id')
    if (paths.has('sequence')) return hbError(400, 'invalid_sequence')
    return hbError(400, 'invalid_request')
  }

  const data = parsed.data

  // Rate-limit per licenseId+IP pair: prevents a third party with the license file
  // from exhausting the 5-req/min window before the legitimate instance can poll.
  // Keying on licenseId alone lets any holder of the license token DoS the real instance.
  const ip = getClientIp(req) ?? 'unknown'
  const rl = allow(`heartbeat:${data.license_id}:${ip}`, 5, 60_000)
  if (!rl.ok) {
    return new Response(JSON.stringify({ error: 'rate_limited' }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'X-RateLimit-Limit': String(rl.limit),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(Math.ceil(rl.resetAt / 1000)),
      },
    })
  }

  // Load license
  const license = await db.license.findUnique({
    where: { id: data.license_id },
    include: { product: true },
  })
  if (!license) return hbError(404, 'license_not_found')

  // Revoked → tell instance immediately
  if (license.status === 'revoked') {
    return signedResponse(license.product.privateKeyEnc, {
      status: 'revoked',
      server_time: toRfc3339(new Date()),
      new_license: null,
      enforcement: buildEnforcementInfo(license),
    })
  }

  const boundId = license.instanceId

  if (boundId !== null && boundId !== data.instance_id) {
    return hbError(409, 'license_already_bound')
  }

  if (boundId === null) {
    const err = await bindInstance({ data, body, licenseId: license.id, req })
    if (err) return err
  } else {
    const err = await verifyAndUpdateBound({ data, body, instanceId: data.instance_id })
    if (err) return err
  }

  await db.auditEvent.create({
    data: {
      licenseId: license.id,
      type: 'HEARTBEAT',
      payload: {
        instance_id: data.instance_id,
        version: data.version ?? null,
        usage: (data.usage ?? null) as Prisma.InputJsonValue,
        sequence: data.sequence,
        client_ip: getClientIp(req),
      } as Prisma.InputJsonValue,
    },
  })

  return signedResponse(license.product.privateKeyEnc, {
    status: 'ok',
    server_time: toRfc3339(new Date()),
    new_license: null,
    enforcement: buildEnforcementInfo(license),
  })
}

async function bindInstance(opts: {
  data: ParsedBody
  body: Record<string, unknown>
  licenseId: string
  req: NextRequest
}): Promise<Response | null> {
  const { data, body, licenseId, req } = opts

  if (!data.instance_public_key) return hbError(400, 'instance_public_key_required_on_first_heartbeat')

  // Proof-of-possession: verify signature against the provided public key before binding.
  // Prevents an attacker from claiming a license with a key they don't control.
  // Use raw body (not parsed.data) — Zod strips unknown keys, which would break the
  // canonical JSON the client signed.
  const { signature: _sig0, instance_public_key: _ipk0, ...toSign0 } = body
  if (!verifyInstanceSignature(canonicalJson(toSign0), data.signature, data.instance_public_key)) {
    return hbError(401, 'invalid_signature')
  }

  // Claim nonce only after signature is verified — unauthenticated requests must not
  // consume nonce slots and pollute the dedup map.
  if (!claimNonce('hb', `${licenseId}:${data.nonce}`)) {
    return hbError(400, 'replay_rejected')
  }

  try {
    await db.$transaction(async (tx) => {
      const bound = await tx.license.updateMany({
        where: { id: licenseId, instanceId: null },
        data: { instanceId: data.instance_id },
      })
      if (bound.count === 0) throw new Error('license_already_bound')

      await tx.instance.create({
        data: {
          licenseId,
          instanceUuid: data.instance_id,
          publicKey: data.instance_public_key,
          latestSequence: BigInt(data.sequence),
          lastVersion: data.version ?? null,
          lastUsage: (data.usage ?? null) as Prisma.InputJsonValue,
        },
      })

      await tx.auditEvent.create({
        data: {
          licenseId,
          type: 'INSTANCE_BIND',
          payload: {
            instance_id: data.instance_id,
            client_ip: getClientIp(req),
          } as Prisma.InputJsonValue,
        },
      })
    })
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'license_already_bound') {
      return hbError(409, 'license_already_bound')
    }
    throw err
  }

  return null
}

async function verifyAndUpdateBound(opts: {
  data: ParsedBody
  body: Record<string, unknown>
  instanceId: string
}): Promise<Response | null> {
  const { data, body, instanceId } = opts

  const instance = await db.instance.findUnique({
    where: { instanceUuid: instanceId },
  })
  if (!instance) return hbError(500, 'instance_record_missing')

  // Verify instance signature first — hard-fail if key is missing on a bound instance.
  // Signature must be checked before the sequence: distinguishable replay_rejected /
  // invalid_signature responses would let an unauthenticated caller binary-search
  // the current sequence counter.
  if (!instance.publicKey) return hbError(500, 'instance_key_missing')
  const { signature: _sig, instance_public_key: _ipk, ...toSign } = body
  const payloadBytes = canonicalJson(toSign)
  const valid = verifyInstanceSignature(payloadBytes, data.signature, instance.publicKey)
  if (!valid) return hbError(401, 'invalid_signature')

  // Replay protection: sequence must be strictly increasing
  if (BigInt(data.sequence) <= instance.latestSequence) {
    return hbError(400, 'replay_rejected')
  }

  // Claim nonce after signature is verified — only authenticated requests consume a slot.
  if (!claimNonce('hb', `${data.license_id}:${data.nonce}`)) {
    return hbError(400, 'replay_rejected')
  }

  // Guarded update: two concurrent heartbeats with the same sequence both pass the
  // read-check above; only one may commit.
  const updated = await db.instance.updateMany({
    where: { id: instance.id, latestSequence: { lt: BigInt(data.sequence) } },
    data: {
      latestSequence: BigInt(data.sequence),
      lastSeenAt: new Date(),
      lastVersion: data.version ?? null,
      lastUsage: (data.usage ?? null) as Prisma.InputJsonValue,
    },
  })
  if (updated.count === 0) return hbError(400, 'replay_rejected')

  return null
}

function hbError(status: number, code: string) {
  return Response.json({ error: code }, { status })
}

function signedResponse(privateKeyEnc: string, body: object) {
  const sig = signHeartbeatResponse(body, privateKeyEnc)
  return Response.json({ ...body, signature: sig })
}
