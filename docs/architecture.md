# Architektur, Modell und Ausbauplan

## Ziel

Connect Together soll eine eigenständige Plattform sein, kein Discord-Klon mit kopierten Markenassets. Der Produktgrundsatz ist: Community-Kernfunktionen bleiben ohne Pflichtabo zugänglich; bezahlte Infrastruktur und freiwillige Finanzierung dürfen keine Sicherheits- oder Moderationsfunktionen zur Geisel machen. Für jeden externen Dienst werden Kosten, Datenfluss und Self-hosting-Optionen vor Aktivierung geprüft.

## Architektur

```text
Browser (React + TypeScript + Vite)
       │ same-origin /api proxy, HttpOnly session cookie
       ├── REST ── Fastify ── Drizzle ── PostgreSQL
       └── WebSocket ────────────────┘

Ausbaustufen: Redis (Präsenz/pub-sub) · S3 API (Medien). LiveKit ist für Voice bereits in der isolierten lokalen Vorschau integriert.
```

Für den Einzelserver-MVP ist PostgreSQL die dauerhafte Quelle der Wahrheit. REST führt normale Änderungen aus; WebSocket überträgt Ereignisse nur an bereits autorisierte Verbindungen. Bei mehreren API-Instanzen wird Redis Pub/Sub oder ein vergleichbarer Adapter nötig. Redis ist keine zusätzliche Quelle für Nachrichteninhalte.

Der Web-Client kommuniziert lokal über den Vite-Proxy mit `/api`; dadurch bleiben Cookies same-origin. In Produktion soll ein Reverse Proxy Web-App und API unter einer Origin ausliefern. Verteilung von REST und WebSocket auf unterschiedliche Hosts erfordert eine bewusst konfigurierte CORS-, Cookie- und Origin-Policy.

## Verzeichnisstruktur

```text
apps/
  api/                 Fastify-Routen, Sicherheit, DB-Zugriff, Migrationen und API-Integrationstests
  web/                 React-Oberfläche
packages/
  shared/              später: gemeinsam genutzte Eingabeschemas und API-Verträge
docs/
  architecture.md
docker-compose.yml     lokale PostgreSQL-Entwicklung
.env.example           lokale Variablen ohne Geheimnisse
```

## Jetzt eingesetzte Pakete

- UI: React, TypeScript, Vite, `vite-plugin-pwa`.
- Desktop: Electron mit `contextIsolation`, Sandbox, isoliertem Preload und HTTPS-Serverbindung.
- API: Fastify, `@fastify/cookie`, `@fastify/cors`, `@fastify/rate-limit`, `@fastify/websocket`, Zod.
- Daten: PostgreSQL 17, `pg`, Drizzle ORM und Drizzle Kit.
- Sicherheit: Argon2id (`argon2`), SHA-256-Hash für zufällige Session-Token, HttpOnly/SameSite-Cookie, Origin-Prüfung für zustandsändernde HTTP-Anfragen, Berechtigungsprüfung für Kanal-/Nachrichtenabfragen.
- Voice: LiveKit SFU, `livekit-server-sdk` für kurzlebige serverseitige JWT-Grants und `livekit-client` für WebRTC-Audio.
- Qualität: TypeScript-Build und Vitest-Integrationstests.

TanStack Query und ein Router werden ergänzt, sobald die App mehr Seiten und Cache-Invalidierungen hat. Redis und Objektspeicher sind im MVP nicht nötig. Kein kostenpflichtiger Dienst ist aktiviert.

## Geplante Dienste

| Bedarf | Vorschlag | Zeitpunkt | Hinweis |
| --- | --- | --- | --- |
| Relationale Daten | PostgreSQL | MVP | Lokal in Compose; Produktionsbetrieb mit Backups und Migrationen |
| Präsenz und verteilte Events | Redis | Mehrere API-Instanzen | In-Memory-Präsenz nur für erste Einzelinstanz; keine Chat-Historie dort |
| Uploads | S3-kompatibler Speicher, lokal z. B. MinIO | nach Chat | Presigned URLs, Quoten, MIME-/Signaturprüfung, private Objekte |
| Voice/Video | LiveKit SFU | Voice-Grundlage integriert | lokale echte Audio-Übertragung in Compose; öffentlicher Betrieb benötigt TLS/WSS, TURN/UDP-Erreichbarkeit und ein produktives Secret-Setup |
| E-Mail | SMTP/API-Anbieter oder selbst betriebener Maildienst | Account-Recovery | erst nach Festlegung von Domain und Datenschutz-/Kostenrahmen |

