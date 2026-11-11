import { randomUUID } from 'node:crypto'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { apiError, createAdminCredential, createRoomCode, enforceRateLimit, hash, redis, requireSameOrigin, sessionSecret, setRoomSession, type Room } from '../lib/room-server.js'

const createScript = `
if redis.call('EXISTS', KEYS[1]) == 1 or redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
return 1
`

function roomTtl() {
  const configured = process.env.ROOM_DEFAULT_TTL_SECONDS
  const ttl = configured === undefined || configured === '' ? 86400 : Number(configured)
  if (!Number.isInteger(ttl) || ttl < 600 || ttl > 604800) throw new Error('ROOM_DEFAULT_TTL_SECONDS must be between 600 and 604800')
  return ttl
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' })
  try {
    requireSameOrigin(req)
    sessionSecret()
    await enforceRateLimit(req, 'create-room', 5)
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().replace(/\s+/g, ' ') : ''
    if (name.length < 2 || name.length > 60) return res.status(400).json({ error: 'O nome da sala deve ter entre 2 e 60 caracteres.' })

    const ttl = roomTtl()
    const now = Date.now()
    for (let attempt = 0; attempt < 3; attempt++) {
      const code = createRoomCode()
      const roomId = randomUUID()
      const adminCredential = createAdminCredential()
      const room: Room = { id: roomId, name, active: true, createdAt: now, expiresAt: now + ttl * 1000, adminHash: hash(adminCredential) }
      const roomKey = `linkwall:room:${roomId}`
      const codeKey = `linkwall:room-code:${hash(code)}`
      const created = Number(await redis(['EVAL', createScript, '2', roomKey, codeKey, JSON.stringify(room), roomId, String(ttl)]))
      if (created !== 1) continue
      setRoomSession(res, roomId, room.expiresAt, true)
      return res.status(201).json({ room: { id: roomId, name, expiresAt: room.expiresAt, isOrganizer: true }, code, adminCredential })
    }
    return res.status(503).json({ error: 'Não foi possível criar a sala. Tente novamente.' })
  } catch (error) { return apiError(res, error) }
}
