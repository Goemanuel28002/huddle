# Connect Together

**Ein Ort, der euch verbindet.**

Connect Together ist eine eigenständige Community-Kommunikationsplattform mit Web-App und Windows-Desktop-Client. Der aktuelle Entwicklungsstand ist ein testbarer Community-MVP-Ausbau: Konten, Server, Einladungen, Rollen, Moderation, persistenter Textchat und echte Voice-Übertragung über LiveKit. Das Projekt ist noch kein öffentlicher, betreuter Dienst.

## Funktionsumfang

- Registrierung und Anmeldung mit Argon2id-Passworthashes und widerrufbaren Datenbank-Sessions.
- Server und Text-/Voice-Kanäle mit serverseitiger Mitgliedschaftsprüfung.
- Einladungen mit Ablaufzeit, Nutzungslimit und Widerruf; in der Datenbank wird nur der Token-Hash gespeichert.
- Rollen mit `manage_invites`, `moderate_members`, `manage_channels`, `manage_roles` und `view_audit_log`.
- Rollenverwalter können nur Rechte vergeben und Rollen ändern, deren Berechtigungen sie selbst besitzen.
- Kick, Ban, Timeout und Aufhebung mit Moderationsprotokoll; Timeout sperrt Textnachrichten und den Voice-Mikrofonversand.
- Persistente Textnachrichten, Verlauf, WebSocket-Push und Zugriffskontrolle.
- LiveKit-Sprachkanäle mit kurzlebigen serverseitig signierten Beitrittstokens, Mikrofon, Push-to-Talk, Geräteauswahl, Teilnehmer-/Sprachanzeige und Wiederverbindungsstatus.
- Installierbare Web-App (PWA) und Electron-Windows-Installer, der sich mit einer HTTPS-Instanz oder einem lokalen Server verbindet.

## Noch nicht enthalten

Video, Bildschirmfreigabe, Direktnachrichten, Freundschaften, E-Mail-Verifizierung/Wiederherstellung, vollständige Kanal-Overrides, Dateiuploads, globale Suche, Moderationsmeldungen und Mehrserver-Skalierung sind nicht implementiert. Voice-Video und eine öffentliche gehostete Instanz dürfen nicht als fertig beworben werden. Das PWA-App-Shell-Caching ermöglicht keinen Offline-Chat.

## Architektur

- React, TypeScript, Vite und `vite-plugin-pwa` für die Web-App.
- Electron mit isoliertem Preload für den Windows-Desktop-Client.
- Fastify REST API und WebSocket-Events, Zod-Eingabeprüfung.
- PostgreSQL 17 und Drizzle ORM/Migrationen.
- LiveKit SFU für echte WebRTC-Audiomedien; kein kostenpflichtiger Dienst ist aktiviert.
- Docker Compose für lokale Entwicklung und isolierte Vorschau.

Die ausführlichere Datenmodell- und Betriebsübersicht steht in [docs/architecture.md](docs/architecture.md).

## Voraussetzungen

- Node.js 20.19 oder neuer und npm.
- Docker Desktop mit Docker Compose.
- Für echten Voice-Betrieb: erreichbarer LiveKit-Endpunkt und freigegebene Medienports. In der lokalen Compose-Vorschau sind nur Entwicklungszugangsdaten eingerichtet.

## Lokal starten

In PowerShell im Repository-Verzeichnis:

```powershell
npm install
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
docker compose up -d postgres
npm run db:migrate
npm run dev
```

Web-App: `http://localhost:5173`; API: `http://localhost:3000`. Dieser Standardstack enthält noch keinen LiveKit-Server; Voice ist erst in der isolierten Vorschau aktiviert.

## Isolierte Docker-Vorschau

Diese Vorschau läuft unter `http://localhost:8081`, nutzt ein eigenes PostgreSQL-Volume und startet zusätzlich LiveKit. Sie greift nicht auf die Datenbank des Standard-Entwicklungsstacks zu.