LiveKit Cloud wird nicht automatisch aktiviert. Self-hosting und Cloud haben unterschiedliche Betriebs- und Kostenauswirkungen; vor einem kostenpflichtigen Dienst ist eine explizite Freigabe nötig.

## Datenmodell und Beziehungen

Der MVP hat bereits Fremdschlüssel mit Kaskaden oder Restrict-Regeln und Indizes für die häufigen Lookup-Pfade. Das vollständige Zielmodell wird in Migrationen schrittweise ergänzt:

| Tabelle | Schlüssel und Regeln | Zweck |
| --- | --- | --- |
| `users` | UUID PK; eindeutige normalisierte E-Mail und Username | Anmeldung und Identität; Löschung erst nach abhängigen/erhaltenen Daten |
| `user_profiles` | `user_id` PK/FK → users, cascade | Anzeigename, Avatar, Bio, Status und Einstellungen getrennt von Login-Daten |
| `sessions` | UUID PK; eindeutiger Token-Hash; FK user cascade; Index user/expiry | widerrufbare Sitzungen, ablaufende Tokens |
| `friendships` | UUID PK; zwei User-FKs; unique geordnetes User-Paar | Anfragezustand und Freundschaft, kein doppeltes Paar |
| `blocks` | composite PK (blocker, blocked); beide FKs → users | Blockierbeziehung; Selbstblock verhindern |
| `servers` | UUID PK; owner FK; Index nach Besitzer | Community-Metadaten |
| `server_members` | composite PK (server,user); beide FKs cascade | Mitgliedschaft; Ban/Timeout später über Moderation modellieren |
| `roles` | UUID PK; FK server cascade; unique (server,name) | Serverrollen samt Reihenfolge und Systemrolle |
| `permissions` | PK `key` | zentraler stabiler Berechtigungskatalog |
| `member_roles` | composite PK (server,user,role); zusammengesetzte FKs | Rollenzuweisungen nur innerhalb derselben Community |
| `categories` | UUID PK; FK server cascade; Index (server,position) | optionale Kanalgruppen |
| `channels` | UUID PK; FK server cascade; nullable category FK; Index (server,position) | Text, Voice, Ankündigungen und später Threads |
| `channel_overrides` | composite PK (channel, subject type, subject id, permission) | gezielte Rollen-/Mitgliederregeln; Allow/Deny mit dokumentierter Priorität |
| `messages` | UUID PK; FK channel cascade; author FK restrict; Index (channel,created_at,id) | dauerhaft gespeicherte Nachrichten mit Cursor-Pagination |
| `message_reactions` | composite unique (message,user,emoji); message cascade, user restrict | Reaktionen ohne Dubletten |
| `message_attachments` | UUID PK; FK message cascade; eindeutiger object key | Metadaten; Datei selbst im Objektspeicher |
| `read_states` | composite PK (user,channel); channel/user FKs | zuletzt gelesene Nachricht statt pro Nachricht Statuszeile |
| `invitations` | UUID PK; eindeutiger gehashter Token; FK server; Ablauf/Limit | Einladungen begrenzt und widerrufbar |
| `moderation_actions` | UUID PK; server, actor, target FK; Zeitindex | Kick, Timeout, Ban, Unban und Meldungsentscheidung |
| `notifications` | UUID PK; FK user cascade; Index (user,created_at) | Benachrichtigungszustand und gelesen-Status |
| `audit_logs` | UUID PK; FK server, actor; Index (server,created_at) | administrative Ereignisse, kein Klartextpasswort/Sessiontoken |

DMs werden später als eigenständige `conversations` und `conversation_members` modelliert, damit kein fiktiver Server oder Kanal Rechte umgeht. Rollenberechtigungen werden serverseitig berechnet; ein Client darf niemals eigene effektive Rechte behaupten. Rollenverwalter können nur Rechte vergeben oder Rollen verändern, deren Berechtigungen sie selbst besitzen, damit `manage_roles` nicht zur Rechteausweitung führt.

