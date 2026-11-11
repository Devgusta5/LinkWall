import React, { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import * as Ably from 'ably'
import QRCode from 'qrcode'
import './style.css'

type Profile = { id: string; roomId: string; name: string; linkedinUrl?: string; githubUrl?: string; socialUrl?: string; contactText?: string; createdAt: number }
type RoomSession = { id: string; name: string; expiresAt: number; isOrganizer: boolean }
type Filter = 'all' | 'unseen' | 'seen'
type ApiResponse<T> = T & { error?: string }
class ApiError extends Error { constructor(message: string, readonly status: number) { super(message) } }
const adminKey = (id: string) => `linkwall:room:${id}:admin`
const codeKey = (id: string) => `linkwall:room:${id}:code`
const profileEditKey = (roomId: string, profileId: string) => `linkwall:room:${roomId}:profile:${profileId}:edit`
const seenKey = (id: string) => `linkwall:${id}:seen`
const readSeen = (id: string) => { try { return new Set<string>(JSON.parse(localStorage.getItem(seenKey(id)) || '[]')) } catch { return new Set<string>() } }

async function api<T>(path: string, body?: unknown, roomId?: string): Promise<T> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (roomId) headers['X-Linkwall-Room-Id'] = roomId
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const data = await response.json().catch(() => ({})) as ApiResponse<T>
  if (!response.ok || Object.keys(data).length === 0) {
    const requestId = response.headers.get('x-vercel-id')
    const message = data.error || `A API respondeu sem JSON (HTTP ${response.status}). Consulte os logs da Vercel${requestId ? ` · ${requestId}` : ''}.`
    throw new ApiError(message, response.status)
  }
  return data
}

