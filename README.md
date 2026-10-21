# Huddle

Huddle ist eine eigenständige Community-Kommunikationsplattform. Der Fokus liegt auf einem kostenlosen Kern, klaren Regeln und serverseitiger Zugriffskontrolle. Dieses Repository enthält den ersten vertikalen MVP-Abschnitt: Konten, Communities, Textkanäle und gespeicherte Echtzeitnachrichten.

## Entwicklungsstand

Bereits umgesetzt:

- Registrierung und Anmeldung mit Argon2id-Passworthashes und datenbankgestützten Sessions.
- HttpOnly-, SameSite-Session-Cookie; Anfragen mit Zustandsänderungen werden auf ihren Origin geprüft.
- Communities erstellen und auflisten; beim Erstellen wird ein privater Mitglieder-Eintrag und der erste Textkanal angelegt.
- Textkanäle erstellen und auflisten. Im MVP darf das nur der Serverinhaber.
- Persistente Nachrichten, Verlauf mit limitierter Abfrage, WebSocket-Übertragung und Autorisierung für jeden REST- und WebSocket-Zugriff.
- Responsive React-Oberfläche mit dunklem Standardtheme, optional hellem Theme, Community-/Kanalnavigation und Mitgliederübersicht.
- Drizzle-Schema und Migration für die Tabellen `users`, `sessions`, `servers`, `server_members`, `channels` und `messages`.

Noch nicht implementiert: E-Mail-Verifizierung, Passwortzurücksetzung, Profilbearbeitung, Einladungen, Rollen, Moderation, Direktnachrichten, Freunde/Blocks, Suche, Benachrichtigungen, Uploads, Präsenz sowie Voice, Video und Bildschirmübertragung. Die sichtbaren Einladung-, Such- und Dateifunktionen weisen darauf hin, dass sie noch folgen; es gibt dafür keine simulierten Backend-Funktionen.

## Architektur und Roadmap

Der detaillierte Architekturvorschlag, die geplante Verzeichnisstruktur, das erweiterte Datenmodell, externe Dienste und priorisierte Ausbauphasen stehen in [docs/architecture.md](docs/architecture.md).

## Voraussetzungen

- Node.js 20.19+ (getestet mit Node.js 24.22.0) und npm.
- Docker Desktop mit Docker Compose für PostgreSQL 17.
- Git für Versionsverwaltung.

Im Workspace wurde Docker Desktop über `%LOCALAPPDATA%\Programs\DockerDesktop\resources\bin` gefunden. Wenn `docker` in PowerShell nicht im PATH ist, kannst du den Docker-Befehl zunächst mit diesem vollständigen Pfad ausführen oder das Docker-Desktop-Verzeichnis dem PATH hinzufügen.

## Start in PowerShell

Im Projektstammverzeichnis:

```powershell
npm install
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
docker compose up -d postgres
npm run db:migrate
npm run dev
```

Die Web-App ist unter `http://localhost:5173`, die API unter `http://localhost:3000` erreichbar. Der API-Health-Check ist `GET /api/health`.

Wenn die Docker-CLI nicht im PATH liegt:

```powershell
$dockerBin = "$env:LOCALAPPDATA\Programs\DockerDesktop\resources\bin"
$env:PATH = "$dockerBin;$env:PATH"
docker compose up -d postgres
```

Die Compose-Zugangsdaten sind ausschließlich lokale Entwicklungswerte. Vor einem Deployment müssen Datenbankzugang, TLS, `COOKIE_SECURE=true`, Origin, Rate-Limits, Geheimnisse, Backups und die Betriebsumgebung angepasst werden.

## Prüfen

```powershell
npm run build
npm test
```

`npm test` führt API-Integrationstests gegen PostgreSQL aus. Sie registrieren Testkonten, prüfen Anmeldung, Server/Kanäle, Speicherung und WebSocket-Empfang sowie die Ablehnung eines fremden Kontos und eines fremden Origins. Die Tests entfernen die erzeugten Testdaten.

## Lokal geprüfter Stand

- `npm run db:migrate` — erfolgreich gegen den lokalen PostgreSQL-17-Container.
- `npm run build` — Frontend und Backend erfolgreich gebaut.
- `npm test` — 2 Integrationstests bestanden; umfasst persistierte Nachrichten und WebSocket-Push.

## Sitzungen

Der Browser erhält ein kryptografisch zufälliges Session-Token als HttpOnly-Cookie. In PostgreSQL liegt nur dessen SHA-256-Hash; der Passwort-Hash nutzt Argon2id. Chatnachrichten werden derzeit serverseitig im Klartext in PostgreSQL gespeichert. Es gibt keine Ende-zu-Ende-Verschlüsselung; für den Produktivbetrieb sind TLS sowie Datenbank- und Backup-Schutz erforderlich. Der MVP setzt noch kein E-Mail-Verfahren zur Kontowiederherstellung um und ist noch nicht für den öffentlichen Produktivbetrieb freigegeben.
