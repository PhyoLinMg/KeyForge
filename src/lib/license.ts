import { buildLicenseText } from './crypto'

export interface LicensePayload {
  schema_version: number
  issuer: string
  key_id: string
  license_id: string
  product_id: string
  customer_id: string
  customer_name: string
  instance_id: string | null
  tier: string
  features: string[]
  limits: Record<string, number>
  issued_at: string      // RFC3339 UTC
  not_before: string
  expires_at: string
  grace_period_days: number
  heartbeat_url: string | null
}

export interface IssueLicenseInput {
  licenseId: string
  productSlug: string
  productIssuer: string
  keyId: string
  customerId: string
  customerName: string
  tier: string
  features: string[]
  limits: Record<string, number>
  notBefore: Date
  expiresAt: Date
  gracePeriodDays: number
  heartbeatUrl: string | null
  privateKeyEnc: string
}

export function buildPayload(input: IssueLicenseInput): LicensePayload {
  return {
    schema_version: 1,
    issuer: input.productIssuer,
    key_id: input.keyId,
    license_id: input.licenseId,
    product_id: input.productSlug,
    customer_id: input.customerId,
    customer_name: input.customerName,
    instance_id: null,
    tier: input.tier,
    features: input.features,
    limits: input.limits,
    issued_at: toRfc3339(new Date()),
    not_before: toRfc3339(input.notBefore),
    expires_at: toRfc3339(input.expiresAt),
    grace_period_days: input.gracePeriodDays,
    heartbeat_url: input.heartbeatUrl,
  }
}

export function issueLicense(input: IssueLicenseInput): { payload: LicensePayload; text: string } {
  const payload = buildPayload(input)
  const text = buildLicenseText(payload, input.privateKeyEnc)
  return { payload, text }
}

export function toRfc3339(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}
