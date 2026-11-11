import React, { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import * as Ably from 'ably'
import QRCode from 'qrcode'
import './style.css'

type Profile = { id: string; roomId: string; name: string; linkedinUrl: string; createdAt: number }
type Filter = 'all' | 'unseen' | 'seen'
const room = location.pathname.split('/').filter(Boolean).at(-1)?.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 48) || 'turma'
const seenKey = `linkmural:${room}:seen`
const localKey = `linkmural:${room}:profiles`
const readSeen = () => { try { return new Set<string>(JSON.parse(localStorage.getItem(seenKey) || '[]')) } catch { return new Set<string>() } }
const readLocal = (): Profile[] => { try { return JSON.parse(localStorage.getItem(localKey) || '[]') } catch { return [] } }

function App() {
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [seen, setSeen] = useState(readSeen)
  const [filter, setFilter] = useState<Filter>('all')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [localMode, setLocalMode] = useState(false)
  const [connected, setConnected] = useState(false)
  const [toast, setToast] = useState('')
  const [qrOpen, setQrOpen] = useState(false)
  const [qrData, setQrData] = useState('')
  const shareUrl = `${location.host}${location.pathname}`
  const unseenCount = profiles.filter(profile => !seen.has(profile.id)).length

  function updateSeen(next: Set<string>) { setSeen(next); localStorage.setItem(seenKey, JSON.stringify([...next])) }
  function notify(message: string) { setToast(message); window.setTimeout(() => setToast(''), 2800) }

  async function load() {
    try {
      const response = await fetch(`/api/profiles?room=${encodeURIComponent(room)}`)
      if (!response.ok) throw new Error()
      const data = await response.json() as { profiles: (Profile | string)[] }
      setProfiles(data.profiles.map(item => typeof item === 'string' ? JSON.parse(item) as Profile : item))
      setLocalMode(false)
      return true
    } catch {
      setProfiles(readLocal())
      setLocalMode(true)
      return false
    }
  }

  useEffect(() => {
    let disposed = false
    let realtime: Ably.Realtime | undefined
    let poll: number | undefined
    void load().then(() => {
      if (disposed) return
      realtime = new Ably.Realtime({ authUrl: `/api/token?room=${encodeURIComponent(room)}` })
      realtime.connection.on('connected', () => { if (!disposed) setConnected(true) })
      realtime.connection.on('disconnected', () => { if (!disposed) setConnected(false) })
      realtime.connection.on('failed', () => { if (!disposed) setConnected(false) })
      realtime.channels.get(`room:${room}`).subscribe('profile.created', message => {
        if (disposed) return
        const profile = message.data as Profile
        setProfiles(current => current.some(item => item.id === profile.id) ? current : [profile, ...current])
      })
      poll = window.setInterval(() => { if (!disposed) void load() }, 15000)
    })
    return () => { disposed = true; if (poll) window.clearInterval(poll); void realtime?.close() }
  }, [])

  const visibleProfiles = useMemo(() => profiles.filter(profile => filter === 'all' || (filter === 'seen' ? seen.has(profile.id) : !seen.has(profile.id))), [profiles, filter, seen])

  async function publish(event: React.FormEvent) {
    event.preventDefault()
    const trimmedName = name.trim()
    let normalized: URL
    try {
      normalized = new URL(url.trim())
      if (normalized.protocol !== 'https:' || !/(^|\.)linkedin\.com$/i.test(normalized.hostname) || !/^\/(in|pub)\/[a-z0-9%_-]+/i.test(normalized.pathname)) throw new Error()
    } catch { notify('Cole um link válido de perfil do LinkedIn.'); return }
    if (trimmedName.length < 2 || trimmedName.length > 64) { notify('Seu nome deve ter entre 2 e 64 caracteres.'); return }
    setBusy(true)
    const linkedinUrl = `https://www.linkedin.com${normalized.pathname.replace(/\/$/, '')}`
    try {
      const response = await fetch(`/api/profiles?room=${encodeURIComponent(room)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: trimmedName, linkedinUrl }) })
      const data = await response.json() as { profile?: Profile; error?: string }
      if (!response.ok) throw new Error(data.error || 'Não foi possível publicar.')
      const profile = data.profile!
      setProfiles(current => [profile, ...current.filter(item => item.id !== profile.id)])
      setLocalMode(false)
      notify('Seu perfil entrou no mural!')
    } catch (error) {
      if (!localMode && (error instanceof TypeError || error instanceof SyntaxError)) {
        const profile: Profile = { id: crypto.randomUUID(), roomId: room, name: trimmedName, linkedinUrl, createdAt: Date.now() }
        const current = readLocal()
        if (current.some(item => item.linkedinUrl.toLowerCase() === linkedinUrl.toLowerCase())) { notify('Esse perfil já está neste mural.'); setBusy(false); return }
        const next = [profile, ...current].slice(0, 500)
        localStorage.setItem(localKey, JSON.stringify(next)); setProfiles(next); setLocalMode(true); notify('Salvo neste navegador. Configure Redis para compartilhar com a turma.')
      } else notify(error instanceof Error ? error.message : 'Não foi possível publicar.')
    } finally { setBusy(false) }
    setName(''); setUrl('')
  }

  async function share() {
    try { await navigator.clipboard.writeText(location.href); notify('Link copiado!') }
    catch { notify('Não foi possível copiar o link.') }
  }

  async function showQr() {
    setQrData(await QRCode.toDataURL(location.href, { width: 240, margin: 1, color: { dark: '#0f172a', light: '#ffffff' } }))
    setQrOpen(true)
  }

  function toggleSeen(id: string) { const next = new Set(seen); next.has(id) ? next.delete(id) : next.add(id); updateSeen(next) }

  return <main className="page">
    <header className="topbar">
      <div className="header-left"><a className="brand" href="/"><span className="brand-mark">↗</span> LinkMural</a><button className="url-chip" onClick={share} title="Copiar link da sala"><span>{shareUrl}</span><b>⧉</b></button></div>
      <div className="top-actions"><span className={`connection ${connected ? 'online' : ''}`}><i />{connected ? 'Ao vivo' : localMode ? 'Neste navegador' : 'Conectando'}</span><button className="icon-button" onClick={showQr} aria-label="Mostrar QR Code">▦</button></div>
    </header>

    {localMode && <div className="local-note"><span>ⓘ</span> Modo local: este mural aparece apenas neste navegador até o Redis ser configurado.</div>}

    <section className="hero">
      <h1 className="simple-title">Compartilhe seu LinkedIn<br /><span>com a turma.</span></h1>
      <p className="intro">Publique seu perfil para se conectar com os colegas.</p>
      <form className="publish-card" onSubmit={publish}>
        <div className="form-heading"><div className="form-icon">＋</div><div><strong>Entre para o mural</strong><small>Leva menos de um minuto</small></div></div>
        <div className="fields"><label>Seu nome<input value={name} onChange={event => setName(event.target.value)} maxLength={64} placeholder="Como podemos te chamar?" required /></label><label>Link do LinkedIn<input value={url} onChange={event => setUrl(event.target.value)} maxLength={300} type="url" placeholder="https://linkedin.com/in/seu-perfil" required /></label></div>
        <div className="form-bottom"><small>Seu perfil ficará visível para quem tiver acesso a este mural.</small><button className="primary-button" disabled={busy}>{busy ? 'Publicando…' : 'Publicar perfil'} <span>→</span></button></div>
      </form>
      <div className="privacy"><span>♧</span> Sem cadastro. Sem complicação. Só boas conexões.</div>
    </section>

    <section className="wall">
      <div className="wall-heading"><div><h2>Perfis da turma <span className="count">{profiles.length}</span></h2></div><div className="unseen">{unseenCount} <span>não {unseenCount === 1 ? 'visto' : 'vistos'}</span></div></div>
      <div className="toolbar"><div className="filters" aria-label="Filtrar perfis">{([['all','Todos'],['unseen','Não vistos'],['seen','Vistos']] as [Filter,string][]).map(([value,label]) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}{value === 'unseen' && unseenCount > 0 && <b>{unseenCount}</b>}</button>)}</div>{unseenCount > 0 && <button className="mark-all" onClick={() => updateSeen(new Set(profiles.map(profile => profile.id)))}>Marcar todos como vistos</button>}</div>
      {visibleProfiles.length === 0 ? <div className="empty"><div className="empty-art"><span>↗</span><i /><i /><i /></div><h3>{profiles.length === 0 ? 'Seu lugar está reservado.' : 'Tudo em dia por aqui.'}</h3><p>{profiles.length === 0 ? 'Seja a primeira pessoa a compartilhar seu perfil com a turma.' : filter === 'unseen' ? 'Você já viu todos os perfis deste mural.' : 'Nenhum perfil encontrado neste filtro.'}</p></div> : <div className="grid">{visibleProfiles.map(profile => <article className={`profile-card ${seen.has(profile.id) ? 'is-seen' : ''}`} key={profile.id}><div className="card-top"><div className="avatar">{profile.name.trim().split(/\s+/).slice(0,2).map(part => part[0]).join('').toUpperCase()}</div><button className={`seen-pill ${seen.has(profile.id) ? 'seen' : ''}`} onClick={() => toggleSeen(profile.id)}>{seen.has(profile.id) ? '✓ Visto' : '○ Não visto'}</button></div><h3>{profile.name}</h3><a className="linkedin-link" href={profile.linkedinUrl} target="_blank" rel="noopener noreferrer">Ver perfil no LinkedIn <span>↗</span></a><div className="card-footer"><span>Conectando com a turma</span><span className="card-link-icon">in</span></div></article>)}</div>}
    </section>
    <footer><a className="brand footer-brand" href="/">LinkMural <span>↗</span></a><span>Compartilhe o link da sala com a turma.</span></footer>
    {toast && <div className="toast" role="status">{toast}</div>}
    {qrOpen && <div className="modal-backdrop" onClick={() => setQrOpen(false)}><div className="qr-modal" role="dialog" aria-modal="true" aria-label="QR Code do mural" onClick={event => event.stopPropagation()}><button className="close-button" onClick={() => setQrOpen(false)} aria-label="Fechar">×</button><div className="wall-kicker">COMPARTILHE COM A TURMA</div><h2>Aponte a câmera<br />e vem pro mural.</h2><img src={qrData} alt="QR Code para abrir este mural" /><button className="primary-button" onClick={share}>Copiar link <span>↗</span></button></div></div>}
  </main>
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
