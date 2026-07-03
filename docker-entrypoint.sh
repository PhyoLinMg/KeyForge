#!/bin/sh
set -e

if [ -n "${VAULT_ROLE_ID}" ] && [ -n "${VAULT_SECRET_ID}" ]; then
  echo "Fetching KEK_BASE64 from Vault..."

  # Write login script to a temp file so it can be retried cleanly
  cat > /tmp/_vault_login.js <<'JSEOF'
const http = require('http');
const { VAULT_ADDR = 'http://vault:8200', VAULT_ROLE_ID, VAULT_SECRET_ID } = process.env;
const body = JSON.stringify({ role_id: VAULT_ROLE_ID, secret_id: VAULT_SECRET_ID });
const u = new URL(VAULT_ADDR + '/v1/auth/approle/login');
const req = http.request({
  hostname: u.hostname, port: u.port || '8200',
  path: u.pathname, method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
}, res => {
  let d = ''; res.on('data', c => d += c);
  res.on('end', () => {
    try {
      const r = JSON.parse(d);
      if (!r.auth?.client_token) { process.stderr.write('Vault login failed: ' + d + '\n'); process.exit(1); }
      process.stdout.write(r.auth.client_token);
    } catch { process.stderr.write('Invalid JSON from Vault: ' + d + '\n'); process.exit(1); }
  });
});
req.on('error', e => { process.stderr.write('Vault unreachable: ' + e.message + '\n'); process.exit(1); });
req.write(body); req.end();
JSEOF

  _VAULT_RETRIES=0
  _VAULT_TOKEN=""
  while [ "$_VAULT_RETRIES" -lt 10 ]; do
    _VAULT_TOKEN=$(node /tmp/_vault_login.js 2>/tmp/_vault_err) && break || true
    _VAULT_RETRIES=$((_VAULT_RETRIES + 1))
    echo "Vault not ready (attempt $_VAULT_RETRIES/10), retrying in 3s..."
    sleep 3
  done

  if [ -z "$_VAULT_TOKEN" ]; then
    cat /tmp/_vault_err >&2
    echo "Error: Vault login failed after 10 attempts." >&2
    exit 1
  fi

  KEK_BASE64=$(_VAULT_TOKEN="$_VAULT_TOKEN" node - <<'JSEOF'
const http = require('http');
const { VAULT_ADDR = 'http://vault:8200', _VAULT_TOKEN } = process.env;
const u = new URL(VAULT_ADDR + '/v1/secret/data/keyforge/kek');
const req = http.request({
  hostname: u.hostname, port: u.port || '8200',
  path: u.pathname, method: 'GET',
  headers: { 'X-Vault-Token': _VAULT_TOKEN }
}, res => {
  let d = ''; res.on('data', c => d += c);
  res.on('end', () => {
    try {
      const r = JSON.parse(d);
      if (!r.data?.data?.kek_base64) { process.stderr.write('KEK not found in Vault: ' + d + '\n'); process.exit(1); }
      process.stdout.write(r.data.data.kek_base64);
    } catch { process.stderr.write('Invalid JSON from Vault: ' + d + '\n'); process.exit(1); }
  });
});
req.on('error', e => { process.stderr.write('Vault unreachable: ' + e.message + '\n'); process.exit(1); });
req.end();
JSEOF
)

  export KEK_BASE64
  unset _VAULT_TOKEN
  echo "KEK_BASE64 loaded from Vault."
elif [ -n "${KEK_BASE64}" ]; then
  echo "Warning: KEK_BASE64 set in env directly — use Vault in production."
else
  echo "Error: set VAULT_ROLE_ID + VAULT_SECRET_ID (Vault) or KEK_BASE64 (dev only)." >&2
  exit 1
fi

echo "Running prisma migrate deploy..."
node node_modules/prisma/build/index.js migrate deploy --schema=./prisma/schema.prisma

echo "Starting server..."
exec node server.js
