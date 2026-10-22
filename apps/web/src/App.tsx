import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
const VoicePanel = lazy(() => import('./VoicePanel.js'));

type User = { id: string; username: string; displayName: string };
type Server = { id: string; name: string; description: string };
type Channel = { id: string; name: string; kind: string };
type Message = { id: string; content: string; createdAt: string; authorId: string; username: string; displayName: string };
type Member = { id: string; username: string; displayName: string };
type InvitePreview = { id: string; name: string; description: string };
type Restriction = { userId: string; username: string; displayName: string; kind: string; reason: string; expiresAt: string | null };
const api = async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
  const response = await fetch(path, { ...init, credentials: 'include', headers: { 'content-type': 'application/json', ...init.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? 'Etwas ist schiefgelaufen.');
  return data as T;
};

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [servers, setServers] = useState<Server[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [server, setServer] = useState<Server | null>(null);
  const [channel, setChannel] = useState<Channel | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [memberCount, setMemberCount] = useState(0);
  const [message, setMessage] = useState('');
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<'server' | 'channel' | 'invite' | 'moderation' | 'role' | null>(null);
  const [inviteCode, setInviteCode] = useState(() => location.pathname.match(/^\/invite\/([A-Za-z0-9_-]+)\/?$/)?.[1] ?? null);
  const [invitePreview, setInvitePreview] = useState<InvitePreview | null>(null);
  const [inviteLink, setInviteLink] = useState('');
  const [moderationTarget, setModerationTarget] = useState<Member | null>(null);
  const [restrictions, setRestrictions] = useState<Restriction[]>([]);
  const [dark, setDark] = useState(true);
  const [mobileNav, setMobileNav] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const initials = useMemo(() => (user?.displayName || user?.username || '?').slice(0, 1).toUpperCase(), [user]);

  const loadServers = useCallback(async () => {
    try {
      const rows = await api<Server[]>('/api/servers'); setServers(rows);
      if (rows.length && !server) setServer(rows[0]!);
    } catch { /* logged-out state is handled by /me */ }
  }, [server]);
  const loadChannels = useCallback(async (selected: Server) => {
    try {
      const rows = await api<Channel[]>(`/api/servers/${selected.id}/channels`);
      setChannels(rows); setChannel(rows[0] ?? null);
    } catch (e) { setError((e as Error).message); }
  }, []);
  const loadMessages = useCallback(async (selected: Channel) => {
    if (selected.kind !== 'text') { setMessages([]); return; }
    try { setMessages(await api<Message[]>(`/api/channels/${selected.id}/messages`)); }
    catch (e) { setError((e as Error).message); }
  }, []);

  useEffect(() => { api<{ user: User }>('/api/auth/me').then(({ user: current }) => setUser(current)).catch(() => setUser(null)); }, []);
  useEffect(() => {
    if (!inviteCode) return;
    api<InvitePreview>(`/api/invites/${encodeURIComponent(inviteCode)}`).then(setInvitePreview).catch((e) => setError((e as Error).message));
  }, [inviteCode]);
  useEffect(() => {
    if (!user || !inviteCode || !invitePreview) return;
    let cancelled = false;
    api<{ serverId: string }>(`/api/invites/${encodeURIComponent(inviteCode)}/accept`, { method: 'POST', body: '{}' }).then(async ({ serverId }) => {
      if (cancelled) return;
      const rows = await api<Server[]>('/api/servers');
      if (cancelled) return;
      setServers(rows);
      const joined = rows.find((row) => row.id === serverId) ?? invitePreview;
      setServer(joined);
      setNotice(`Du bist ${invitePreview.name} beigetreten.`);
      setError('');
      setInviteCode(null);
      history.replaceState({}, '', '/');
    }).catch((e) => { if (!cancelled) setError((e as Error).message); });
    return () => { cancelled = true; };
  }, [user, inviteCode, invitePreview]);
  useEffect(() => { if (user) void loadServers(); }, [user, loadServers]);
  useEffect(() => { if (server) void loadChannels(server); }, [server, loadChannels]);
  useEffect(() => {
    if (!server) { setMembers([]); setMemberCount(0); return; }
    Promise.all([api<Member[]>(`/api/servers/${server.id}/members`), api<{ memberCount: number }>(`/api/servers/${server.id}/summary`)]).then(([list, summary]) => {
      setMembers(list); setMemberCount(summary.memberCount);
    }).catch((e) => setError((e as Error).message));
  }, [server]);
  useEffect(() => { if (channel) void loadMessages(channel); else setMessages([]); }, [channel, loadMessages]);
  useEffect(() => {
    if (!channel || channel.kind !== 'text') return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}/api/realtime/${channel.id}`);
    socket.onmessage = (event) => {
      const payload = JSON.parse(event.data) as { type: string; message: Message };
      if (payload.type === 'message:new') setMessages((current) => current.some((m) => m.id === payload.message.id) ? current : [...current, payload.message]);
    };
    socket.onclose = (event) => { if (event.code === 1008) setError('Echtzeitverbindung nicht autorisiert. Bitte erneut anmelden.'); };
    return () => socket.close();
  }, [channel]);
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }); }, [messages]);

  async function handleAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setBusy(true);
    const form = new FormData(event.currentTarget);
    const payload = Object.fromEntries(form.entries());
    try {
      const result = await api<{ user: User }>(`/api/auth/${authMode === 'register' ? 'register' : 'login'}`, { method: 'POST', body: JSON.stringify(payload) });
      setUser(result.user);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function logout() {
    await api('/api/auth/logout', { method: 'POST' });
    setUser(null); setServers([]); setServer(null); setChannel(null); setMessages([]);
  }
  async function createServer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    const data = new FormData(event.currentTarget);
    try { const created = await api<Server>('/api/servers', { method: 'POST', body: JSON.stringify({ name: data.get('name'), description: data.get('description') }) }); setServers((s) => [created, ...s]); setServer(created); setModal(null); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function createChannel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!server) return; setBusy(true); setError('');
    const data = new FormData(event.currentTarget);
    try { const created = await api<Channel>(`/api/servers/${server.id}/channels`, { method: 'POST', body: JSON.stringify({ name: data.get('name'), kind: data.get('kind') }) }); setChannels((c) => [...c, created]); setChannel(created); setModal(null); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function createInvite() {
    if (!server) return;
    setBusy(true); setError('');
    try {
      const invite = await api<{ code: string }>(`/api/servers/${server.id}/invitations`, { method: 'POST', body: JSON.stringify({ expiresInHours: 168, maxUses: null }) });
      setInviteLink(`${location.origin}/invite/${invite.code}`);
      setModal('invite');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function moderateMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!server || !moderationTarget) return;
    const data = new FormData(event.currentTarget);
    const action = String(data.get('action'));
    setBusy(true); setError('');
    try {
      await api(`/api/servers/${server.id}/members/${moderationTarget.id}/moderation`, { method: 'POST', body: JSON.stringify({ action, reason: data.get('reason'), ...(action === 'timeout' ? { durationMinutes: Number(data.get('durationMinutes')) } : {}) }) });
      if (action === 'kick' || action === 'ban') {
        const [list, summary] = await Promise.all([api<Member[]>(`/api/servers/${server.id}/members`), api<{ memberCount: number }>(`/api/servers/${server.id}/summary`)]);
        setMembers(list); setMemberCount(summary.memberCount);
      }
      setNotice(`${moderationTarget.displayName}: ${action} ausgeführt.`);
      setModal(null); setModerationTarget(null);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function liftRestriction(target: Restriction) {
    if (!server) return;
    try {
      await api(`/api/servers/${server.id}/members/${target.userId}/moderation`, { method: 'POST', body: JSON.stringify({ action: target.kind === 'ban' ? 'unban' : 'untimeout', reason: 'Maßnahme durch Moderation aufgehoben' }) });
      setRestrictions((current) => current.filter((item) => !(item.userId === target.userId && item.kind === target.kind)));
      if (target.kind === 'ban') {
        const [list, summary] = await Promise.all([api<Member[]>(`/api/servers/${server.id}/members`), api<{ memberCount: number }>(`/api/servers/${server.id}/summary`)]);
        setMembers(list); setMemberCount(summary.memberCount);
      }
      setNotice(`Maßnahme für ${target.displayName} aufgehoben.`);
    } catch (e) { setError((e as Error).message); }
  }
  async function createRole(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!server) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const permissions = Array.from(form.querySelectorAll<HTMLInputElement>('input[name="permissions"]:checked')).map((item) => item.value);
    setBusy(true); setError('');
    try {
      const role = await api<{ id: string }>(`/api/servers/${server.id}/roles`, { method: 'POST', body: JSON.stringify({ name: data.get('name'), permissions }) });
      const memberId = String(data.get('memberId'));
      await api(`/api/servers/${server.id}/members/${memberId}/roles/${role.id}`, { method: 'PUT', body: '{}' });
      setNotice(`Rolle „${String(data.get('name'))}“ erstellt und vergeben.`);
      setModal(null);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!channel || !message.trim()) return;
    const content = message.trim(); setMessage('');
    try {
      const created = await api<Message>(`/api/channels/${channel.id}/messages`, { method: 'POST', body: JSON.stringify({ content }) });
      setMessages((current) => current.some((m) => m.id === created.id) ? current : [...current, created]);
    } catch (e) { setMessage(content); setError((e as Error).message); }
  }

  if (!user) return <main className="auth-shell"><div className="auth-art"><div className="brand-mark large">✳</div><span className="eyebrow">EIN ORT FÜR DEINE COMMUNITY</span><h1>Zusammen<br /><em>ohne Umwege.</em></h1><p>Ein eigener Ort für Gespräche, Spielrunden und gemeinsame Ideen.</p><div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" /><div className="art-glow" /><div className="art-caption">DEINE COMMUNITY. DEINE REGELN.</div></div><section className="auth-panel"><div className="auth-box"><div className="brand-lockup"><div className="brand-mark">✳</div><span>Connect Together</span></div>{invitePreview && <div className="invite-preview"><span className="eyebrow">DU BIST EINGELADEN</span><b>{invitePreview.name}</b><p>{invitePreview.description || 'Ein Ort für eure Community.'}</p><small>Nach der Anmeldung trittst du der Community automatisch bei.</small></div>}<div className="auth-heading"><span className="eyebrow">WILLKOMMEN ZURÜCK</span><h2>{authMode === 'login' ? 'Schön, dass du da bist.' : 'Dein Platz ist hier.'}</h2><p>{authMode === 'login' ? 'Melde dich an und mach dort weiter, wo du aufgehört hast.' : 'Erstelle dein Konto und bring deine Leute zusammen.'}</p></div><form onSubmit={handleAuth} className="auth-form">{authMode === 'register' && <><label>Benutzername<input name="username" autoComplete="username" placeholder="z. B. alex_42" required minLength={3} maxLength={32} /></label><label>Anzeigename<input name="displayName" placeholder="Wie sollen wir dich nennen?" required maxLength={64} /></label></>}<label>E-Mail-Adresse<input name="email" type="email" autoComplete="email" placeholder="du@beispiel.de" required /></label><label>Passwort<input name="password" type="password" autoComplete={authMode === 'login' ? 'current-password' : 'new-password'} placeholder="Mindestens 12 Zeichen" required minLength={authMode === 'register' ? 12 : 1} /></label>{error && <div className="notice error">{error}</div>}<button className="primary-button" disabled={busy}>{busy ? 'Einen Moment …' : authMode === 'login' ? 'Anmelden' : 'Konto erstellen'}<span>↗</span></button></form><div className="auth-switch">{authMode === 'login' ? 'Noch kein Konto?' : 'Schon dabei?'} <button onClick={() => { setAuthMode(authMode === 'login' ? 'register' : 'login'); setError(''); }}>{authMode === 'login' ? 'Konto erstellen' : 'Anmelden'}</button></div><div className="auth-foot"><span>● HttpOnly-Session</span><span>Ein Ort, der euch verbindet.</span></div></div></section></main>;

  return <main className={`app-shell ${dark ? 'theme-dark' : 'theme-light'}`}>
    <nav className="server-rail"><button className="rail-logo" title="Connect Together">✳</button><div className="rail-divider" /><button className="rail-home" title="Direktnachrichten">⌂</button><div className="rail-divider" />{servers.map((item) => <button key={item.id} className={`server-icon ${server?.id === item.id ? 'selected' : ''}`} title={item.name} onClick={() => { setServer(item); setMobileNav(false); }}>{item.name.slice(0, 1).toUpperCase()}</button>)}<button className="server-add" title="Community erstellen" onClick={() => setModal('server')}>＋</button><div className="rail-bottom"><span className="rail-dot" title="Community-Plattform" /></div></nav>
    <aside className={`channel-sidebar ${mobileNav ? 'mobile-open' : ''}`}><header className="side-header"><div><span className="eyebrow">DEIN RAUM</span><h2>{server?.name ?? 'Deine Community'}</h2></div><button className="icon-button" title="Server erstellen" onClick={() => setModal('server')}>＋</button></header><button className="invite-card" onClick={() => void createInvite()} disabled={!server || busy}><span className="invite-icon">↗</span><span><b>Leute einladen</b><small>{server ? 'Einladung mit Ablauf in 7 Tagen' : 'Erstelle zuerst eine Community'}</small></span></button><div className="side-section"><div className="section-label"><span>KANÄLE</span><button onClick={() => setModal('channel')} title="Kanal erstellen">＋</button></div>{channels.map((item) => <button key={item.id} className={`channel-item ${channel?.id === item.id ? 'active' : ''}`} onClick={() => { setChannel(item); setMobileNav(false); }}><span className="hash">#</span>{item.name}</button>)}{server && <button className="channel-create" onClick={() => setModal('channel')}>＋ Kanal hinzufügen</button>}</div><div className="sidebar-note"><span className="note-spark">✳</span><div><b>Ein guter Ort, um anzukommen.</b><p>Fang ein Gespräch an – der Rest ergibt sich.</p></div></div><div className="user-card"><div className="avatar">{initials}<i /></div><div className="user-meta"><b>{user.displayName}</b><span>@{user.username}</span></div><button className="user-action" title="Abmelden" onClick={logout}>↪</button><button className="user-action" title="Darstellung wechseln" onClick={() => setDark((v) => !v)}>{dark ? '☼' : '☾'}</button></div></aside>
    <section className="chat-area"><header className="topbar"><button className="mobile-menu" aria-label="Serverkanäle öffnen" onClick={() => setMobileNav((v) => !v)}>☰</button><div className="mobile-brand"><span className="brand-mark">✳</span> Connect Together</div><div className="crumb"><span className="hash">#</span><b>{channel?.name ?? 'Willkommen'}</b></div><div className="top-actions"><span className="secure-label"><i /> Zugriff geprüft</span><button className="icon-button" title="Suche" onClick={() => setError('Die Suche wird in einer späteren Ausbaustufe ergänzt.')}>⌕</button><button className="icon-button" title="Mitglieder" onClick={() => setError('Die Mitgliederliste ist rechts im Seitenbereich sichtbar.')}>♙</button></div></header>
      {error && <div className="inline-error">{error}<button onClick={() => setError('')}>×</button></div>}{notice && <div className="inline-notice">{notice}<button onClick={() => setNotice('')}>×</button></div>}
      {!server ? <div className="empty-state"><div className="empty-icon">✳</div><span className="eyebrow">DEIN NÄCHSTER SCHRITT</span><h2>Mach es zu eurem Ort.</h2><p>Erstelle einen Community-Raum und lade deine Leute ein, miteinander ins Gespräch zu kommen.</p><button className="primary-button compact" onClick={() => setModal('server')}>Community erstellen <span>↗</span></button></div> : !channel ? <div className="empty-state"><div className="empty-icon">#</div><h2>Ein Kanal für den Anfang.</h2><p>Lege einen Textkanal an, um das Gespräch zu starten.</p><button className="primary-button compact" onClick={() => setModal('channel')}>Kanal erstellen <span>↗</span></button></div> : channel.kind === 'voice' ? <Suspense fallback={<div className="voice-stage">Voice wird geladen …</div>}><VoicePanel channel={channel} /></Suspense> : <><div className="welcome-banner"><div className="welcome-icon">#</div><span className="eyebrow">DU BIST IN {server.name.toUpperCase()}</span><h1>Willkommen bei <em>#{channel.name}</em></h1><p>Hier beginnt euer Gespräch. Sag Hallo und mach den Raum zu eurem.</p><div className="welcome-rule" /></div><div className="message-list" ref={listRef}>{messages.length === 0 ? <div className="first-message"><div className="first-line" /><span>Das ist der Anfang von <b>#{channel.name}</b>.</span><small>Schreib die erste Nachricht und eröffne das Gespräch.</small></div> : messages.map((item) => <article className="message" key={item.id}><div className="message-avatar">{item.displayName.slice(0, 1).toUpperCase()}</div><div className="message-body"><div className="message-meta"><b>{item.displayName}</b><span>@{item.username}</span><time>{new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><p>{item.content}</p></div></article>)}</div><form className="composer" onSubmit={sendMessage}><button type="button" className="composer-plus" title="Weitere Optionen" onClick={() => setError('Dateianhänge sind noch nicht implementiert.')}>＋</button><input value={message} onChange={(e) => setMessage(e.target.value)} maxLength={4000} placeholder={`Nachricht an #${channel.name}`} aria-label="Nachricht" /><button className="send-button" disabled={!message.trim()} aria-label="Nachricht senden">↑</button></form><div className="composer-hint">Drücke <kbd>Enter</kbd> zum Senden <span>•</span> Sei freundlich zueinander</div></>}
    </section><aside className="right-sidebar"><div className="right-heading"><span className="eyebrow">COMMUNITY</span><button className="icon-button" title="Rollen verwalten" onClick={() => setModal('role')}>⚙</button></div>{server ? <><div className="community-card"><div className="community-cover"><div className="cover-orb" /><span>✳</span></div><div className="community-avatar">{server.name.slice(0, 1).toUpperCase()}</div><h3>{server.name}</h3><p>{server.description || 'Ein Ort für eure Community.'}</p><div className="community-stats"><div><b>{memberCount}</b><span>MITGLIEDER</span></div><div><b>{channels.length}</b><span>KANÄLE</span></div></div></div><div className="member-heading">MITGLIEDER <span>{memberCount}</span></div><div className="member-list">{members.slice(0, 12).map((member) => <button type="button" className="member-row member-action" key={member.id} title={`Moderation für ${member.displayName}`} onClick={() => { setModerationTarget(member); setRestrictions([]); setModal('moderation'); if (server) void api<Restriction[]>(`/api/servers/${server.id}/restrictions`).then(setRestrictions).catch((e) => setError((e as Error).message)); }}><div className="member-avatar">{member.displayName.slice(0, 1).toUpperCase()}</div><div><b>{member.displayName}</b><span>@{member.username}</span></div><span className="member-menu">···</span></button>)}{memberCount > 12 && <small className="member-more">und {memberCount - 12} weitere</small>}</div><div className="right-callout"><span>✦</span><b>Zusammen macht’s mehr Spaß.</b><p>Lade Menschen ein, die diesen Raum mit Leben füllen.</p><button onClick={() => void createInvite()} disabled={busy}>Einladung erstellen <span>↗</span></button></div><div className="right-footer"><span>CONNECT TOGETHER · EARLY ACCESS</span><span>Gebaut für Communities</span></div></> : <div className="right-empty"><span>✳</span><p>Deine Community<br />wird hier lebendig.</p></div>}</aside>
    {modal && (modal === 'server' || modal === 'channel') && <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setModal(null); }}><form className="modal-card" onSubmit={modal === 'server' ? createServer : createChannel}><button type="button" className="modal-close" onClick={() => setModal(null)}>×</button><div className="modal-mark">{modal === 'server' ? '✳' : '#'}</div><span className="eyebrow">{modal === 'server' ? 'NEUER RAUM' : 'NEUER KANAL'}</span><h2>{modal === 'server' ? 'Startet mit einem Namen.' : 'Worum geht’s hier?'}</h2><p>{modal === 'server' ? 'Ein klarer Name, ein gemeinsamer Ort. Den Rest könnt ihr später gestalten.' : 'Ein eigener Kanal hilft euch, Themen zusammenzuhalten.'}</p><label>{modal === 'server' ? 'Name deiner Community' : 'Kanalname'}<input name="name" autoFocus required minLength={2} maxLength={modal === 'server' ? 80 : 64} placeholder={modal === 'server' ? 'z. B. Nebula Club' : 'z. B. willkommen'} /></label>{modal === 'channel' && <label>Kanaltyp<select name="kind"><option value="text">Textkanal</option><option value="voice">Sprachkanal</option></select></label>}{modal === 'server' && <label>Kurze Beschreibung <input name="description" maxLength={240} placeholder="Worum geht es bei euch?" /></label>}{error && <div className="notice error">{error}</div>}<button className="primary-button" disabled={busy}>{busy ? 'Wird erstellt …' : modal === 'server' ? 'Community erstellen' : 'Kanal erstellen'}<span>↗</span></button></form></div>}
    {modal === 'invite' && <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setModal(null); }}><section className="modal-card"><button type="button" className="modal-close" onClick={() => setModal(null)}>×</button><div className="modal-mark">↗</div><span className="eyebrow">EINLADUNG BEREIT</span><h2>Teile den Link mit deinen Leuten.</h2><p>Der Link läuft in sieben Tagen ab. Du kannst ihn jederzeit widerrufen.{['localhost', '127.0.0.1'].includes(location.hostname) ? ' Die lokale Vorschau ist nur von diesem PC erreichbar; Freunde benötigen später einen öffentlichen Server.' : ''}</p><label>Einladungslink<input readOnly value={inviteLink} onFocus={(event) => event.currentTarget.select()} /></label><button className="primary-button" onClick={() => void navigator.clipboard.writeText(inviteLink).then(() => setNotice('Einladungslink kopiert.')).catch(() => setError('Kopieren nicht möglich. Bitte markiere den Link und kopiere ihn.'))}>Link kopieren <span>↗</span></button></section></div>}
    {modal === 'moderation' && moderationTarget && <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setModal(null); }}><form className="modal-card" onSubmit={moderateMember}><button type="button" className="modal-close" onClick={() => setModal(null)}>×</button><div className="modal-mark">⚑</div><span className="eyebrow">COMMUNITY-MODERATION</span><h2>{moderationTarget.displayName}</h2><p>Wähle eine Aktion. Sie wird mit Grund und Zeitpunkt im Moderationsprotokoll gespeichert.</p>{restrictions.filter((item) => item.userId === moderationTarget.id).length > 0 && <div className="active-restrictions"><b>Aktive Maßnahmen</b>{restrictions.filter((item) => item.userId === moderationTarget.id).map((item) => <div key={item.kind}><span>{item.kind === 'ban' ? 'Gesperrt' : 'Auszeit'} · {item.reason || 'Kein Grund angegeben'}</span><button type="button" onClick={() => void liftRestriction(item)}>Aufheben</button></div>)}</div>}<label>Aktion<select name="action"><option value="timeout">Auszeit</option><option value="untimeout">Auszeit aufheben</option><option value="kick">Aus Community entfernen</option><option value="ban">Dauerhaft sperren</option></select></label><label>Dauer der Auszeit<select name="durationMinutes"><option value="10">10 Minuten</option><option value="60" selected>1 Stunde</option><option value="1440">24 Stunden</option><option value="10080">7 Tage</option></select></label><label>Grund (optional)<input name="reason" maxLength={500} placeholder="Regelverstoß oder Kontext" /></label>{error && <div className="notice error">{error}</div>}<button className="primary-button" disabled={busy}>{busy ? 'Wird ausgeführt …' : 'Aktion ausführen'}<span>↗</span></button></form></div>}
    {modal === 'role' && <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setModal(null); }}><form className="modal-card" onSubmit={createRole}><button type="button" className="modal-close" onClick={() => setModal(null)}>×</button><div className="modal-mark">♙</div><span className="eyebrow">ROLLEN & BERECHTIGUNGEN</span><h2>Eine Rolle vergeben.</h2><p>Rechte werden bei jeder Aktion serverseitig geprüft. Nur Mitglieder mit Verwaltungsrecht dürfen Rollen erstellen.</p><label>Rollenname<input name="name" required minLength={2} maxLength={48} placeholder="z. B. Moderation" /></label><label>Mitglied<select name="memberId" required>{members.map((member) => <option value={member.id} key={member.id}>{member.displayName} (@{member.username})</option>)}</select></label><fieldset className="permission-list"><legend>Berechtigungen</legend>{[['manage_invites', 'Einladungen verwalten'], ['moderate_members', 'Mitglieder moderieren'], ['manage_channels', 'Kanäle verwalten'], ['manage_roles', 'Rollen verwalten'], ['view_audit_log', 'Moderationsprotokoll ansehen']].map(([key, label]) => <label key={key}><input type="checkbox" name="permissions" value={key} />{label}</label>)}</fieldset>{error && <div className="notice error">{error}</div>}<button className="primary-button" disabled={busy || members.length === 0}>{busy ? 'Wird gespeichert …' : 'Rolle erstellen und vergeben'}<span>↗</span></button></form></div>}
  </main>;
}

export default App;
