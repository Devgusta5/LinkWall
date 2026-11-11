import type { VercelRequest, VercelResponse } from '@vercel/node'
import Ably from 'ably'
import { activeRoom, apiError, requireSameOrigin } from '../../lib/room-server'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' })
  try {
    requireSameOrigin(req)
    const { room } = await activeRoom(req, res)
    const key = process.env.ABLY_API_KEY
    if (!key) return res.status(503).json({ error: 'Realtime não configurado.' })
    const client = new Ably.Rest(key)
    const channel = `linkwall:room:${room.id}`
    const request = await client.auth.createTokenRequest({
      capability: JSON.stringify({ [channel]: ['subscribe'] }),
      ttl: Math.min(60 * 60 * 1000, room.expiresAt - Date.now()),
    })
    return res.status(200).json(request)
  } catch (error) { return apiError(res, error) }
}
