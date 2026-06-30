# Keyforge — License Server

Vendor-operated license portal for issuing, revoking, and tracking Ed25519-signed license tokens for self-hosted products. Customers never access this directly — only the vendor operates it.

## Table of Contents

- [How It Works](#how-it-works)
- [Stack](#stack)
- [Data Model](#data-model)
- [Environment Variables](#environment-variables)
- [Quick Start (Docker)](#quick-start-docker)
- [Development](#development)
- [Operations](#operations)
- [API Overview](#api-overview)
- [Security](#security)

---

## How It Works

```
Vendor admin
     │
     ▼
┌──────────────────────────────┐        ┌──────────────────────────────┐
│   License Portal (this repo) │        │   Customer's self-hosted     │
│                              │        │   product binary             │
│   Admin UI                   │  .lic  │                              │
│   /admin/products            │───────►│   boot: verify sig offline   │
│   /admin/customers           │        │   hourly: POST /api/v1/validate│
│   /admin/licenses            │        │   hourly: POST /api/v1/heartbeat│
│                              │◄───────│                              │
│   POST /api/v1/validate      │        └──────────────────────────────┘
│   POST /api/v1/heartbeat     │
└──────────────────────────────┘
```

**License tokens** are `base64url(canonicalJson(payload)).base64url(Ed25519Signature)` — verifiable offline by any product binary that embeds the product's Ed25519 public key.

**Private keys** (one per product) are stored AES-256-GCM encrypted in the database. The encryption key (`KEK_BASE64`) lives in OpenBao — never in the `.env` file in production.

**Enforcement states:** `VALID` → `DEGRADED` (>24h without poll) → `EXPIRED` (>grace_period_days without poll, or token expired) → `REVOKED` (manually revoked). Only `VALID` allows mutations in the product.

---

## Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 15 (App Router, TypeScript) |
| Database | PostgreSQL 16 via Prisma |
| Secrets | OpenBao (Vault-compatible) — stores `KEK_BASE64` |
| Crypto | Node.js `crypto` — Ed25519 sign/verify, AES-256-GCM key wrap |
| Auth | HS256 JWT with JTI server-side revocation (`Session` table) |

---

## Data Model

```
Product          one keypair per product; publicKeyB64 embedded in binary
  └── License    one per customer deployment; carries tier, limits, expiry
        └── Instance      bound on first heartbeat; one per running server
        └── AuditEvent    ISSUE · REVOKE · HEARTBEAT · INSTANCE_BIND · VALIDATE

Customer         billing/contact info; linked to Licenses
Session          active admin JWT sessions (JTI-keyed, 2h TTL)
```

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `JWT_SECRET` | yes | HS256 signing secret (≥64 bytes base64) |
| `ADMIN_EMAIL` | yes | Admin login email |
| `ADMIN_PASSWORD_HASH` | yes | bcrypt hash of admin password |
| `NEXT_PUBLIC_BASE_URL` | yes | Public URL (e.g. `https://license.yourcompany.com`) |
| `VAULT_ROLE_ID` | prod | OpenBao AppRole role_id — entrypoint fetches `KEK_BASE64` |
| `VAULT_SECRET_ID` | prod | OpenBao AppRole secret_id |
| `VAULT_ADDR` | prod | OpenBao address (default `http://vault:8200`) |
| `VAULT_UNSEAL_KEY` | prod | Unseal key from `bao operator init` — needed after every restart; store offline |
| `KEK_BASE64` | dev only | 32-byte AES key — **use Vault in production** |
| `TRUSTED_PROXY_HEADER` | prod | Header with real client IP (`x-real-ip` or `cf-connecting-ip`) |
| `PROXY_UPSTREAM_URL` | optional | Enable proxy gate to a Handoff backend |
| `PROXY_BYPASS_PREFIXES` | optional | Comma-separated path prefixes that skip the proxy gate |

Generate `JWT_SECRET`:
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('base64'))"
```

Generate `ADMIN_PASSWORD_HASH`:
```bash
node -e "require('bcryptjs').hash('YOUR_PASSWORD', 12).then(console.log)"
```

---

## Quick Start (Docker)

### 1. Configure environment

```bash
cp .env.example .env
# Fill in JWT_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD_HASH, NEXT_PUBLIC_BASE_URL
```

### 2. Bootstrap OpenBao and generate KEK

> Run this once on first deploy. Save the unseal key and root token offline — they cannot be recovered.

```bash
# Start OpenBao only
docker compose up -d openbao

# Initialize with a single unseal key
docker compose exec openbao bao operator init -key-shares=1 -key-threshold=1
# → copy "Unseal Key 1" and "Initial Root Token" somewhere safe

# Unseal
docker compose exec openbao bao operator unseal <unseal_key>

# Log in with root token
docker compose exec openbao bao login <root_token>

# Enable KV v2 and AppRole
docker compose exec openbao bao secrets enable -path=secret kv-v2
docker compose exec openbao bao auth enable approle

# Create read-only policy for the portal
docker compose exec openbao bao policy write keyforge - <<'EOF'
path "secret/data/keyforge/kek" { capabilities = ["read"] }
EOF

# Create the AppRole (short-lived tokens — portal fetches KEK only at startup)
docker compose exec openbao bao write auth/approle/role/keyforge \
  token_policies="keyforge" token_ttl=5m token_max_ttl=10m

# Generate and store a fresh 32-byte KEK
KEK=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
docker compose exec openbao bao kv put secret/keyforge/kek kek_base64="$KEK"

# Get credentials → add to .env
docker compose exec openbao bao read auth/approle/role/keyforge/role-id
docker compose exec openbao bao write -f auth/approle/role/keyforge/secret-id
```

Add to `.env`:
```env
VAULT_ROLE_ID=<role_id>
VAULT_SECRET_ID=<secret_id>
```

### 3. Start the full stack

```bash
docker compose up -d
```

Portal starts on **http://localhost:3001**. On startup the entrypoint:
1. Authenticates to OpenBao via AppRole (retries up to 10× with 3s backoff)
2. Fetches `KEK_BASE64` from `secret/keyforge/kek`
3. Runs `prisma migrate deploy`
4. Starts the Next.js server

### 4. First login

Navigate to `http://localhost:3001/login` and sign in with `ADMIN_EMAIL` and your password.

### 5. Register your product

Go to **Products → New**. Copy `publicKeyB64` from the response and embed it in your product binary at build time. The private key never leaves this server.

---

## Development

```bash
npm install

# Set KEK_BASE64 directly for local dev — no OpenBao needed
cp .env.example .env
# Add: KEK_BASE64=<base64 of 32 random bytes>
# node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# Start Postgres only
docker compose up -d postgres

# Run migrations
npm run db:migrate      # or: npx prisma migrate dev

# Start dev server
npm run dev             # http://localhost:3001
```

### Tests

Integration tests run against a real Postgres instance (requires `DATABASE_URL` in env):

```bash
npm test                # run all tests
npm test -- --watch     # watch mode
```

### Type checking

```bash
npm run typecheck
```

### Prisma

```bash
npx prisma studio           # browse database
npx prisma migrate dev      # create a new migration
npx prisma migrate deploy   # apply migrations (production)
```

---

## Operations

### After every server reboot

OpenBao starts sealed after every restart. Unseal it before the portal can start:

```bash
docker compose up -d openbao
docker compose exec openbao bao operator unseal <unseal_key>
docker compose up -d
```

> The portal's `depends_on` health check prevents it from starting while OpenBao is sealed.

### Updating the portal

```bash
docker compose pull
docker compose build portal-ui
docker compose up -d
```

`prisma migrate deploy` runs automatically on startup.

### Disk space

OpenBao stores lease metadata on disk. If the Docker VM runs low on disk space, OpenBao will fail to create tokens with `internal error`. Free space with:

```bash
docker builder prune -f    # clears build cache (~tens of GB typical)
docker image prune -f      # removes dangling images
```

### Revoking a license

Admin UI: **Licenses → [license] → Revoke**

API:
```bash
curl -X POST https://license.yourcompany.com/api/admin/licenses/<id>/revoke \
  -H "Cookie: lsrv_session=<token>" \
  -H "Content-Type: application/json" \
  -d '{"reason": "Customer churned"}'
```

The next heartbeat or validate poll from the product returns `REVOKED`.

### Rebinding after server replacement

Each license binds to one `instance_id` on its first heartbeat. When a customer replaces their server:

```bash
curl -X POST https://license.yourcompany.com/api/admin/licenses/<id>/rebind \
  -H "Cookie: lsrv_session=<token>"
```

The next heartbeat from any instance_id will re-bind.

### Backups

| What | Where | Notes |
|------|-------|-------|
| All license/customer/product data | `pgdata` Docker volume | Back up regularly |
| Encrypted KEK | `vaultdata` Docker volume | Back up regularly — loss = can't decrypt product private keys |
| OpenBao unseal key | Offline (printed during `bao operator init`) | Store separately from the server |
| Admin password | Password manager | Hash is regeneratable; keep the plaintext safe |

---

## API Overview

Full API reference is in [DOCS.md](DOCS.md).

### Admin endpoints (require `lsrv_session` cookie)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/auth/login` | Admin login → sets session cookie |
| `POST` | `/api/auth/logout` | Invalidates session |
| `GET/POST` | `/api/admin/products` | List / create products |
| `GET/POST` | `/api/admin/customers` | List / create customers |
| `GET/POST` | `/api/admin/licenses` | List / issue licenses |
| `GET` | `/api/admin/licenses/[id]` | License detail (includes `licenseText`) |
| `POST` | `/api/admin/licenses/[id]/revoke` | Revoke a license |
| `POST` | `/api/admin/licenses/[id]/rebind` | Clear instance binding |

### Public enforcement endpoints (no auth)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/validate` | Verify license + get enforcement state |
| `POST` | `/api/v1/heartbeat` | Instance heartbeat with Ed25519 sig verification |
| `GET` | `/api/health` | Health check |

### Proxy gate (optional)

| Method | Path | Description |
|--------|------|-------------|
| `ALL` | `/api/proxy/[...path]` | Reverse-proxy to `PROXY_UPSTREAM_URL`; 402 if no valid license |

---

## Security

- **License tokens** are Ed25519-signed and verifiable offline — no network dependency for boot checks.
- **Private keys** are encrypted at rest with AES-256-GCM using a KEK that lives only in OpenBao.
- **Admin sessions** use HS256 JWTs with JTI claims verified server-side on every request (fail-closed). Sessions expire after 2 hours. Logout invalidates the session immediately.
- **Rate limiting** on login and heartbeat endpoints. Set `TRUSTED_PROXY_HEADER` in production to key limits per real client IP.
- **Replay protection** on heartbeats via strictly-increasing sequence numbers and short-TTL nonce deduplication.
- **Single-instance binding** prevents a stolen license file from being used on a second server simultaneously.

See [SECURITY.md](SECURITY.md) for the vulnerability disclosure policy.