Datenschutz: E-Mail-Adressen nicht in öffentlichen Member-Endpunkten ausgeben. Logs enthalten keine Passwörter, Cookies oder Token. Für Kontolöschung müssen Profil, Sessions, DMs und Aufbewahrungspflichten getrennt geregelt sein; Audit-/Moderationsdaten benötigen einen dokumentierten minimalen Aufbewahrungszeitraum und können eine Anonymisierung statt Kaskadenlöschung erfordern.

## Sicherheit und Betriebsgrenzen

- Das MVP speichert niemals Klartextpasswörter. Sitzungs-Cookies sind HttpOnly und SameSite Strict; nur der Token-Hash landet in der Datenbank.
- REST- und WebSocket-Endpunkte prüfen Mitgliedschaft serverseitig. Nicht zugängliche Kanäle werden als nicht gefunden behandelt.
- Zustandsändernde HTTP-Routen und WebSocket-Upgrades prüfen den konfigurierten Origin. Auth-Routen haben strengere Rate-Limits.
- Der MVP hat noch keine E-Mail-Verifizierung, Passwortzurücksetzung, CSRF-Token-Rotation, Admin-Rollen, Upload-Schutz, Moderationsworkflow oder externe Penetrationstests. Er ist daher noch nicht für öffentliche Produktion freigegeben.
- WebSocket-Nachrichten werden aktuell als persistiertes Ereignis gesendet; bei mehreren API-Prozessen ist ein Pub/Sub-Bus erforderlich. Clients sollen auf Verbindungsabbruch neu verbinden und fehlende Nachrichten über REST nachladen.
- PostgreSQL-Zugangsdaten in Compose sind lokal und nicht produktiv. Produktion braucht TLS, `COOKIE_SECURE=true`, geheimen DB-Zugang, Secret-Management, Backups, Monitoring und Migrationsstrategie.

## Priorisierte Roadmap

1. **MVP-Grundlage (fertig):** Monorepo, Vite/React, Fastify, PostgreSQL, Drizzle, Session-Auth, Community, Textkanäle, gespeicherter Echtzeitchat und API-Integrationstests.
2. **Konten und Grundrechte (teilweise):** Rollen, Einladungen, Berechtigungsauflösung und Moderationsprotokoll sind integriert. Profilbearbeitung, E-Mail-Verifizierung/Recovery und vollständige Sessionverwaltung fehlen.
3. **Chatqualität:** Bearbeiten/Löschen, Antworten, Reaktionen, Pagination-Cursor, Erwähnungen, ungelesen-Zustände, Suche, sichere Markdown-Ausgabe und Meldungen.
4. **Community-Sicherheit (teilweise):** Kick, Timeout, Ban, Aufhebung und Protokoll sind integriert. Meldungswarteschlange, Blocklisten, feinere Kanalrechte und Abuse-Monitoring fehlen.
5. **Direktnachrichten und Benachrichtigungen:** Freundschaften, Blocks, Gruppenkonversationen, Datenschutz und Nutzerpräferenzen.
6. **Dateien:** S3-kompatible Uploads, Quoten, Malware-Prüfung, Content-Disposition und sichere Vorschauen.
7. **Voice/Video (teilweise):** LiveKit-SFU, kurzlebige serverseitige Voice-Tokens, Mikrofon-/Ausgabesteuerung und Push-to-Talk sind integriert. Video und Screensharing benötigen eigene Medien- und UI-Arbeit.
8. **Skalierung und Release:** Redis für Präsenz/Pub-Sub, Lasttests, Barrierefreiheit, CI, öffentliches Deployment, Observability, Backup-/Restore-Probe und Sicherheitsreview. Eine lokale Windows-Installer-Konfiguration und PWA sind vorhanden; der Installer muss noch gebaut und geprüft werden.

## Erstes klares Prüfkriterium

Phase 1 ist überprüfbar, wenn PostgreSQL startet, `npm run db:migrate` gelingt, `GET /api/health` `{ "ok": true }` liefert und `npm run build` sowie `npm test` erfolgreich sind. Der aktuelle lokale Stand erfüllt diese Prüfungen.
