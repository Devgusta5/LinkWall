import type { VercelRequest, VercelResponse } from '@vercel/node'
import Ably from 'ably'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const room = req.query.room
  const key = process.env.ABLY_API_KEY
  if (typeof room !== 'string' || !/^[a-z0-9-]{1,48}$/.test(room)) return res.status(400).json({ error: 'Sala inválida.' })
  if (!key) return res.status(503).json({ error: 'Realtime não configurado.' })
  try {
    const client = new Ably.Rest(key)
    const request = await client.auth.createTokenRequest({ capability: JSON.stringify({ [`room:${room}`]: ['subscribe'] }) })
    return res.status(200).json(request)
  } catch {
    return res.status(503).json({ error: 'Realtime indisponível.' })
  }
}
