import { describe, it, expect, beforeAll } from 'vitest'
import { randomBytes, generateKeyPairSync, createPrivateKey, sign } from 'crypto'
import {
  encryptWithKek,
  decryptWithKek,
  canonicalJson,
  generateProductKeypair,
  buildLicenseText,
  parseLicensePayload,
  verifyLicenseText,
  verifyInstanceSignature,
  signHeartbeatResponse,
} from '@/lib/crypto'

// ── KEK helpers ───────────────────────────────────────────────────────────────

describe('KEK encrypt/decrypt', () => {
  beforeAll(() => {
    process.env.KEK_BASE64 = randomBytes(32).toString('base64')
  })

  it('roundtrip: decrypted output matches original plaintext', () => {
    const plain = Buffer.from('super-secret-private-key-bytes')
    const enc = encryptWithKek(plain)
    expect(decryptWithKek(enc)).toEqual(plain)
  })

  it('different encryptions of same plaintext produce different ciphertext (random IV)', () => {
    const plain = Buffer.from('same input')
    expect(encryptWithKek(plain)).not.toBe(encryptWithKek(plain))
  })

  it('tampered ciphertext fails GCM tag verification', () => {
    const enc = encryptWithKek(Buffer.from('data'))
    const buf = Buffer.from(enc, 'base64')
    buf[30] ^= 0xff // flip bits in ciphertext region
    expect(() => decryptWithKek(buf.toString('base64'))).toThrow()
  })

  it('wrong KEK (different key) fails decryption', () => {
    const enc = encryptWithKek(Buffer.from('data'))
    process.env.KEK_BASE64 = randomBytes(32).toString('base64') // swap key
    expect(() => decryptWithKek(enc)).toThrow()
    // restore for remaining tests
    process.env.KEK_BASE64 = randomBytes(32).toString('base64')
  })

  it('KEK_BASE64 of wrong length throws', () => {
    const saved = process.env.KEK_BASE64
    process.env.KEK_BASE64 = randomBytes(16).toString('base64') // 16 bytes, not 32
    expect(() => encryptWithKek(Buffer.from('x'))).toThrow('32 bytes')
    process.env.KEK_BASE64 = saved
  })

  it('missing KEK_BASE64 throws', () => {
    const saved = process.env.KEK_BASE64
    delete process.env.KEK_BASE64
    expect(() => encryptWithKek(Buffer.from('x'))).toThrow('KEK_BASE64')
    process.env.KEK_BASE64 = saved
  })
})

// ── canonicalJson ─────────────────────────────────────────────────────────────

describe('canonicalJson', () => {
  it('sorted keys — same output regardless of input key order', () => {
    const a = canonicalJson({ z: 1, a: 2, m: 3 })
    const b = canonicalJson({ m: 3, z: 1, a: 2 })
    expect(a.toString()).toBe(b.toString())
    expect(JSON.parse(a.toString())).toEqual({ a: 2, m: 3, z: 1 })
  })

  it('sorts nested object keys recursively', () => {
    const result = JSON.parse(canonicalJson({ b: { d: 1, c: 2 }, a: 0 }).toString())
    expect(Object.keys(result)).toEqual(['a', 'b'])
    expect(Object.keys(result.b)).toEqual(['c', 'd'])
  })

  it('preserves arrays without reordering elements', () => {
    const result = JSON.parse(canonicalJson({ arr: [3, 1, 2] }).toString())
    expect(result.arr).toEqual([3, 1, 2])
  })

  it('produces no whitespace', () => {
    const result = canonicalJson({ a: 1 }).toString()
    expect(result).toBe('{"a":1}')
  })

  it('is UTF-8 encoded', () => {
    const result = canonicalJson({ k: 'héllo' })
    expect(result).toBeInstanceOf(Buffer)
    expect(result.toString('utf-8')).toContain('héllo')
  })
})

// ── License sign / verify ─────────────────────────────────────────────────────

