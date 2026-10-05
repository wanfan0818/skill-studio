import type { FastifyInstance, FastifyRequest } from 'fastify'
import crypto from 'crypto'
import os from 'os'
import path from 'path'
import { writeFileAtomic } from '../utils/safe.js'

/**
 * Local-only request guard.
 *
 * Skill Studio listens on 127.0.0.1 and exposes endpoints that write, move and
 * delete files and run git/npx. "Only reachable from localhost" is NOT a
 * security boundary: any web page the user visits can fire requests at
 * http://127.0.0.1:<port> (an <img src> needs no CORS at all), and DNS
 * rebinding lets a foreign page pose as same-origin. Three checks close that:
 *
 *   1. Host header must be a loopback name   → defeats DNS rebinding
 *   2. Origin, when present, must be loopback → defeats cross-site fetch/WS
 *   3. A per-launch random token (SameSite=Strict cookie set when the UI page
 *      is served, or the x-skill-studio-token header) → defeats blind
 *      cross-site GETs that send neither Origin nor cookie
 */

export const TOKEN_COOKIE = 'ss_token'
export const TOKEN_HEADER = 'x-skill-studio-token'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export function sessionTokenPath(): string {
  return path.join(os.homedir(), '.config', 'skill-studio', 'session-token')
}

export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('hex')
}

/** Persist the token (0600) so the Vite dev proxy can attach it in dev mode. */
export async function persistSessionToken(token: string): Promise<void> {
  await writeFileAtomic(sessionTokenPath(), token, { mode: 0o600 })
}

function hostnameOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null
  const h = hostHeader.trim().toLowerCase()
  if (h.startsWith('[')) {
    const end = h.indexOf(']')
    return end === -1 ? null : h.slice(0, end + 1)
  }
  return h.split(':')[0]
}

export function isLoopbackHost(hostHeader: string | undefined): boolean {
  const name = hostnameOf(hostHeader)
  return !!name && LOOPBACK_HOSTS.has(name)
}

export function isLoopbackOrigin(origin: string): boolean {
  try {
    const u = new URL(origin)
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK_HOSTS.has(u.hostname.toLowerCase())
  } catch {
    return false
  }
}

function readCookie(req: FastifyRequest, name: string): string | undefined {
  const header = req.headers.cookie
  if (!header) return undefined
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim())
  }
  return undefined
}

function tokensEqual(a: string | undefined, b: string): boolean {
  if (typeof a !== 'string') return false
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb)
}

function isProtectedPath(url: string): boolean {
  return url === '/ws' || url.startsWith('/ws?') || url === '/api' || url.startsWith('/api/') || url.startsWith('/api?')
}

export function registerGuard(app: FastifyInstance, token: string): void {
  app.addHook('onRequest', async (req, reply) => {
    if (!isLoopbackHost(req.headers.host)) {
      return reply.status(403).send({ ok: false, error: 'Forbidden host' })
    }

    const origin = req.headers.origin
    if (origin !== undefined && !isLoopbackOrigin(origin)) {
      return reply.status(403).send({ ok: false, error: 'Forbidden origin' })
    }

    if (isProtectedPath(req.url)) {
      const header = req.headers[TOKEN_HEADER]
      const presented = (Array.isArray(header) ? header[0] : header) ?? readCookie(req, TOKEN_COOKIE)
      if (!tokensEqual(presented, token)) {
        return reply.status(401).send({ ok: false, error: 'Missing or invalid session token. Reload the Skill Studio page.' })
      }
      return
    }

    // Any non-API response (the UI page and its assets) hands the browser the
    // session cookie. SameSite=Strict keeps it off every cross-site request.
    reply.header('set-cookie', `${TOKEN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`)
  })
}
