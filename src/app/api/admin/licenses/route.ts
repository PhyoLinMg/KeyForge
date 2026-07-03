import { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAdminAuth } from '@/lib/auth'
import { issueLicense } from '@/lib/license'
import { parsePagination, paginatedResponse } from '@/lib/pagination'
import { randomUUID } from 'crypto'
import type { Prisma } from '@prisma/client'

const IssueLicenseSchema = z.object({
  productId: z.string().uuid(),
  customerId: z.string().uuid(),
  tier: z.string().min(1).max(64),
  features: z.array(z.string().max(64)).max(100).optional(),
  limits: z.record(z.string().max(64), z.number()).optional(),
  notBefore: z.coerce.date().optional(),
  expiresAt: z.coerce.date(),
  gracePeriodDays: z.number().int().min(0).max(365).optional(),
  heartbeatUrl: z.url().max(2048).optional(),
})

export async function GET(req: NextRequest) {
  const err = await requireAdminAuth(req)
  if (err) return err

  const pagination = parsePagination(req)
  const query = {
    orderBy: { issuedAt: 'desc' } as const,
    include: {
      customer: { select: { id: true, name: true, email: true } },
      product: { select: { id: true, name: true, slug: true } },
      _count: { select: { instances: true } },
    },
  }

  const [licenses, total] = await db.$transaction([
    db.license.findMany({ ...query, skip: pagination.skip, take: pagination.take }),
    db.license.count(),
  ])

  return paginatedResponse(
    licenses.map(({ licenseText: _, payloadJson: __, ...l }) => l),
    total,
    pagination,
    req.url,
  )
}

export async function POST(req: NextRequest) {
  const err = await requireAdminAuth(req)
  if (err) return err

  let rawBody: unknown
  try { rawBody = await req.json() } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const parsed = IssueLicenseSchema.safeParse(rawBody)
  if (!parsed.success) {
    return Response.json({ error: 'validation_error', details: parsed.error.flatten().fieldErrors }, { status: 400 })
  }
  const {
    productId,
    customerId,
    tier,
    features = [],
    limits = {},
    notBefore,
    expiresAt,
    gracePeriodDays = 21,
    heartbeatUrl,
  } = parsed.data

  const [product, customer] = await Promise.all([
    db.product.findUnique({ where: { id: productId } }),
    db.customer.findUnique({ where: { id: customerId } }),
  ])

  if (!product) return Response.json({ error: 'product not found' }, { status: 404 })
  if (!customer) return Response.json({ error: 'customer not found' }, { status: 404 })

  const licenseId = randomUUID()
  const nbDate = notBefore ?? new Date()
  const expDate = expiresAt

  const defaultHeartbeatUrl =
    heartbeatUrl ??
    `${process.env.NEXT_PUBLIC_BASE_URL ?? 'https://license.example.com'}/api/v1/heartbeat`

  const { payload, text } = issueLicense({
    licenseId,
    productSlug: product.slug,
    productIssuer: product.issuerName,
    keyId: product.keyId,
    customerId: customer.id,
    customerName: customer.name,
    tier,
    features,
    limits,
    notBefore: nbDate,
    expiresAt: expDate,
    gracePeriodDays,
    heartbeatUrl: defaultHeartbeatUrl,
    privateKeyEnc: product.privateKeyEnc,
  })

  // Transaction: a license row without its ISSUE audit event must not exist
  const license = await db.$transaction(async (tx) => {
    const created = await tx.license.create({
      data: {
        id: licenseId,
        customerId: customer.id,
        productId: product.id,
        keyId: product.keyId,
        tier,
        features,
        limits,
        notBefore: nbDate,
        expiresAt: expDate,
        gracePeriodDays,
        heartbeatUrl: defaultHeartbeatUrl,
        status: 'active',
        payloadJson: payload as unknown as Prisma.InputJsonValue,
        signature: text.split('.')[1],
        licenseText: text,
      },
      include: {
        customer: { select: { id: true, name: true } },
        product: { select: { id: true, name: true, slug: true } },
      },
    })

    await tx.auditEvent.create({
      data: {
        licenseId: created.id,
        type: 'ISSUE',
        payload: {
          customerId: customer.id,
          customerName: customer.name,
          productId: product.id,
          tier,
          expiresAt: expDate.toISOString(),
        },
      },
    })

    return created
  })

  return Response.json(
    { ...license, licenseText: text, payloadJson: undefined },
    { status: 201 }
  )
}
