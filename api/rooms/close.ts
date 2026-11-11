import { timingSafeEqual } from 'node:crypto'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { activeRoom, apiError, hash, HttpError, redis, requireSameOrigin } from '../../lib/room-server.js'

const closeScript = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local room = cjson.decode(raw)
if not room.active then return 2 end
room.active = false
room.closedAt = tonumber(ARGV[1])
local ttl = redis.call('TTL', KEYS[1])
if ttl < 1 then return 0 end
redis.call('SET', KEYS[1], cjson.encode(room), 'EX', ttl)
return 1
`

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' })
  try {
    requireSameOrigin(req)
    const { room, organizer } = await activeRoom(req, res)
    if (!organizer) throw new HttpError(403, 'Somente a pessoa que criou a sala pode encerrá-la.')
    const credential = req.body?.adminCredential
    if (typeof credential !== 'string' || credential.length > 128) throw new HttpError(403, 'Credencial administrativa inválida.')
    const supplied = Buffer.from(hash(credential), 'hex')
    const stored = Buffer.from(room.adminHash, 'hex')
    if (stored.length !== supplied.length || !timingSafeEqual(stored, supplied)) throw new HttpError(403, 'Credencial administrativa inválida.')
    const closed = Number(await redis(['EVAL', closeScript, '1', `linkwall:room:${room.id}`, String(Date.now())]))
    if (closed === 0) throw new HttpError(410, 'Esta sala expirou ou foi encerrada.')
    return res.status(200).json({ closed: true })
  } catch (error) { return apiError(res, error) }
}
