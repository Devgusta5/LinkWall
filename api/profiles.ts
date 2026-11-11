import type { VercelRequest, VercelResponse } from '@vercel/node'
import Ably from 'ably'

const maxProfiles = 500
const ttlSeconds = 60 * 60 * 24 * 30
const script = `
local hits = redis.call('INCR', KEYS[3])
if hits == 1 then redis.call('EXPIRE', KEYS[3], 60) end
if hits > 8 then return {err='RATE_LIMIT'} end
if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1 then return {err='DUPLICATE'} end
if redis.call('LLEN', KEYS[1]) >= tonumber(ARGV[3]) then return {err='ROOM_FULL'} end
redis.call('LPUSH', KEYS[1], ARGV[2])
redis.call('SADD', KEYS[2], ARGV[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[4]))
return 'OK'
`

function validRoom(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9-]{1,48}$/.test(value)
}

function optionalHttpsUrl(value: unknown): string | undefined | null {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || value.length > 300) return null
  try {
    const url = new URL(value.trim())
    return url.protocol === 'https:' ? url.href : null
  } catch { return null }
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

function redisUrl() {
  const base = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!base || !token) throw new Error('Redis is not configured')
  return { base: base.replace(/\/$/, ''), token }
}

async function redis(command: unknown[]) {
  const { base, token } = redisUrl()
  const response = await fetch(base, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(command) })
  if (!response.ok) throw new Error('Redis request failed')
  const data = await response.json() as { result?: unknown; error?: string }
  if (data.error) throw new Error(data.error)
  return data.result
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const room = req.query.room
  if (!validRoom(room)) return res.status(400).json({ error: 'Sala inválida.' })
  const listKey = `linkwall:${room}:profiles`
  if (req.method === 'GET') {
    try { return res.status(200).json({ profiles: await redis(['LRANGE', listKey, '0', String(maxProfiles - 1)]) }) }
    catch { return res.status(503).json({ error: 'Mural indisponível. Verifique a configuração do Redis.' }) }
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' })
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
  const profile = { id: crypto.randomUUID(), roomId: room, name: name.trim(), linkedinUrl: `https://www.linkedin.com${url.pathname.replace(/\/$/, '')}`, githubUrl, socialUrl, createdAt: Date.now() }
  const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? 'unknown').split(',')[0].trim()
  const rateKey = `linkwall:rate:${ip}:${Math.floor(Date.now() / 60000)}`
  try {
    await redis(['EVAL', script, '3', listKey, `${listKey}:urls`, rateKey, profile.linkedinUrl.toLowerCase(), JSON.stringify(profile), String(maxProfiles), String(ttlSeconds)])
    if (process.env.ABLY_API_KEY) {
      try {
        const client = new Ably.Rest(process.env.ABLY_API_KEY)
        await client.channels.get(`room:${room}`).publish('profile.created', profile)
      } catch { /* Redis remains the source of truth; clients fall back to polling. */ }
    }
    return res.status(201).json({ profile })
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (message.includes('DUPLICATE')) return res.status(409).json({ error: 'Esse perfil já foi publicado nesta sala.' })
    if (message.includes('RATE_LIMIT')) return res.status(429).json({ error: 'Muitas publicações. Aguarde um minuto.' })
    if (message.includes('ROOM_FULL')) return res.status(409).json({ error: 'Esta sala atingiu o limite de perfis.' })
    return res.status(503).json({ error: 'Não foi possível publicar agora. Tente novamente.' })
  }
}
