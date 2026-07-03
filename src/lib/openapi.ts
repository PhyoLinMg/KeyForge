const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL ?? 'http://localhost:3000'

const paginationQueryParams = [
  {
    name: 'page',
    in: 'query' as const,
    schema: { type: 'integer', minimum: 1, default: 1 },
    description: '1-based page number',
  },
  {
    name: 'pageSize',
    in: 'query' as const,
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    description: 'Items per page (max 100)',
  },
]

const paginationHeaders = {
  'X-Total-Count': {
    description: 'Total number of items across all pages',
    schema: { type: 'integer' },
  },
  'Link': {
    description: 'RFC 5988 pagination links (rel="next", rel="prev")',
    schema: { type: 'string' },
  },
}

const paginationMeta = {
  type: 'object',
  required: ['page', 'pageSize', 'total', 'totalPages'],
  properties: {
    page: { type: 'integer', description: 'Current page' },
    pageSize: { type: 'integer', description: 'Items per page' },
    total: { type: 'integer', description: 'Total items' },
    totalPages: { type: 'integer', description: 'Total pages' },
  },
}

const errorSchema = {
  type: 'object',
  required: ['error'],
  properties: { error: { type: 'string' } },
}

function pagedResponse(itemSchema: object, description: string) {
  return {
    description,
    headers: paginationHeaders,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['data', 'pagination'],
          properties: {
            data: { type: 'array', items: itemSchema },
            pagination: paginationMeta,
          },
        },
      },
    },
  }
}

const licenseItem = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    customerId: { type: 'string', format: 'uuid' },
    productId: { type: 'string', format: 'uuid' },
    keyId: { type: 'string' },
    tier: { type: 'string' },
    features: { type: 'array', items: { type: 'string' } },
    limits: { type: 'object' },
    status: { type: 'string', enum: ['active', 'revoked'] },
    issuedAt: { type: 'string', format: 'date-time' },
    notBefore: { type: 'string', format: 'date-time' },
    expiresAt: { type: 'string', format: 'date-time' },
    gracePeriodDays: { type: 'integer' },
    heartbeatUrl: { type: 'string', format: 'uri' },
    instanceId: { type: 'string', format: 'uuid', nullable: true },
    revokedAt: { type: 'string', format: 'date-time', nullable: true },
    revokeReason: { type: 'string', nullable: true },
    customer: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        email: { type: 'string', nullable: true },
      },
    },
    product: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        slug: { type: 'string' },
      },
    },
    _count: {
      type: 'object',
      properties: { instances: { type: 'integer' } },
    },
  },
}

const customerItem = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    email: { type: 'string', nullable: true },
    notes: { type: 'string', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
    _count: {
      type: 'object',
      properties: { licenses: { type: 'integer' } },
    },
  },
}

const productItem = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    slug: { type: 'string' },
    keyId: { type: 'string' },
    publicKeyB64: { type: 'string', description: 'Base64 SPKI DER Ed25519 public key' },
    issuerName: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    _count: {
      type: 'object',
      properties: { licenses: { type: 'integer' } },
    },
  },
}

const adminAuth = [{ cookieAuth: [] }]
const json400 = { description: 'Bad request', content: { 'application/json': { schema: errorSchema } } }
const json401 = { description: 'Unauthorized', content: { 'application/json': { schema: errorSchema } } }
const json404 = { description: 'Not found', content: { 'application/json': { schema: errorSchema } } }
const json409 = { description: 'Conflict', content: { 'application/json': { schema: errorSchema } } }
const json429 = {
  description: 'Rate limited',
  headers: {
    'X-RateLimit-Limit': { schema: { type: 'integer' } },
    'X-RateLimit-Remaining': { schema: { type: 'integer' } },
    'X-RateLimit-Reset': { schema: { type: 'integer' }, description: 'Unix epoch seconds' },
  },
  content: { 'application/json': { schema: errorSchema } },
}

