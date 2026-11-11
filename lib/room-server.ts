import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import type { VercelRequest, VercelResponse } from '@vercel/node'

export type Room = { id: string; name: string; active: boolean; createdAt: number; expiresAt: number; adminHash: string; closedAt?: number }
export type RoomSession = { roomId: string; expiresAt: number; organizer: boolean }

const codeAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const sessionCookie = 'linkwall_session_'

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

export function hash(value: string) { return createHash('sha256').update(value).digest('hex') }

export function createRoomCode() {
  return Array.from({ length: 10 }, () => codeAlphabet[randomInt(codeAlphabet.length)]).join('')
}

export function createAdminCredential() { return randomBytes(32).toString('base64url') }

export function sessionSecret() {
  const secret = process.env.ROOM_SESSION_SECRET
  if (!secret || secret.length < 32) throw new Error('ROOM_SESSION_SECRET must contain at least 32 characters')
  return secret
}

function sessionMac(payload: string) { return createHmac('sha256', sessionSecret()).update(payload).digest() }

export function setRoomSession(res: VercelResponse, roomId: string, expiresAt: number, organizer: boolean) {
  const payload = Buffer.from(JSON.stringify({ roomId, expiresAt, organizer })).toString('base64url')
  const signature = sessionMac(payload).toString('base64url')
  const maxAge = Math.max(1, Math.floor((expiresAt - Date.now()) / 1000))
  const secure = process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production' ? '; Secure' : ''
  res.setHeader('Set-Cookie', `${sessionCookie}${roomId}=${payload}.${signature}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`)
}

export function clearRoomSession(res: VercelResponse, roomId: string) {
  const secure = process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production' ? '; Secure' : ''
  res.setHeader('Set-Cookie', `${sessionCookie}${roomId}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure}`)
}

export function readRoomSession(req: VercelRequest, roomId?: string): RoomSession | null {
  const selectedRoom = roomId ?? req.headers['x-linkwall-room-id']
  if (typeof selectedRoom !== 'string' || !/^[0-9a-f-]{36}$/i.test(selectedRoom)) return null
  const cookieHeader = req.headers.cookie
  if (typeof cookieHeader !== 'string') return null
  const name = `${sessionCookie}${selectedRoom}`
  const cookie = cookieHeader.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))
  const token = cookie?.slice(name.length + 1)
  if (!token) return null
  const [payload, signature, ...rest] = token.split('.')
  if (!payload || !signature || rest.length) return null
  try {
    const supplied = Buffer.from(signature, 'base64url')
    const expected = sessionMac(payload)
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<RoomSession>
    if (data.roomId !== selectedRoom || typeof data.expiresAt !== 'number' || typeof data.organizer !== 'boolean') return null
    return data as RoomSession
  } catch { return null }
}

export function requireSameOrigin(req: VercelRequest) {
  const origin = req.headers.origin
  const host = req.headers.host
  if (typeof origin !== 'string' || typeof host !== 'string') throw new HttpError(403, 'Origem da solicitação inválida.')
  try {
    const url = new URL(origin)
    const forwardedProto = req.headers['x-forwarded-proto']
    const proto = (typeof forwardedProto === 'string' ? forwardedProto.split(',')[0].trim() : process.env.NODE_ENV === 'production' ? 'https' : 'http') + ':'
    if (url.host.toLowerCase() !== host.toLowerCase() || url.protocol !== proto) throw new Error()
  } catch { throw new HttpError(403, 'Origem da solicitação inválida.') }
}

function requestIp(req: VercelRequest) {
  const forwarded = req.headers['x-forwarded-for']
  const value = (typeof forwarded === 'string' ? forwarded.split(',')[0] : req.socket.remoteAddress) || 'unknown'
  return hash(value.trim())
}

export async function enforceRateLimit(req: VercelRequest, action: string, limit: number, windowSeconds = 60) {
  const bucket = Math.floor(Date.now() / (windowSeconds * 1000))
  const key = `linkwall:rate-limit:${action}:${requestIp(req)}:${bucket}`
  const script = `local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; if n>tonumber(ARGV[2]) then return -1 end; return n`
  const result = Number(await redis(['EVAL', script, '1', key, String(windowSeconds), String(limit)]))
  if (result < 0) throw new HttpError(429, 'Muitas tentativas. Aguarde um minuto e tente novamente.')
}

export async function redis(command: unknown[]) {
  const base = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!base || !token) throw new Error('Redis is not configured')
  const response = await fetch(base.replace(/\/$/, ''), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  })
  if (!response.ok) throw new Error('Redis request failed')
  const data = await response.json() as { result?: unknown; error?: string }
  if (data.error) throw new Error(data.error)
  return data.result
}

export async function activeRoom(req: VercelRequest, res: VercelResponse) {
  const session = readRoomSession(req)
  if (!session) throw new HttpError(401, 'Entre com o código da sala para continuar.')
  if (session.expiresAt <= Date.now()) {
    clearRoomSession(res, session.roomId)
    throw new HttpError(410, 'Esta sala expirou ou foi encerrada.')
  }
  const key = `linkwall:room:${session.roomId}`
  const raw = await redis(['GET', key])
  if (typeof raw !== 'string') {
    clearRoomSession(res, session.roomId)
    throw new HttpError(410, 'Esta sala expirou ou foi encerrada.')
  }
  let room: Room
  try { room = JSON.parse(raw) as Room } catch { throw new Error('Invalid room record') }
  if (!room.active || room.expiresAt <= Date.now()) {
    clearRoomSession(res, session.roomId)
    throw new HttpError(410, 'Esta sala expirou ou foi encerrada.')
  }
  return { room, organizer: session.organizer }
}

export function apiError(res: VercelResponse, error: unknown) {
  if (error instanceof HttpError) return res.status(error.status).json({ error: error.message })
  return res.status(503).json({ error: 'Serviço temporariamente indisponível. Tente novamente.' })
}