```powershell
Copy-Item .env.preview.example .env.preview
$env:POSTGRES_PASSWORD = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLower()
(Get-Content .env.preview -Raw).Replace('replace-with-a-long-random-local-preview-password', $env:POSTGRES_PASSWORD) | Set-Content -Encoding ASCII .env.preview
$dockerBin = "$env:LOCALAPPDATA\Programs\DockerDesktop\resources\bin"
$env:PATH = "$dockerBin;$env:PATH"
docker compose --env-file .env.preview -f compose.preview.yml up --build -d
Invoke-RestMethod http://localhost:8081/api/health
```

Die Antwort muss `ok: true` enthalten. Öffne danach `http://localhost:8081`. Logs: `docker compose --env-file .env.preview -f compose.preview.yml logs -f`. Stoppen ohne Datenbank zu löschen: `docker compose --env-file .env.preview -f compose.preview.yml down`. Verwende kein `down -v`, wenn du die Vorschau-Daten behalten willst.

Die in Compose eingetragenen LiveKit-Schlüssel sind nur für diese Loopback-Vorschau gedacht. Für einen öffentlichen Dienst müssen sie ersetzt werden. LiveKit benötigt TLS/WSS und aus dem Internet erreichbare Medienports; die lokale Docker-Adresse funktioniert nicht als öffentliche Serverkonfiguration. Der aktuelle Vorschau-Stack bindet Ports `7880/tcp`, `7881/tcp` und `7882/udp`.

## Windows-App bauen

Im Repository-Stamm in PowerShell:

```powershell
npm install
npm run desktop:dist
```

Der NSIS-Installer wird unter `apps/desktop/release/` erzeugt. Beim ersten Start gibst du die HTTPS-Adresse einer bereits betriebenen Connect-Together-Instanz ein; für lokale Tests ist `http://localhost:8081` zulässig. Ohne öffentlich gehostetes Backend verbindet die veröffentlichte Installationsdatei noch keine Community. Der Installer ist nicht code-signiert und Windows kann deshalb einen SmartScreen-Hinweis anzeigen.

Die PWA kann aus dem Browser installiert werden, sobald die Web-App über HTTPS ausgeliefert wird (localhost ist für lokale Tests zugelassen).

## Build und Tests

```powershell
npm run build
npm test
npm --workspace web run test:e2e
```

Die API-Integrationstests benötigen die PostgreSQL-Datenbank aus `.env`; sie prüfen Registrierung/Login, Server- und Kanalerstellung, Echtzeitnachrichten, Einladungen, Rollen, Moderation und Berechtigungsgrenzen. Sie erzeugen und entfernen eigene Testkonten. Der letzte bestätigte lokale Build und Testlauf ist am 22.10.2026 erfolgt.

Der zusätzliche Voice-End-to-end-Test benötigt den laufenden isolierten Vorschau-Stack, Microsoft Edge und dessen lokale Datenbankverbindung auf `127.0.0.1:55432`. Er nutzt nur künstliche Mikrofone und löscht anschließend seine eigenen Testkonten und Community-Daten.

## Öffentlicher Betrieb

`compose.preview.yml` ist nur für die lokale Vorschau bestimmt. Eine öffentliche Instanz braucht einen gewählten Host, Domain und TLS, sichere Produktionsschlüssel, erreichbare LiveKit-Medienports, Backups, Monitoring, E-Mail-Infrastruktur und Datenschutz-/Moderationsprozesse. Noch wurde kein Hosting oder kostenpflichtiger externer Dienst aktiviert.

Der MVP speichert Nachrichten derzeit unverschlüsselt in PostgreSQL und bietet keine Ende-zu-Ende-Verschlüsselung. Vor einem öffentlichen Nutzerbetrieb sind ein vollständiger Sicherheits-, Datenschutz- und Betriebsreview erforderlich.
