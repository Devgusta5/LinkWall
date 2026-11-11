import type { VercelRequest, VercelResponse } from '@vercel/node'
import { randomBytes } from 'node:crypto'
import Ably from 'ably'
import { activeRoom, apiError, clearRoomSession, enforceRateLimit, hash, HttpError, redis, requireSameOrigin } from '../lib/room-server.js'

const maxProfiles = 500
type StoredProfile = { id: string; roomId: string; name: string; linkedinUrl: string; githubUrl?: string; socialUrl?: string; createdAt: number; updatedAt?: number; editHash?: string }

function publicProfile(value: unknown) {
  const profile = typeof value === 'string' ? JSON.parse(value) as Record<string, unknown> : { ...value as Record<string, unknown> }
  delete profile.editHash
  return profile
}

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
const updateProfileScript = `
local raw = redis.call('GET', KEYS[3])
if not raw then return '-1' end
local room = cjson.decode(raw)
if not room.active or tonumber(room.expiresAt) <= tonumber(ARGV[4]) then return '-1' end
local updated = cjson.decode(ARGV[3])
local profiles = redis.call('LRANGE', KEYS[1], 0, -1)
for i = 1, #profiles do
  local profile = cjson.decode(profiles[i])
  if profile.id == ARGV[1] then
    if profile.editHash ~= ARGV[2] then return '-2' end
    local oldUrl = string.lower(profile.linkedinUrl)
    local newUrl = string.lower(updated.linkedinUrl)
    if oldUrl ~= newUrl and redis.call('SISMEMBER', KEYS[2], newUrl) == 1 then return '-3' end
    if oldUrl ~= newUrl then
      redis.call('SREM', KEYS[2], oldUrl)
      redis.call('SADD', KEYS[2], newUrl)
    end
    profile.name = updated.name
    profile.linkedinUrl = updated.linkedinUrl
    profile.githubUrl = updated.githubUrl
    profile.socialUrl = updated.socialUrl
    profile.updatedAt = tonumber(ARGV[4])
    local encoded = cjson.encode(profile)
    redis.call('LSET', KEYS[1], i - 1, encoded)
    local ttl = math.ceil((tonumber(room.expiresAt) - tonumber(ARGV[4])) / 1000)
    redis.call('EXPIRE', KEYS[1], ttl)
    redis.call('EXPIRE', KEYS[2], ttl)
    return encoded
  end
end
return '-4'
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
      return res.status(200).json({ profiles: profiles.map(publicProfile) })
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' })
    requireSameOrigin(req)
    const { name, linkedinUrl, githubUrl: rawGithubUrl, socialUrl: rawSocialUrl, profileId, editCredential: rawEditCredential } = req.body ?? {}
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
    const editable = {
      name: name.trim(), linkedinUrl: `https://www.linkedin.com${url.pathname.replace(/\/$/, '')}`,
      githubUrl, socialUrl,
    }
    await enforceRateLimit(req, `publish-profile-${room.id}`, 8)
    const now = Date.now()
    let profile: StoredProfile
    let editCredential: string | undefined
    let updated = false
    if (profileId === undefined) {
      editCredential = randomBytes(32).toString('base64url')
      profile = { id: crypto.randomUUID(), roomId: room.id, ...editable, createdAt: now, editHash: hash(editCredential) }
      const saved = Number(await redis([
        'EVAL', createProfileScript, '3', listKey, `${listKey}:urls`, `linkwall:room:${room.id}`,
        profile.linkedinUrl.toLowerCase(), JSON.stringify(profile), String(maxProfiles), String(now),
      ]))
      if (saved === -1) throw new HttpError(410, 'Esta sala expirou ou foi encerrada.')
      if (saved === -3) throw new HttpError(409, 'Esse perfil já foi publicado nesta sala.')
      if (saved === -4) throw new HttpError(409, 'Esta sala atingiu o limite de perfis.')
      if (saved !== 1) throw new Error('Unexpected Redis result')
    } else {
      if (typeof profileId !== 'string' || !/^[0-9a-f-]{36}$/i.test(profileId) || typeof rawEditCredential !== 'string' || rawEditCredential.length < 32 || rawEditCredential.length > 128) {
        return res.status(400).json({ error: 'Não foi possível validar a edição deste perfil.' })
      }
      const result = await redis([
        'EVAL', updateProfileScript, '3', listKey, `${listKey}:urls`, `linkwall:room:${room.id}`,
        profileId, hash(rawEditCredential), JSON.stringify(editable), String(now),
      ])
      if (result === '-1') throw new HttpError(410, 'Esta sala expirou ou foi encerrada.')
      if (result === '-2') throw new HttpError(403, 'Você só pode editar o perfil publicado neste navegador.')
      if (result === '-3') throw new HttpError(409, 'Outro perfil já usa esse link do LinkedIn.')
      if (result === '-4') throw new HttpError(404, 'Esse perfil não está mais nesta sala.')
      if (typeof result !== 'string') throw new Error('Unexpected Redis result')
      profile = JSON.parse(result) as StoredProfile
      updated = true
    }
    const safeProfile = publicProfile(profile)
    if (process.env.ABLY_API_KEY) {
      try {
        const client = new Ably.Rest(process.env.ABLY_API_KEY)
        await client.channels.get(`linkwall:room:${room.id}`).publish(updated ? 'profile.updated' : 'profile.created', safeProfile)
      } catch { /* Redis is the source of truth; clients keep polling. */ }
    }
    return res.status(updated ? 200 : 201).json({ profile: safeProfile, ...(editCredential ? { editCredential } : {}) })
  } catch (error) { return apiError(res, error) }
}
