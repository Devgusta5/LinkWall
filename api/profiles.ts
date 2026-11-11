import type { VercelRequest, VercelResponse } from '@vercel/node'
import Ably from 'ably'
import { activeRoom, apiError, clearRoomSession, enforceRateLimit, HttpError, redis, requireSameOrigin } from '../lib/room-server.js'

const maxProfiles = 500
const readProfilesScript = `
local raw = redis.call('GET', KEYS[1])
if not raw then return -1 end
local room = cjson.decode(raw)
if not room.active or tonumber(room.expiresAt) <= tonumber(ARGV[1]) then return -1 end
return redis.call('LRANGE', KEYS[2], 0, tonumber(ARGV[2]))
`
const createProfileScript = `
local raw = redis.call('GET', KEYS[3])
if not raw then return -1 end
local room = cjson.decode(raw)
if not room.active or tonumber(room.expiresAt) <= tonumber(ARGV[4]) then return -1 end
if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1 then return -3 end
if redis.call('LLEN', KEYS[1]) >= tonumber(ARGV[3]) then return -4 end
redis.call('LPUSH', KEYS[1], ARGV[2])
redis.call('SADD', KEYS[2], ARGV[1])
local ttl = math.ceil((tonumber(room.expiresAt) - tonumber(ARGV[4])) / 1000)
redis.call('EXPIRE', KEYS[1], ttl)
redis.call('EXPIRE', KEYS[2], ttl)
return 1
`

function optionalHttpsUrl(value: unknown): string | undefined | null {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || value.length > 300) return null
  try { const url = new URL(value.trim()); return url.protocol === 'https:' ? url.href : null }
  catch { return null }
}

function optionalGithubUrl(value: unknown): string | undefined | null {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || value.length > 300) return null
  try {
    const url = new URL(value.trim())
    const login = url.pathname.match(/^\/([a-z\d](?:[a-z\d-]{0,37}[a-z\d])?)\/?$/i)?.[1]
    if (url.protocol !== 'https:' || !['github.com', 'www.github.com'].includes(url.hostname.toLowerCase()) || !login) return null
    return `https://github.com/${login}`
  } catch { return null }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')
  try {
    const { room } = await activeRoom(req, res)
    const listKey = `linkwall:room:${room.id}:profiles`
    if (req.method === 'GET') {
      const profiles = await redis(['EVAL', readProfilesScript, '2', `linkwall:room:${room.id}`, listKey, String(Date.now()), String(maxProfiles - 1)])
      if (!Array.isArray(profiles)) {
        clearRoomSession(res, room.id)
        throw new HttpError(410, 'Esta sala expirou ou foi encerrada.')
      }
      return res.status(200).json({ profiles })
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' })
    requireSameOrigin(req)
    const { name, linkedinUrl, githubUrl: rawGithubUrl, socialUrl: rawSocialUrl } = req.body ?? {}
    if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 64 || typeof linkedinUrl !== 'string' || linkedinUrl.length > 300) {
      return res.status(400).json({ error: 'Informe um nome (2 a 64 caracteres) e um link do LinkedIn.' })
    }
    let url: URL
    try { url = new URL(linkedinUrl.trim()) } catch { return res.status(400).json({ error: 'Link do LinkedIn inválido.' }) }
    if (url.protocol !== 'https:' || !/(^|\.)linkedin\.com$/i.test(url.hostname) || !/^\/(in|pub)\/[a-z0-9%_-]+/i.test(url.pathname)) {
      return res.status(400).json({ error: 'Use um link público de perfil do LinkedIn (linkedin.com/in/...).' })
    }
    const githubUrl = optionalGithubUrl(rawGithubUrl)
    const socialUrl = optionalHttpsUrl(rawSocialUrl)
    if (githubUrl === null) return res.status(400).json({ error: 'Informe um link válido de perfil do GitHub.' })
    if (socialUrl === null) return res.status(400).json({ error: 'O link da rede social precisa usar HTTPS.' })
    const profile = {
      id: crypto.randomUUID(), roomId: room.id, name: name.trim(),
      linkedinUrl: `https://www.linkedin.com${url.pathname.replace(/\/$/, '')}`,
      githubUrl, socialUrl, createdAt: Date.now(),
    }
    await enforceRateLimit(req, `publish-profile-${room.id}`, 8)
    const saved = Number(await redis([
      'EVAL', createProfileScript, '3', listKey, `${listKey}:urls`, `linkwall:room:${room.id}`,
      profile.linkedinUrl.toLowerCase(), JSON.stringify(profile), String(maxProfiles), String(Date.now()),
    ]))
    if (saved === -1) throw new HttpError(410, 'Esta sala expirou ou foi encerrada.')
    if (saved === -3) throw new HttpError(409, 'Esse perfil já foi publicado nesta sala.')
    if (saved === -4) throw new HttpError(409, 'Esta sala atingiu o limite de perfis.')
    if (saved !== 1) throw new Error('Unexpected Redis result')
    if (process.env.ABLY_API_KEY) {
      try {
        const client = new Ably.Rest(process.env.ABLY_API_KEY)
        await client.channels.get(`linkwall:room:${room.id}`).publish('profile.created', profile)
      } catch { /* Redis is the source of truth; clients keep polling. */ }
    }
    return res.status(201).json({ profile })
  } catch (error) { return apiError(res, error) }
}