export function buildOpenApiDocument() {
  return {
    openapi: '3.0.3',
    info: {
      title: 'KeyForge License Server API',
      version: '1.0.0',
      description:
        'Vendor-operated license control plane. Issues, revokes, and tracks software licenses. ' +
        'Admin endpoints require a session cookie (`lsrv_session`). ' +
        'Public endpoints (`/api/v1/*`) accept license text as the credential.',
    },
    servers: [{ url: BASE_URL, description: 'License server' }],
    components: {
      securitySchemes: {
        cookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: 'lsrv_session',
          description: 'JWT session cookie obtained from POST /api/auth/login',
        },
      },
      headers: {
        XRequestID: {
          description: 'Unique request identifier for tracing',
          schema: { type: 'string', format: 'uuid' },
        },
      },
    },
    paths: {
      '/api/auth/login': {
        post: {
          summary: 'Admin login',
          tags: ['Auth'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email', 'password'],
                  properties: {
                    email: { type: 'string', format: 'email' },
                    password: { type: 'string', format: 'password' },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Login successful — sets lsrv_session cookie',
              content: {
                'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } },
              },
            },
            '401': json401,
            '429': json429,
            '500': { description: 'Server misconfigured' },
          },
        },
      },
      '/api/auth/logout': {
        post: {
          summary: 'Admin logout',
          tags: ['Auth'],
          security: adminAuth,
          responses: {
            '200': {
              description: 'Logout successful — clears session cookie',
              content: {
                'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } },
              },
            },
          },
        },
      },
      '/api/admin/licenses': {
        get: {
          summary: 'List licenses',
          tags: ['Licenses'],
          security: adminAuth,
          parameters: paginationQueryParams,
          responses: {
            '200': pagedResponse(licenseItem, 'Paginated list of licenses'),
            '401': json401,
          },
        },
        post: {
          summary: 'Issue license',
          tags: ['Licenses'],
          security: adminAuth,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['productId', 'customerId', 'tier', 'expiresAt'],
                  properties: {
                    productId: { type: 'string', format: 'uuid' },
                    customerId: { type: 'string', format: 'uuid' },
                    tier: { type: 'string', example: 'pro' },
                    features: { type: 'array', items: { type: 'string' }, default: [] },
                    limits: {
                      type: 'object',
                      properties: {
                        max_clients: { type: 'integer' },
                        max_intake_per_month: { type: 'integer' },
                        max_msp_users: { type: 'integer' },
                      },
                    },
                    notBefore: { type: 'string', format: 'date-time', description: 'Defaults to now' },
                    expiresAt: { type: 'string', format: 'date-time' },
                    gracePeriodDays: { type: 'integer', default: 21 },
                    heartbeatUrl: { type: 'string', format: 'uri', description: 'Defaults to server heartbeat URL' },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'License issued',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      licenseItem,
                      {
                        type: 'object',
                        properties: { licenseText: { type: 'string', description: 'Token to deliver to customer' } },
                      },
                    ],
                  },
                },
              },
            },
            '400': json400,
            '401': json401,
            '404': json404,
          },
        },
      },
      '/api/admin/licenses/{id}': {
        get: {
          summary: 'Get license detail',
          tags: ['Licenses'],
          security: adminAuth,
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': {
              description: 'License with instances and audit events',
              content: { 'application/json': { schema: licenseItem } },
            },
            '401': json401,
            '404': json404,
          },
        },
      },
      '/api/admin/licenses/{id}/revoke': {
        post: {
          summary: 'Revoke license',
          tags: ['Licenses'],
          security: adminAuth,
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['reason'],
                  properties: { reason: { type: 'string' } },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'License revoked',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      ok: { type: 'boolean' },
                      status: { type: 'string' },
                      revokedAt: { type: 'string', format: 'date-time' },
                    },
                  },
                },
              },
            },
            '400': json400,
            '401': json401,
            '404': json404,
            '409': json409,
          },
        },
      },
      '/api/admin/licenses/{id}/rebind': {
        post: {
          summary: 'Rebind license instance',
          description: 'Clears the instance binding so a replacement server can heartbeat in.',
          tags: ['Licenses'],
          security: adminAuth,
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': {
              description: 'Instance binding cleared',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      ok: { type: 'boolean' },
                      previous_instance_id: { type: 'string', format: 'uuid', nullable: true },
                    },
                  },
                },
              },
            },
            '401': json401,
            '404': json404,
            '409': json409,
          },
        },
      },
      '/api/admin/customers': {
        get: {
          summary: 'List customers',
          tags: ['Customers'],
          security: adminAuth,
          parameters: paginationQueryParams,
          responses: {
            '200': pagedResponse(customerItem, 'Paginated list of customers'),
            '401': json401,
          },
        },
        post: {
          summary: 'Create customer',
          tags: ['Customers'],
          security: adminAuth,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name'],
                  properties: {
                    name: { type: 'string' },
                    email: { type: 'string', format: 'email' },
                    notes: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            '201': { description: 'Customer created', content: { 'application/json': { schema: customerItem } } },
            '400': json400,
            '401': json401,
          },
        },
      },
      '/api/admin/products': {
        get: {
          summary: 'List products',
          tags: ['Products'],
          security: adminAuth,
          parameters: paginationQueryParams,
          responses: {
            '200': pagedResponse(productItem, 'Paginated list of products'),
            '401': json401,
          },
        },
        post: {
          summary: 'Register product',
          description: 'Generates an Ed25519 keypair. Embed the returned publicKeyB64 in the product binary.',
          tags: ['Products'],
          security: adminAuth,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name', 'slug'],
                  properties: {
                    name: { type: 'string' },
                    slug: { type: 'string', description: 'Unique identifier used in license tokens' },
                    keyId: { type: 'string', default: 'v1' },
                    issuerName: { type: 'string', description: 'Defaults to <slug>-license-server' },
                  },
                },
              },
            },
          },
          responses: {
            '201': { description: 'Product registered', content: { 'application/json': { schema: productItem } } },
            '400': json400,
            '401': json401,
            '409': json409,
          },
        },
      },
      '/api/admin/audit/prune': {
        post: {
          summary: 'Prune audit events',
          description: 'Deletes AuditEvent rows older than `days` (default 90). Run periodically via cron.',
          tags: ['Admin'],
          security: adminAuth,
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { days: { type: 'integer', minimum: 90, default: 90 } },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Pruned',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      deleted: { type: 'integer' },
                      cutoff: { type: 'string', format: 'date-time' },
                      days: { type: 'integer' },
                    },
                  },
                },
              },
            },
            '400': json400,
            '401': json401,
          },
        },
      },
      '/api/v1/validate': {
        post: {
          summary: 'Validate license',
          description:
            'Validates a license token and returns the current enforcement state. ' +
            'No auth required — the license text is the credential. ' +
            'Called by the product binary on boot and periodically.',
          tags: ['Public'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['license_text'],
                  properties: { license_text: { type: 'string' } },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Enforcement state',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      state: { type: 'string', enum: ['VALID', 'DEGRADED', 'EXPIRED', 'INVALID', 'UNLICENSED'] },
                      license_id: { type: 'string', format: 'uuid' },
                      tier: { type: 'string' },
                      features: { type: 'array', items: { type: 'string' } },
                      limits: { type: 'object' },
                      expires_at: { type: 'string', format: 'date-time' },
                      grace_period_days: { type: 'integer' },
                      heartbeat_url: { type: 'string', format: 'uri' },
                      new_license: { type: 'string', nullable: true },
                    },
                  },
                },
              },
            },
            '400': json400,
            '404': json404,
            '422': { description: 'Invalid or malformed license', content: { 'application/json': { schema: errorSchema } } },
            '429': json429,
          },
        },
      },
      '/api/v1/heartbeat': {
        post: {
          summary: 'Instance heartbeat',
          description:
            'Called hourly by a bound product instance. Ed25519 signature over canonical JSON of all non-signature fields required. ' +
            'First call must include instance_public_key to bind the instance.',
          tags: ['Public'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['license_id', 'instance_id', 'nonce', 'sequence', 'signature'],
                  properties: {
                    license_id: { type: 'string', format: 'uuid' },
                    instance_id: { type: 'string', format: 'uuid' },
                    version: { type: 'string' },
                    usage: { type: 'object' },
                    now: { type: 'string', format: 'date-time' },
                    nonce: { type: 'string', minLength: 1, maxLength: 256 },
                    sequence: { type: 'integer', minimum: 0, description: 'Monotonically increasing' },
                    signature: { type: 'string', description: 'Base64url Ed25519 signature' },
                    instance_public_key: { type: 'string', description: 'Base64 SPKI DER — required on first heartbeat only' },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Heartbeat accepted — response is Ed25519-signed by server',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      status: { type: 'string', enum: ['ok', 'revoked'] },
                      server_time: { type: 'string', format: 'date-time' },
                      new_license: { type: 'string', nullable: true },
                      enforcement: {
                        type: 'object',
                        properties: {
                          state: { type: 'string', enum: ['VALID', 'DEGRADED', 'EXPIRED', 'INVALID'] },
                          tier: { type: 'string' },
                          features: { type: 'array', items: { type: 'string' } },
                          limits: { type: 'object' },
                          expires_at: { type: 'string', format: 'date-time' },
                          grace_period_days: { type: 'integer' },
                          heartbeat_url: { type: 'string', format: 'uri' },
                        },
                      },
                      signature: { type: 'string', description: 'Server Ed25519 signature over response body' },
                    },
                  },
                },
              },
            },
            '400': json400,
            '401': { description: 'Invalid instance signature' },
            '404': json404,
            '409': json409,
            '429': json429,
          },
        },
      },
    },
    tags: [
      { name: 'Auth', description: 'Admin authentication' },
      { name: 'Licenses', description: 'License issuance and management' },
      { name: 'Customers', description: 'Customer management' },
      { name: 'Products', description: 'Product registration' },
      { name: 'Admin', description: 'Administrative operations' },
      { name: 'Public', description: 'Public endpoints called by product instances' },
    ],
  }
}
