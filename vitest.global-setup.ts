import { execSync } from 'child_process'
import { randomBytes } from 'crypto'
import bcrypt from 'bcryptjs'
import { resolve } from 'path'

export default async function globalSetup() {
  let stopContainer: (() => Promise<void>) | undefined

  if (!process.env.DATABASE_URL) {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql')
    const container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('license_server_test')
      .start()
    process.env.DATABASE_URL = container.getConnectionUri()
    stopContainer = async () => { await container.stop() }
  }

  execSync('npx prisma migrate deploy', {
    env: { ...process.env },
    stdio: 'pipe',
    cwd: resolve(__dirname),
  })

  process.env.KEK_BASE64 = randomBytes(32).toString('base64')
  process.env.JWT_SECRET = randomBytes(64).toString('base64')
  process.env.ADMIN_EMAIL = 'test@example.com'
  // Rounds=10: minimum accepted by login/route.ts (which requires >= 10).
  // If that minimum rises, this must match or tests will 500 with "Server misconfigured".
  process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync('test-password', 10)
  process.env.NEXT_PUBLIC_BASE_URL = 'http://localhost:3001'

  return async () => {
    await stopContainer?.()
  }
}