describe('license sign and verify', () => {
  let kek: string
  let keypair: ReturnType<typeof generateProductKeypair>
  let payload: object

  beforeAll(() => {
    kek = randomBytes(32).toString('base64')
    process.env.KEK_BASE64 = kek
    keypair = generateProductKeypair()
    payload = {
      schema_version: 1,
      license_id: 'test-license-id',
      product_id: 'test-product',
      customer_id: 'cust-1',
      tier: 'pro',
      expires_at: '2099-01-01T00:00:00Z',
    }
  })

  it('buildLicenseText produces a two-segment base64url string', () => {
    const text = buildLicenseText(payload, keypair.privateKeyEnc)
    const parts = text.split('.')
    expect(parts).toHaveLength(2)
    expect(parts[0]).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(parts[1]).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('verifyLicenseText returns true for a valid token', () => {
    const text = buildLicenseText(payload, keypair.privateKeyEnc)
    expect(verifyLicenseText(text, keypair.publicKeyB64)).toBe(true)
  })

  it('verifyLicenseText returns false when payload is tampered', () => {
    const text = buildLicenseText(payload, keypair.privateKeyEnc)
    const [payloadB64, sig] = text.split('.')
    // flip one character in the payload
    const tampered = payloadB64.slice(0, -1) + (payloadB64.endsWith('A') ? 'B' : 'A')
    expect(verifyLicenseText(`${tampered}.${sig}`, keypair.publicKeyB64)).toBe(false)
  })

  it('verifyLicenseText returns false with wrong public key', () => {
    const text = buildLicenseText(payload, keypair.privateKeyEnc)
    const otherKeypair = generateProductKeypair()
    expect(verifyLicenseText(text, otherKeypair.publicKeyB64)).toBe(false)
  })

  it('verifyLicenseText returns false for missing separator', () => {
    expect(verifyLicenseText('nodothere', keypair.publicKeyB64)).toBe(false)
  })

  it('verifyLicenseText returns false for empty string', () => {
    expect(verifyLicenseText('', keypair.publicKeyB64)).toBe(false)
  })

  it('parseLicensePayload roundtrips payload fields', () => {
    const text = buildLicenseText(payload, keypair.privateKeyEnc)
    const parsed = parseLicensePayload(text)
    expect(parsed.license_id).toBe('test-license-id')
    expect(parsed.tier).toBe('pro')
  })

  it('parseLicensePayload throws on malformed token (no dot)', () => {
    expect(() => parseLicensePayload('nodothere')).toThrow()
  })
})

// ── Instance heartbeat sig ────────────────────────────────────────────────────

describe('verifyInstanceSignature', () => {
  let instancePublicKeyB64: string
  let instancePrivateKey: ReturnType<typeof generateKeyPairSync>['privateKey']

  beforeAll(() => {
    process.env.KEK_BASE64 = randomBytes(32).toString('base64')
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    instancePrivateKey = privateKey
    const pubDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer
    instancePublicKeyB64 = pubDer.toString('base64')
  })

  function signPayload(payload: object): string {
    const bytes = canonicalJson(payload)
    const privDer = instancePrivateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer
    const key = createPrivateKey({ key: privDer, format: 'der', type: 'pkcs8' })
    return sign(null, bytes, key).toString('base64url')
  }

  it('verifies a correctly signed payload', () => {
    const payload = { license_id: 'abc', sequence: 1 }
    const sig = signPayload(payload)
    expect(verifyInstanceSignature(canonicalJson(payload), sig, instancePublicKeyB64)).toBe(true)
  })

  it('rejects a tampered payload', () => {
    const payload = { license_id: 'abc', sequence: 1 }
    const sig = signPayload(payload)
    const tampered = { license_id: 'abc', sequence: 2 }
    expect(verifyInstanceSignature(canonicalJson(tampered), sig, instancePublicKeyB64)).toBe(false)
  })

  it('rejects a signature from a different key', () => {
    const { publicKey: otherPub } = generateKeyPairSync('ed25519')
    const otherPubB64 = (otherPub.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64')
    const payload = { license_id: 'abc', sequence: 1 }
    const sig = signPayload(payload) // signed with original key
    expect(verifyInstanceSignature(canonicalJson(payload), sig, otherPubB64)).toBe(false)
  })

  it('handles base64url sig without padding (no = chars)', () => {
    const payload = { x: 1 }
    const sig = signPayload(payload).replace(/=+$/, '')
    expect(sig).not.toContain('=')
    expect(verifyInstanceSignature(canonicalJson(payload), sig, instancePublicKeyB64)).toBe(true)
  })
})

// ── signHeartbeatResponse ─────────────────────────────────────────────────────

describe('signHeartbeatResponse', () => {
  let kekBase64: string
  let serverKeypair: ReturnType<typeof generateProductKeypair>

  beforeAll(() => {
    kekBase64 = randomBytes(32).toString('base64')
    process.env.KEK_BASE64 = kekBase64
    serverKeypair = generateProductKeypair()
  })

  it('produces a signature that verifies against the product public key', () => {
    const body = { status: 'ok', server_time: '2099-01-01T00:00:00Z' }
    const sig = signHeartbeatResponse(body, serverKeypair.privateKeyEnc)
    expect(verifyInstanceSignature(canonicalJson(body), sig, serverKeypair.publicKeyB64)).toBe(true)
  })
})
