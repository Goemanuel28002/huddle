import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';

type User = { id: string; username: string; displayName: string };
type Server = { id: string; name: string; description: string };
type Channel = { id: string; name: string; kind: string };
type Message = { id: string; content: string; createdAt: string; authorId: string; username: string; displayName: string };
type Member = { id: string; username: string; displayName: string };
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
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<'server' | 'channel' | null>(null);
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
    try { setMessages(await api<Message[]>(`/api/channels/${selected.id}/messages`)); }
    catch (e) { setError((e as Error).message); }
  }, []);

  useEffect(() => { api<{ user: User }>('/api/auth/me').then(({ user: current }) => setUser(current)).catch(() => setUser(null)); }, []);
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
    if (!channel) return;
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
    try { const created = await api<Channel>(`/api/servers/${server.id}/channels`, { method: 'POST', body: JSON.stringify({ name: data.get('name') }) }); setChannels((c) => [...c, created]); setChannel(created); setModal(null); }
    catch (e) { setError((e as Error).message); }
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

  if (!user) return <main className="auth-shell"><div className="auth-art"><div className="brand-mark large">✳</div><span className="eyebrow">EIN ORT FÜR DEINE COMMUNITY</span><h1>Zusammen<br /><em>ohne Umwege.</em></h1><p>Ein eigener Ort für Gespräche, Spielrunden und gemeinsame Ideen.</p><div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" /><div className="art-glow" /><div className="art-caption">DEINE COMMUNITY. DEINE REGELN.</div></div><section className="auth-panel"><div className="auth-box"><div className="brand-lockup"><div className="brand-mark">✳</div><span>Connect Together</span></div><div className="auth-heading"><span className="eyebrow">WILLKOMMEN ZURÜCK</span><h2>{authMode === 'login' ? 'Schön, dass du da bist.' : 'Dein Platz ist hier.'}</h2><p>{authMode === 'login' ? 'Melde dich an und mach dort weiter, wo du aufgehört hast.' : 'Erstelle dein Konto und bring deine Leute zusammen.'}</p></div><form onSubmit={handleAuth} className="auth-form">{authMode === 'register' && <><label>Benutzername<input name="username" autoComplete="username" placeholder="z. B. alex_42" required minLength={3} maxLength={32} /></label><label>Anzeigename<input name="displayName" placeholder="Wie sollen wir dich nennen?" required maxLength={64} /></label></>}<label>E-Mail-Adresse<input name="email" type="email" autoComplete="email" placeholder="du@beispiel.de" required /></label><label>Passwort<input name="password" type="password" autoComplete={authMode === 'login' ? 'current-password' : 'new-password'} placeholder="Mindestens 12 Zeichen" required minLength={authMode === 'register' ? 12 : 1} /></label>{error && <div className="notice error">{error}</div>}<button className="primary-button" disabled={busy}>{busy ? 'Einen Moment …' : authMode === 'login' ? 'Anmelden' : 'Konto erstellen'}<span>↗</span></button></form><div className="auth-switch">{authMode === 'login' ? 'Noch kein Konto?' : 'Schon dabei?'} <button onClick={() => { setAuthMode(authMode === 'login' ? 'register' : 'login'); setError(''); }}>{authMode === 'login' ? 'Konto erstellen' : 'Anmelden'}</button></div><div className="auth-foot"><span>● HttpOnly-Session</span><span>Einfach zusammen sein.</span></div></div></section></main>;

  return <main className={`app-shell ${dark ? 'theme-dark' : 'theme-light'}`}>
    <nav className="server-rail"><button className="rail-logo" title="Connect Together">✳</button><div className="rail-divider" /><button className="rail-home" title="Direktnachrichten">⌂</button><div className="rail-divider" />{servers.map((item) => <button key={item.id} className={`server-icon ${server?.id === item.id ? 'selected' : ''}`} title={item.name} onClick={() => { setServer(item); setMobileNav(false); }}>{item.name.slice(0, 1).toUpperCase()}</button>)}<button className="server-add" title="Community erstellen" onClick={() => setModal('server')}>＋</button><div className="rail-bottom"><span className="rail-dot" title="Community-Plattform" /></div></nav>
    <aside className={`channel-sidebar ${mobileNav ? 'mobile-open' : ''}`}><header className="side-header"><div><span className="eyebrow">DEIN RAUM</span><h2>{server?.name ?? 'Deine Community'}</h2></div><button className="icon-button" title="Server erstellen" onClick={() => setModal('server')}>＋</button></header><button className="invite-card" onClick={() => setError('Einladungslinks kommen in einer späteren Ausbaustufe.')}><span className="invite-icon">↗</span><span><b>Leute einladen</b><small>Bring deine Community zusammen</small></span></button><div className="side-section"><div className="section-label"><span>KANÄLE</span><button onClick={() => setModal('channel')} title="Kanal erstellen">＋</button></div>{channels.map((item) => <button key={item.id} className={`channel-item ${channel?.id === item.id ? 'active' : ''}`} onClick={() => { setChannel(item); setMobileNav(false); }}><span className="hash">#</span>{item.name}</button>)}{server && <button className="channel-create" onClick={() => setModal('channel')}>＋ Kanal hinzufügen</button>}</div><div className="sidebar-note"><span className="note-spark">✳</span><div><b>Ein guter Ort, um anzukommen.</b><p>Fang ein Gespräch an – der Rest ergibt sich.</p></div></div><div className="user-card"><div className="avatar">{initials}<i /></div><div className="user-meta"><b>{user.displayName}</b><span>@{user.username}</span></div><button className="user-action" title="Abmelden" onClick={logout}>↪</button><button className="user-action" title="Darstellung wechseln" onClick={() => setDark((v) => !v)}>{dark ? '☼' : '☾'}</button></div></aside>
    <section className="chat-area"><header className="topbar"><button className="mobile-menu" aria-label="Serverkanäle öffnen" onClick={() => setMobileNav((v) => !v)}>☰</button><div className="mobile-brand"><span className="brand-mark">✳</span> Connect Together</div><div className="crumb"><span className="hash">#</span><b>{channel?.name ?? 'Willkommen'}</b></div><div className="top-actions"><span className="secure-label"><i /> Zugriff geprüft</span><button className="icon-button" title="Suche" onClick={() => setError('Die Suche wird in einer späteren Ausbaustufe ergänzt.')}>⌕</button><button className="icon-button" title="Mitglieder" onClick={() => setError('Die Mitgliederliste ist rechts im Seitenbereich sichtbar.')}>♙</button></div></header>
      {error && <div className="inline-error">{error}<button onClick={() => setError('')}>×</button></div>}
      {!server ? <div className="empty-state"><div className="empty-icon">✳</div><span className="eyebrow">DEIN NÄCHSTER SCHRITT</span><h2>Mach es zu eurem Ort.</h2><p>Erstelle einen Community-Raum und lade deine Leute ein, miteinander ins Gespräch zu kommen.</p><button className="primary-button compact" onClick={() => setModal('server')}>Community erstellen <span>↗</span></button></div> : !channel ? <div className="empty-state"><div className="empty-icon">#</div><h2>Ein Kanal für den Anfang.</h2><p>Lege einen Textkanal an, um das Gespräch zu starten.</p><button className="primary-button compact" onClick={() => setModal('channel')}>Kanal erstellen <span>↗</span></button></div> : <><div className="welcome-banner"><div className="welcome-icon">#</div><span className="eyebrow">DU BIST IN {server.name.toUpperCase()}</span><h1>Willkommen bei <em>#{channel.name}</em></h1><p>Hier beginnt euer Gespräch. Sag Hallo und mach den Raum zu eurem.</p><div className="welcome-rule" /></div><div className="message-list" ref={listRef}>{messages.length === 0 ? <div className="first-message"><div className="first-line" /><span>Das ist der Anfang von <b>#{channel.name}</b>.</span><small>Schreib die erste Nachricht und eröffne das Gespräch.</small></div> : messages.map((item) => <article className="message" key={item.id}><div className="message-avatar">{item.displayName.slice(0, 1).toUpperCase()}</div><div className="message-body"><div className="message-meta"><b>{item.displayName}</b><span>@{item.username}</span><time>{new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><p>{item.content}</p></div></article>)}</div><form className="composer" onSubmit={sendMessage}><button type="button" className="composer-plus" title="Weitere Optionen" onClick={() => setError('Dateianhänge sind noch nicht implementiert.')}>＋</button><input value={message} onChange={(e) => setMessage(e.target.value)} maxLength={4000} placeholder={`Nachricht an #${channel.name}`} aria-label="Nachricht" /><button className="send-button" disabled={!message.trim()} aria-label="Nachricht senden">↑</button></form><div className="composer-hint">Drücke <kbd>Enter</kbd> zum Senden <span>•</span> Sei freundlich zueinander</div></>}
    </section><aside className="right-sidebar"><div className="right-heading"><span className="eyebrow">COMMUNITY</span><button className="icon-button" title="Weitere Optionen" onClick={() => setError('Servereinstellungen folgen in einer späteren Ausbaustufe.')}>···</button></div>{server ? <><div className="community-card"><div className="community-cover"><div className="cover-orb" /><span>✳</span></div><div className="community-avatar">{server.name.slice(0, 1).toUpperCase()}</div><h3>{server.name}</h3><p>{server.description || 'Ein Ort für eure Community.'}</p><div className="community-stats"><div><b>{memberCount}</b><span>MITGLIEDER</span></div><div><b>{channels.length}</b><span>KANÄLE</span></div></div></div><div className="member-heading">MITGLIEDER <span>{memberCount}</span></div><div className="member-list">{members.slice(0, 12).map((member) => <div className="member-row" key={member.id}><div className="member-avatar">{member.displayName.slice(0, 1).toUpperCase()}</div><div><b>{member.displayName}</b><span>@{member.username}</span></div></div>)}{memberCount > 12 && <small className="member-more">und {memberCount - 12} weitere</small>}</div><div className="right-callout"><span>✦</span><b>Zusammen macht’s mehr Spaß.</b><p>Lade Menschen ein, die diesen Raum mit Leben füllen.</p><button onClick={() => setError('Einladungslinks kommen in einer späteren Ausbaustufe.')}>Einladung erstellen <span>↗</span></button></div><div className="right-footer"><span>CONNECT TOGETHER · EARLY ACCESS</span><span>Gebaut für Communities</span></div></> : <div className="right-empty"><span>✳</span><p>Deine Community<br />wird hier lebendig.</p></div>}</aside>
    {modal && <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setModal(null); }}><form className="modal-card" onSubmit={modal === 'server' ? createServer : createChannel}><button type="button" className="modal-close" onClick={() => setModal(null)}>×</button><div className="modal-mark">{modal === 'server' ? '✳' : '#'}</div><span className="eyebrow">{modal === 'server' ? 'NEUER RAUM' : 'NEUER KANAL'}</span><h2>{modal === 'server' ? 'Startet mit einem Namen.' : 'Worum geht’s hier?'}</h2><p>{modal === 'server' ? 'Ein klarer Name, ein gemeinsamer Ort. Den Rest könnt ihr später gestalten.' : 'Ein eigener Kanal hilft euch, Themen zusammenzuhalten.'}</p><label>{modal === 'server' ? 'Name deiner Community' : 'Kanalname'}<input name="name" autoFocus required minLength={2} maxLength={modal === 'server' ? 80 : 64} placeholder={modal === 'server' ? 'z. B. Nebula Club' : 'z. B. willkommen'} /></label>{modal === 'server' && <label>Kurze Beschreibung <input name="description" maxLength={240} placeholder="Worum geht es bei euch?" /></label>}{error && <div className="notice error">{error}</div>}<button className="primary-button" disabled={busy}>{busy ? 'Wird erstellt …' : modal === 'server' ? 'Community erstellen' : 'Kanal erstellen'}<span>↗</span></button></form></div>}
  </main>;
}

export default App;
