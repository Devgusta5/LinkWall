import type { VercelRequest, VercelResponse } from '@vercel/node'
import { activeRoom, apiError } from '../../lib/room-server'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido.' })
  try {
    const { room, organizer } = await activeRoom(req, res)
    return res.status(200).json({ room: { id: room.id, name: room.name, expiresAt: room.expiresAt, isOrganizer: organizer } })
  } catch (error) { return apiError(res, error) }
}
