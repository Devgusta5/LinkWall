import type { VercelRequest, VercelResponse } from '@vercel/node'
import { apiError, enforceRateLimit, hash, readRoomSession, redis, requireSameOrigin, setRoomSession, type Room } from '../../lib/room-server'

const invalidCode = 'Código inválido, sala encerrada ou expirada.'
const joinScript = `
local roomId = redis.call('GET', KEYS[1])
if not roomId then return false end
local raw = redis.call('GET', 'linkwall:room:' .. roomId)
if not raw then return false end
local room = cjson.decode(raw)
if not room.active or tonumber(room.expiresAt) <= tonumber(ARGV[1]) then return false end
return raw
`

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' })
  try {
    requireSameOrigin(req)
    await enforceRateLimit(req, 'join-room', 12)
    const rawCode = req.body?.code
    const code = typeof rawCode === 'string' ? rawCode.trim().replace(/\s+/g, '').toUpperCase() : ''
    if (!/^[A-HJ-NP-Z2-9]{10}$/.test(code)) return res.status(401).json({ error: invalidCode })
    const rawRoom = await redis(['EVAL', joinScript, '1', `linkwall:room-code:${hash(code)}`, String(Date.now())])
    if (typeof rawRoom !== 'string') return res.status(401).json({ error: invalidCode })
    const room = JSON.parse(rawRoom) as Room
    if (!room.active || room.expiresAt <= Date.now()) return res.status(401).json({ error: invalidCode })
    const existingSession = readRoomSession(req, room.id)
    const validExistingSession = existingSession && existingSession.expiresAt > Date.now() ? existingSession : null
    if (!validExistingSession) setRoomSession(res, room.id, room.expiresAt, false)
    return res.status(200).json({ room: { id: room.id, name: room.name, expiresAt: room.expiresAt, isOrganizer: validExistingSession?.organizer ?? false } })
  } catch (error) { return apiError(res, error) }
}
