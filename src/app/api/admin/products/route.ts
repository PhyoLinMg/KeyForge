import { NextRequest } from 'next/server'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { generateProductKeypair } from '@/lib/crypto'
import { requireAdminAuth } from '@/lib/auth'
import { parsePagination, paginatedResponse } from '@/lib/pagination'

const CreateProductSchema = z.object({
  name: z.string().min(1).max(255),
  slug: z.string().min(1).max(100).regex(/^[A-Za-z0-9-]+$/, 'slug may only contain letters, digits, and hyphens'),
  keyId: z.string().max(32).optional(),
  issuerName: z.string().max(255).optional(),
})

export async function GET(req: NextRequest) {
  const err = await requireAdminAuth(req)
  if (err) return err

  const pagination = parsePagination(req)
  const select = {
    id: true,
    name: true,
    slug: true,
    keyId: true,
    publicKeyB64: true,
    issuerName: true,
    createdAt: true,
    _count: { select: { licenses: true } },
  }

  const [products, total] = await db.$transaction([
    db.product.findMany({ orderBy: { createdAt: 'desc' }, select, skip: pagination.skip, take: pagination.take }),
    db.product.count(),
  ])

  return paginatedResponse(products, total, pagination, req.url)
}

export async function POST(req: NextRequest) {
  const err = await requireAdminAuth(req)
  if (err) return err

  let body: unknown
  try { body = await req.json() } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const parsed = CreateProductSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json({ error: 'validation_error', details: parsed.error.flatten().fieldErrors }, { status: 400 })
  }
  const { name, slug, keyId = 'v1', issuerName } = parsed.data

  const keypair = generateProductKeypair()

  let product
  try {
    product = await db.product.create({
      data: {
        name,
        slug,
        keyId,
        publicKeyB64: keypair.publicKeyB64,
        privateKeyEnc: keypair.privateKeyEnc,
        issuerName: issuerName ?? `${slug}-license-server`,
      },
      select: {
        id: true,
        name: true,
        slug: true,
        keyId: true,
        publicKeyB64: true,
        issuerName: true,
        createdAt: true,
      },
    })
  } catch (e: unknown) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return Response.json({ error: 'slug_exists' }, { status: 409 })
    }
    throw e
  }

  await db.auditEvent.create({
    data: { type: 'PRODUCT_CREATE', payload: { productId: product.id, name, slug } },
  })

  return Response.json(product, { status: 201 })
}