function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => localStorage.getItem('linkwall:theme-choice') === 'light' ? 'light' : 'dark')
  const [page, setPage] = useState<'loading' | 'lobby' | 'active' | 'closed'>('loading')
  const [room, setRoom] = useState<RoomSession | null>(null)
  const [roomName, setRoomName] = useState('')
  const [joinCode, setJoinCode] = useState(new URLSearchParams(location.search).get('code') || '')
  const [roomCode, setRoomCode] = useState('')
  const [adminCredential, setAdminCredential] = useState('')
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [seen, setSeen] = useState<Set<string>>(() => new Set())
  const [filter, setFilter] = useState<Filter>('all')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [github, setGithub] = useState('')
  const [social, setSocial] = useState('')
  const [contactText, setContactText] = useState('')
  const [editingProfileId, setEditingProfileId] = useState('')
  const [profileSuccess, setProfileSuccess] = useState<{ title: string; detail: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [connected, setConnected] = useState(false)
  const [toast, setToast] = useState('')
  const [loadError, setLoadError] = useState('')
  const [qrOpen, setQrOpen] = useState(false)
  const [qrData, setQrData] = useState('')
  const unseenCount = profiles.filter(profile => !seen.has(profile.id)).length
  const inviteUrl = roomCode ? `${location.origin}${location.pathname}?code=${encodeURIComponent(roomCode)}` : location.href

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#050608' : '#dceaff')
    localStorage.setItem('linkwall:theme-choice', theme)
  }, [theme])

  useEffect(() => {
    if (!profileSuccess) return
    const timeout = window.setTimeout(() => setProfileSuccess(null), 3200)
    return () => window.clearTimeout(timeout)
  }, [profileSuccess])

  function notify(message: string) { setToast(message); window.setTimeout(() => setToast(''), 3000) }
  function updateSeen(next: Set<string>) {
    if (!room) return
    setSeen(next)
    localStorage.setItem(seenKey(room.id), JSON.stringify([...next]))
  }
  function setActiveRoom(data: RoomSession, code: string, admin = '') {
    sessionStorage.setItem('linkwall:active-room', data.id)
    setRoom(data)
    setRoomCode(code)
    setAdminCredential(admin)
    setSeen(readSeen(data.id))
    setPage('active')
    setProfiles([])
    history.replaceState({}, '', location.pathname)
  }

  useEffect(() => {
    let cancelled = false
    const activeRoomId = sessionStorage.getItem('linkwall:active-room') || ''
    void api<{ room: RoomSession }>('/api/rooms/current', undefined, activeRoomId).then(({ room: current }) => {
      if (cancelled) return
      const code = sessionStorage.getItem(codeKey(current.id)) || ''
      const admin = current.isOrganizer ? sessionStorage.getItem(adminKey(current.id)) || '' : ''
      setActiveRoom(current, code, admin)
    }).catch(error => {
      if (cancelled) return
      if (error instanceof ApiError && (error.status === 401 || error.status === 410)) sessionStorage.removeItem('linkwall:active-room')
      setPage(error instanceof ApiError && error.status === 410 ? 'closed' : 'lobby')
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!room || page !== 'active') return
    const activeRoomId = room.id
    let disposed = false
    let realtime: Ably.Realtime | undefined
    async function load() {
      try {
        const response = await fetch('/api/profiles', { credentials: 'same-origin', headers: { 'X-Linkwall-Room-Id': activeRoomId } })
        if (response.status === 410 || response.status === 401) {
          if (!disposed) { setPage(response.status === 410 ? 'closed' : 'lobby'); setRoom(null) }
          return
        }
        if (!response.ok) throw new Error('Não foi possível carregar os perfis da sala.')
        const data = await response.json() as { profiles: (Profile | string)[] }
        if (!disposed) { setProfiles(data.profiles.map(item => typeof item === 'string' ? JSON.parse(item) as Profile : item)); setLoadError('') }
      } catch (error) { if (!disposed) setLoadError(error instanceof Error ? error.message : 'Falha ao carregar o mural.') }
    }
    void load().then(() => {
      if (disposed) return
      realtime = new Ably.Realtime({ authUrl: '/api/rooms/ably-token', authMethod: 'POST', authHeaders: { 'X-Linkwall-Room-Id': activeRoomId } })
      realtime.connection.on('connected', () => { if (!disposed) setConnected(true) })
      realtime.connection.on('disconnected', () => { if (!disposed) setConnected(false) })
      realtime.connection.on('failed', () => { if (!disposed) setConnected(false) })
      const syncProfile = (message: Ably.Message) => {
        if (disposed) return
        const profile = message.data as Profile
        setProfiles(current => current.some(item => item.id === profile.id)
          ? current.map(item => item.id === profile.id ? profile : item)
          : [profile, ...current])
      }
      const channel = realtime.channels.get(`linkwall:room:${activeRoomId}`)
      channel.subscribe('profile.created', syncProfile)
      channel.subscribe('profile.updated', syncProfile)
    })
    const poll = window.setInterval(() => { if (!disposed) void load() }, 15000)
    return () => { disposed = true; window.clearInterval(poll); setConnected(false); void realtime?.close() }
  }, [room, page])

  const visibleProfiles = useMemo(() => profiles.filter(profile => filter === 'all' || (filter === 'seen' ? seen.has(profile.id) : !seen.has(profile.id))), [profiles, filter, seen])

  async function createRoom(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    try {
      const data = await api<{ room: RoomSession; code: string; adminCredential: string }>('/api/rooms', { name: roomName.trim() })
      sessionStorage.setItem(codeKey(data.room.id), data.code)
      sessionStorage.setItem(adminKey(data.room.id), data.adminCredential)
      setActiveRoom(data.room, data.code, data.adminCredential)
      setRoomName('')
      notify('Sala criada! Compartilhe o código ou o convite.')
    } catch (error) { notify(error instanceof Error ? error.message : 'Não foi possível criar a sala.') }
    finally { setBusy(false) }
  }

  async function joinRoom(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    try {
      const code = joinCode.trim().replace(/\s+/g, '').toUpperCase()
      const data = await api<{ room: RoomSession }>('/api/rooms/join', { code })
      sessionStorage.setItem(codeKey(data.room.id), code)
      setActiveRoom(data.room, code)
      notify(`Você entrou em ${data.room.name}.`)
    } catch (error) { notify(error instanceof Error ? error.message : 'Código inválido, sala encerrada ou expirada.') }
    finally { setBusy(false) }
  }

  async function closeRoom() {
    if (!room || !adminCredential || !window.confirm(`Encerrar a sala “${room.name}”? Novas entradas e publicações serão bloqueadas.`)) return
    setBusy(true)
    try {
      await api('/api/rooms/close', { adminCredential }, room.id)
      sessionStorage.removeItem(adminKey(room.id))
      sessionStorage.removeItem(codeKey(room.id))
      sessionStorage.removeItem('linkwall:active-room')
      setAdminCredential(''); setRoomCode(''); setRoom(null); setPage('closed'); setProfiles([])
      notify('Sala encerrada.')
    } catch (error) { notify(error instanceof Error ? error.message : 'Não foi possível encerrar a sala.') }
    finally { setBusy(false) }
  }

  async function publish(event: React.FormEvent) {
    event.preventDefault()
    if (!room) { notify('Entre em uma sala para publicar seus links.'); return }
    const trimmedName = name.trim()
    let linkedinUrl: string | undefined
    if (url.trim()) {
      try {
        const normalized = new URL(url.trim())
        if (normalized.protocol !== 'https:' || !/(^|\.)linkedin\.com$/i.test(normalized.hostname) || !/^\/(in|pub)\/[a-z0-9%_-]+/i.test(normalized.pathname)) throw new Error()
        linkedinUrl = `https://www.linkedin.com${normalized.pathname.replace(/\/$/, '')}`
      } catch { notify('Cole um link válido de perfil do LinkedIn ou deixe o campo vazio.'); return }
    }
    if (trimmedName.length < 2 || trimmedName.length > 64) { notify('Seu nome deve ter entre 2 e 64 caracteres.'); return }
    let githubUrl: string | undefined
    if (github.trim()) {
      try {
        const profile = new URL(github.trim())
        const login = profile.pathname.match(/^\/([a-z\d](?:[a-z\d-]{0,37}[a-z\d])?)\/?$/i)?.[1]
        if (profile.protocol !== 'https:' || !['github.com', 'www.github.com'].includes(profile.hostname.toLowerCase()) || !login) throw new Error()
        githubUrl = `https://github.com/${login}`
      } catch { notify('Informe um link válido de perfil do GitHub.'); return }
    }
    let socialUrl: string | undefined
    if (social.trim()) {
      try { const profile = new URL(social.trim()); if (profile.protocol !== 'https:') throw new Error(); socialUrl = profile.href }
      catch { notify('O link da rede social deve começar com https://.'); return }
    }
    const editingId = editingProfileId
    const editCredential = editingId ? sessionStorage.getItem(profileEditKey(room.id, editingId)) : ''
    if (editingId && !editCredential) { notify('Não foi possível validar a edição deste perfil.'); cancelProfileEdit(); return }
    setBusy(true)
    try {
      const data = await api<{ profile: Profile; editCredential?: string }>('/api/profiles', {
        name: trimmedName, linkedinUrl, githubUrl, socialUrl, contactText,
        ...(editingId ? { profileId: editingId, editCredential } : {}),
      }, room.id)
      if (data.editCredential) sessionStorage.setItem(profileEditKey(room.id, data.profile.id), data.editCredential)
      setProfiles(current => current.some(item => item.id === data.profile.id)
        ? current.map(item => item.id === data.profile.id ? data.profile : item)
        : [data.profile, ...current])
      setProfileSuccess(editingId
        ? { title: 'Alterações salvas!', detail: 'Seu perfil foi atualizado no mural.' }
        : { title: 'Publicado com sucesso!', detail: `Seu perfil já aparece no mural, ${trimmedName}.` })
      setEditingProfileId('')
      setName(''); setUrl(''); setGithub(''); setSocial(''); setContactText('')
    } catch (error) {
      if (error instanceof ApiError && error.status === 410) { setPage('closed'); setRoom(null) }
      else if (error instanceof ApiError && error.status === 401) { setPage('lobby'); setRoom(null) }
      notify(error instanceof Error ? error.message : 'Não foi possível publicar.')
    } finally { setBusy(false) }
  }

  async function copy(value: string, message: string) {
    try { await navigator.clipboard.writeText(value); notify(message) }
    catch { notify('Não foi possível copiar.') }
  }
  function profileListText() {
    const entries = profiles.map(profile => [
      profile.name,
      profile.linkedinUrl && `LinkedIn: ${profile.linkedinUrl}`,
      profile.githubUrl && `GitHub: ${profile.githubUrl}`,
      profile.socialUrl && `Site / rede social: ${profile.socialUrl}`,
      profile.contactText && `Contato: ${profile.contactText}`,
    ].filter(Boolean).join('\n'))
    return [`LinkWall — ${room?.name ?? 'Mural da turma'}`, `${profiles.length} perfil${profiles.length === 1 ? '' : 'is'}`, '', ...entries].join('\n\n')
  }
  function downloadProfileList() {
    const file = new Blob([profileListText()], { type: 'text/plain;charset=utf-8' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(file)
    link.download = 'linkwall-perfis.txt'
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1000)
  }
  async function showQr() {
    setQrData(await QRCode.toDataURL(inviteUrl, { width: 240, margin: 1, color: { dark: '#0f172a', light: '#ffffff' } }))
    setQrOpen(true)
  }
  function toggleSeen(id: string) { const next = new Set(seen); next.has(id) ? next.delete(id) : next.add(id); updateSeen(next) }

  function startEditingProfile(profile: Profile) {
    if (!room || !sessionStorage.getItem(profileEditKey(room.id, profile.id))) return
    setEditingProfileId(profile.id)
    setProfileSuccess(null)
    setName(profile.name)
    setUrl(profile.linkedinUrl || '')
    setGithub(profile.githubUrl || '')
    setSocial(profile.socialUrl || '')
    setContactText(profile.contactText || '')
    document.querySelector('.profile-form')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  function cancelProfileEdit() {
    setEditingProfileId('')
    setName(''); setUrl(''); setGithub(''); setSocial(''); setContactText('')
  }

  return <main className="page">
    <header className="topbar">
      <a className="brand" href="/" aria-label="LinkWall, início"><img className="brand-mark" src="/mark.svg" alt="" /> LinkWall</a>
      <div className="top-actions">{page === 'active' && room && <><span className={`connection ${connected ? 'online' : ''}`}><i />{connected ? 'Ao vivo' : 'Atualizando'}</span><button className="icon-button" onClick={() => void showQr()} aria-label="Mostrar QR Code do convite">▦</button><button className="share-button" onClick={() => void copy(inviteUrl, 'Convite copiado!')}>Copiar convite <span>↗</span></button></>}<button className="theme-toggle" onClick={() => setTheme(value => value === 'light' ? 'dark' : 'light')} aria-label={theme === 'light' ? 'Ativar tema escuro' : 'Ativar tema claro'} title="Alternar tema">{theme === 'light' ? '☾' : '☼'}</button></div>
    </header>

    {page === 'loading' && <section className="hero"><p className="intro">Carregando a sala…</p></section>}

    {(page === 'lobby' || page === 'closed') && <section className="hero room-lobby">
      <h1 className="simple-title">Mural da turma</h1>
      <p className="intro">Crie uma sala para sua apresentação ou entre com o código que recebeu.</p>
      {page === 'closed' && <div className="closed-note">Esta sala foi encerrada ou expirou. Crie outra ou entre em uma sala ativa.</div>}
      <div className="room-options">
        <form className="publish-card" onSubmit={createRoom}>
          <div className="form-heading"><div className="form-icon">＋</div><div><strong>Criar sala</strong><small>Você recebe o código e pode encerrar a sala.</small></div></div>
          <label className="room-name-field">Nome da sala<input value={roomName} onChange={event => setRoomName(event.target.value)} maxLength={60} minLength={2} placeholder="Ex.: Aula de Produto" required /></label>
          <button className="primary-button room-action" disabled={busy}>{busy ? 'Criando…' : 'Criar sala'} <span>→</span></button>
        </form>
        <form className="publish-card" onSubmit={joinRoom}>
          <div className="form-heading"><div className="form-icon">↗</div><div><strong>Entrar com código</strong><small>Peça o código a quem organizou.</small></div></div>
          <label className="room-name-field">Código da sala<input value={joinCode} onChange={event => setJoinCode(event.target.value.toUpperCase())} maxLength={20} placeholder="Ex.: 8KJ4P7M2QX" autoComplete="off" required /></label>
          <button className="secondary-button room-action" disabled={busy}>{busy ? 'Entrando…' : 'Entrar na sala'} <span>→</span></button>
        </form>
      </div>
    </section>}

    {page === 'active' && room && <>
      <section className="hero active-room-hero">
        <div className="room-label">MURAL DA TURMA</div>
        <h1 className="simple-title">{room.name}</h1>
        <p className="intro">Compartilhe seu perfil para se conectar com os colegas.</p>
        {room.isOrganizer && <div className="invite-card"><div><small>CÓDIGO DE ACESSO</small><strong>{roomCode || 'Disponível na aba em que a sala foi criada'}</strong></div><div className="invite-actions">{roomCode && <button className="secondary-button" onClick={() => void copy(roomCode, 'Código copiado!')}>Copiar código</button>}<button className="primary-button" onClick={() => void copy(inviteUrl, 'Convite copiado!')}>Copiar convite</button></div></div>}
        {!room.isOrganizer && roomCode && <div className="joined-note">Sala protegida por código · {new Date(room.expiresAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</div>}
        {room.isOrganizer && !adminCredential && <div className="closed-note">A credencial de encerramento fica nesta aba. Se ela foi perdida, a sala expirará automaticamente.</div>}
        <form className="publish-card profile-form" onSubmit={publish}>
          <div className="form-heading"><div className="form-icon">{editingProfileId ? '✎' : '＋'}</div><div><strong>{editingProfileId ? 'Editar meu perfil' : 'Entre para o mural'}</strong><small>{editingProfileId ? 'Atualize os links que os colegas veem.' : 'Leva menos de um minuto'}</small></div></div>
          {profileSuccess ? <div className="publish-success" role="status" aria-live="polite"><span className="success-check" aria-hidden="true">✓</span><div><strong>{profileSuccess.title}</strong><p>{profileSuccess.detail}</p><small>Você pode continuar conhecendo a turma.</small></div></div> : <>
            <div className="fields">
              <label><span>Seu nome</span><input value={name} onChange={event => setName(event.target.value)} maxLength={64} placeholder="Como podemos te chamar?" required /></label>
      <label><span>Link do LinkedIn <small className="optional">opcional</small></span><input value={url} onChange={event => setUrl(event.target.value)} maxLength={300} type="url" placeholder="https://linkedin.com/in/seu-perfil" /></label>
              <label><span>GitHub <small className="optional">opcional</small></span><input value={github} onChange={event => setGithub(event.target.value)} maxLength={300} type="url" placeholder="https://github.com/seu-usuario" /></label>
              <label><span>Outra rede social <small className="optional">opcional</small></span><input value={social} onChange={event => setSocial(event.target.value)} maxLength={300} type="url" placeholder="https://instagram.com/seu-perfil" /></label>
              <label className="field-wide"><span>Outro contato <small className="optional">opcional</small></span><input value={contactText} onChange={event => setContactText(event.target.value)} maxLength={160} placeholder="E-mail, telefone ou @" /></label>
            </div>
            <div className="form-bottom">{editingProfileId && <button type="button" className="secondary-button" onClick={cancelProfileEdit}>Cancelar</button>}<small>Seu nome e contatos informados ficarão visíveis para participantes desta sala.</small><button className="primary-button" disabled={busy}>{busy ? (editingProfileId ? 'Salvando…' : 'Publicando…') : (editingProfileId ? 'Salvar alterações' : 'Publicar perfil')} <span>→</span></button></div>
          </>}
        </form>
      </section>

      <section className="wall">
        <div className="wall-heading"><div><h2>Perfis da turma <span className="count">{profiles.length}</span></h2></div><div className="unseen">{unseenCount} <span>não {unseenCount === 1 ? 'visto' : 'vistos'}</span></div></div>
        <div className="toolbar"><div className="filters" aria-label="Filtrar perfis">{([['all','Todos'],['unseen','Não vistos'],['seen','Vistos']] as [Filter,string][]).map(([value,label]) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}{value === 'unseen' && unseenCount > 0 && <b>{unseenCount}</b>}</button>)}</div>{unseenCount > 0 && <button className="mark-all" onClick={() => updateSeen(new Set(profiles.map(profile => profile.id)))}>Marcar todos como vistos</button>}</div>
        <div className="export-bar"><p>Leve os contatos com você: copie para colar no PyDrop ou baixe a lista.</p><div><button className="secondary-button" onClick={() => void copy(profileListText(), 'Lista copiada! Cole no PyDrop ou onde quiser.')} disabled={!profiles.length}>Copiar texto</button><button className="secondary-button" onClick={downloadProfileList} disabled={!profiles.length}>Baixar .txt</button></div></div>
        {loadError && <div className="closed-note">{loadError}</div>}
        {visibleProfiles.length === 0 ? <div className="empty"><div className="empty-art"><span>↗</span><i /><i /><i /></div><h3>{profiles.length === 0 ? 'A sala está pronta.' : 'Tudo em dia por aqui.'}</h3><p>{profiles.length === 0 ? 'Seja a primeira pessoa a compartilhar seu perfil com a turma.' : filter === 'unseen' ? 'Você já viu todos os perfis desta sala.' : 'Nenhum perfil encontrado neste filtro.'}</p></div> : <div className="grid">{visibleProfiles.map(profile => <article className={`profile-card ${seen.has(profile.id) ? 'is-seen' : ''}`} key={profile.id}><div className="card-top"><div className="avatar">{profile.name.trim().split(/\s+/).slice(0,2).map(part => part[0]).join('').toUpperCase()}</div><div className="card-top-actions"><button className={`seen-pill ${seen.has(profile.id) ? 'seen' : ''}`} onClick={() => toggleSeen(profile.id)}>{seen.has(profile.id) ? '✓ Visto' : '○ Não visto'}</button>{room && sessionStorage.getItem(profileEditKey(room.id, profile.id)) && <button className="edit-pill" onClick={() => startEditingProfile(profile)}>Editar</button>}</div></div><h3>{profile.name}</h3><div className="profile-links">{profile.linkedinUrl && <a href={profile.linkedinUrl} target="_blank" rel="noopener noreferrer">LinkedIn ↗</a>}{profile.githubUrl && <a href={profile.githubUrl} target="_blank" rel="noopener noreferrer">GitHub ↗</a>}{profile.socialUrl && <a href={profile.socialUrl} target="_blank" rel="noopener noreferrer">Rede social ↗</a>}</div>{profile.contactText && <p className="profile-contact">Contato: {profile.contactText}</p>}{!profile.linkedinUrl && !profile.githubUrl && !profile.socialUrl && !profile.contactText && <p className="profile-contact">Ainda sem contatos adicionados</p>}<div className="card-footer"><span>Conectando com a turma</span><span className="card-link-icon" aria-hidden="true">↗</span></div></article>)}</div>}
      </section>
      {room.isOrganizer && adminCredential && <div className="close-room-bar"><span>Sala temporária · expira em {new Date(room.expiresAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</span><button className="close-room-button" onClick={() => void closeRoom()} disabled={busy}>Encerrar sala</button></div>}
    </>}

    <footer>
      <div className="footer-about"><a className="brand footer-brand" href="/" aria-label="LinkWall, início"><img className="brand-mark" src="/mark.svg" alt="" /> LinkWall</a><p>Conecte sua turma em um mural simples de perfis e links.</p></div>
      <ul className="footer-features" aria-label="Funcionalidades"><li>Salas temporárias</li><li>Convite por código e QR</li><li>Perfis com links profissionais</li><li>Atualização em tempo real</li></ul>
      <div className="footer-links"><a className="pydrop-link" href="https://pydrop.vercel.app/" target="_blank" rel="noopener noreferrer"><img src="/pydrop-logo.png" alt="" /><span>Experimente também o <strong>PyDrop</strong></span><span className="pydrop-arrow" aria-hidden="true">↗</span></a><a className="github-button" href="https://github.com/Devgusta5" target="_blank" rel="noopener noreferrer" aria-label="GitHub de Devgusta5"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .7a11.3 11.3 0 0 0-3.57 22.02c.57.1.77-.25.77-.55v-2.12c-3.14.68-3.8-1.33-3.8-1.33-.52-1.3-1.27-1.65-1.27-1.65-1.03-.7.08-.68.08-.68 1.14.08 1.74 1.17 1.74 1.17 1.01 1.73 2.65 1.23 3.3.94.1-.73.4-1.23.72-1.52-2.5-.29-5.14-1.25-5.14-5.58 0-1.23.44-2.23 1.16-3.02-.12-.29-.5-1.43.11-2.98 0 0 .95-.3 3.11 1.15a10.8 10.8 0 0 1 5.66 0c2.16-1.46 3.1-1.15 3.1-1.15.62 1.55.23 2.69.11 2.98.72.79 1.15 1.79 1.15 3.02 0 4.34-2.65 5.29-5.17 5.57.41.36.77 1.04.77 2.1v3.12c0 .3.2.66.78.55A11.3 11.3 0 0 0 12 .7Z" /></svg><span>Devgusta5</span></a></div>
    </footer>
    {toast && <div className="toast" role="status">{toast}</div>}
    {qrOpen && <div className="modal-backdrop" onClick={() => setQrOpen(false)}><div className="qr-modal" role="dialog" aria-modal="true" aria-label="QR Code do convite" onClick={event => event.stopPropagation()}><button className="close-button" onClick={() => setQrOpen(false)} aria-label="Fechar">×</button><div className="wall-kicker">CONVITE DA SALA</div><h2>Aponte a câmera<br />e entre no mural.</h2><img src={qrData} alt="QR Code para entrar nesta sala" /><button className="primary-button" onClick={() => void copy(inviteUrl, 'Convite copiado!')}>Copiar convite <span>↗</span></button></div></div>}
  </main>
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
