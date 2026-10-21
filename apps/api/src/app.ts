import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { and, count, desc, eq, gt, isNull, lt, or } from 'drizzle-orm';
import { z } from 'zod';
import { db } from './db/index.js';
import { channels, invitations, memberRoles, messages, moderationActions, roles, rolePermissions, serverMembers, serverRestrictions, servers, sessions, users, type RolePermission } from './db/schema.js';
import { hashToken, newSessionToken } from './security.js';

const sessionCookie = 'sid';
const cookieOptions = { path: '/', httpOnly: true, sameSite: 'strict' as const, secure: process.env.COOKIE_SECURE === 'true' };
const usernameSchema = z.string().trim().toLowerCase().min(3).max(32).regex(/^[a-z0-9_]+$/);
const emailSchema = z.email().max(254);
const passSchema = z.string().min(12).max(128);
const serverNameSchema = z.string().trim().min(2).max(80);
const channelNameSchema = z.string().trim().min(2).max(64).regex(/^[a-zA-Z0-9_-]+$/);
const messageSchema = z.string().trim().min(1).max(4000);

export async function createApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
  const webOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:5173';
  await app.register(cookie);
  await app.register(cors, { origin: webOrigin, credentials: true });
  await app.register(rateLimit, { global: true, max: 120, timeWindow: '1 minute' });
  await app.register(websocket);

  app.addHook('onRequest', async (request, reply) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;
    const origin = request.headers.origin;
    if (origin !== webOrigin) return reply.code(403).send({ error: 'Ungültiger Anfrageursprung.' });
  });

  app.setErrorHandler((error, _request, reply) => {
    if ((error as { validation?: unknown }).validation) return reply.code(400).send({ error: 'Ungültige Eingabe.' });
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    if (statusCode === 429) return reply.code(429).send({ error: 'Zu viele Anfragen. Bitte warte kurz und versuche es erneut.' });
    if (statusCode >= 400 && statusCode < 500) return reply.code(statusCode).send({ error: 'Anfrage konnte nicht verarbeitet werden.' });
    app.log.error(error);
    return reply.code(500).send({ error: 'Interner Serverfehler.' });
  });

  const userForToken = async (rawToken?: string) => {
    if (!rawToken) return null;
    const [row] = await db.select({ id: users.id, username: users.username, displayName: users.displayName })
      .from(sessions).innerJoin(users, eq(sessions.userId, users.id))
      .where(and(eq(sessions.tokenHash, hashToken(rawToken)), gt(sessions.expiresAt, new Date()))).limit(1);
    return row ?? null;
  };
  const requireUser = async (request: { cookies: Record<string, string | undefined> }, reply: { code: (n: number) => { send: (body: unknown) => unknown } }) => {
    const user = await userForToken(request.cookies[sessionCookie]);
    if (!user) { reply.code(401).send({ error: 'Bitte melde dich an.' }); return null; }
    return user;
  };
  const memberOf = async (serverId: string, userId: string) => {
    const [member] = await db.select({ userId: serverMembers.userId }).from(serverMembers)
      .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId))).limit(1);
    return Boolean(member);
  };
  const ownerOf = async (serverId: string, userId: string) => {
    const [owner] = await db.select({ id: servers.id }).from(servers)
      .where(and(eq(servers.id, serverId), eq(servers.ownerId, userId))).limit(1);
    return Boolean(owner);
  };
  const permissionsFor = async (serverId: string, userId: string): Promise<Set<RolePermission>> => {
    if (await ownerOf(serverId, userId)) return new Set(rolePermissions);
    if (!await memberOf(serverId, userId)) return new Set();
    const assigned = await db.select({ roleId: memberRoles.roleId }).from(memberRoles)
      .where(and(eq(memberRoles.serverId, serverId), eq(memberRoles.userId, userId)));
    const assignedIds = new Set(assigned.map((role) => role.roleId));
    const grants = await db.select({ id: roles.id, isDefault: roles.isDefault, permissions: roles.permissions }).from(roles).where(eq(roles.serverId, serverId));
    return new Set(grants.filter((role) => role.isDefault || assignedIds.has(role.id)).flatMap((role) => role.permissions));
  };
  const hasPermission = async (serverId: string, userId: string, permission: RolePermission) => (await permissionsFor(serverId, userId)).has(permission);
  const activeRestriction = async (serverId: string, userId: string, kind: 'ban' | 'timeout') => {
    const [restriction] = await db.select().from(serverRestrictions)
      .where(and(eq(serverRestrictions.serverId, serverId), eq(serverRestrictions.userId, userId), eq(serverRestrictions.kind, kind))).limit(1);
    if (restriction?.expiresAt && restriction.expiresAt <= new Date()) {
      await db.delete(serverRestrictions).where(and(eq(serverRestrictions.serverId, serverId), eq(serverRestrictions.userId, userId), eq(serverRestrictions.kind, kind)));
      return null;
    }
    return restriction ?? null;
  };

  app.get('/api/health', async () => ({ ok: true }));
  app.post('/api/auth/register', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const parsed = z.object({ username: usernameSchema, displayName: z.string().trim().min(1).max(64), email: emailSchema, password: passSchema }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Bitte prüfe Benutzername, E-Mail und Passwort (mindestens 12 Zeichen).' });
    const { username, displayName, email, password } = parsed.data;
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email.toLowerCase())).limit(1);
    const [existingName] = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
    if (existing || existingName) return reply.code(409).send({ error: 'E-Mail oder Benutzername ist bereits vergeben.' });
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const [created] = await db.insert(users).values({ username, displayName, email: email.toLowerCase(), passwordHash }).returning({ id: users.id, username: users.username, displayName: users.displayName });
    const token = newSessionToken();
    await db.insert(sessions).values({ tokenHash: hashToken(token), userId: created!.id, expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) });
    reply.setCookie(sessionCookie, token, { ...cookieOptions, maxAge: 30 * 24 * 60 * 60 });
    return reply.code(201).send({ user: created });
  });

  app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const parsed = z.object({ email: emailSchema, password: z.string().min(1).max(128) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Bitte gib gültige Anmeldedaten ein.' });
    const [row] = await db.select().from(users).where(eq(users.email, parsed.data.email.toLowerCase())).limit(1);
    if (!row || !(await argon2.verify(row.passwordHash, parsed.data.password))) return reply.code(401).send({ error: 'E-Mail oder Passwort ist falsch.' });
    const token = newSessionToken();
    await db.insert(sessions).values({ tokenHash: hashToken(token), userId: row.id, expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) });
    reply.setCookie(sessionCookie, token, { ...cookieOptions, maxAge: 30 * 24 * 60 * 60 });
    return { user: { id: row.id, username: row.username, displayName: row.displayName } };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[sessionCookie];
    if (token) {
      const user = await userForToken(token);
      await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
      if (user) app.websocketServer.clients.forEach((client: any) => { if (client.userId === user.id) client.close(1008, 'Session ended'); });
    }
    reply.clearCookie(sessionCookie, cookieOptions);
    return { ok: true };
  });
  app.get('/api/auth/me', async (request, reply) => {
    const user = await requireUser(request, reply);
    return user ? { user } : reply;
  });

  app.get('/api/servers', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return reply;
    return db.select({ id: servers.id, name: servers.name, description: servers.description, createdAt: servers.createdAt })
      .from(serverMembers).innerJoin(servers, eq(serverMembers.serverId, servers.id)).where(eq(serverMembers.userId, user.id)).orderBy(desc(servers.createdAt));
  });
  app.post('/api/servers', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return reply;
    const parsed = z.object({ name: serverNameSchema, description: z.string().trim().max(240).default('') }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Servername muss 2 bis 80 Zeichen lang sein.' });
    const server = await db.transaction(async (tx) => {
      const [created] = await tx.insert(servers).values({ ...parsed.data, ownerId: user.id }).returning();
      await tx.insert(serverMembers).values({ serverId: created!.id, userId: user.id, isOwner: true });
      await tx.insert(roles).values({ serverId: created!.id, name: '@everyone', isDefault: true, permissions: [] });
      await tx.insert(channels).values({ serverId: created!.id, name: 'allgemein', kind: 'text' });
      return created!;
    });
    return reply.code(201).send(server);
  });
  app.get('/api/servers/:serverId/channels', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return reply;
    const { serverId } = request.params as { serverId: string };
    if (!await memberOf(serverId, user.id)) return reply.code(404).send({ error: 'Server nicht gefunden.' });
    return db.select({ id: channels.id, name: channels.name, kind: channels.kind }).from(channels).where(eq(channels.serverId, serverId)).orderBy(channels.createdAt);
  });
  app.get('/api/servers/:serverId/members', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return reply;
    const { serverId } = request.params as { serverId: string };
    if (!await memberOf(serverId, user.id)) return reply.code(404).send({ error: 'Server nicht gefunden.' });
    return db.select({ id: users.id, username: users.username, displayName: users.displayName })
      .from(serverMembers).innerJoin(users, eq(serverMembers.userId, users.id))
      .where(eq(serverMembers.serverId, serverId)).orderBy(users.displayName).limit(100);
  });
  app.get('/api/servers/:serverId/summary', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return reply;
    const { serverId } = request.params as { serverId: string };
    if (!await memberOf(serverId, user.id)) return reply.code(404).send({ error: 'Server nicht gefunden.' });
    const [summary] = await db.select({ memberCount: count() }).from(serverMembers).where(eq(serverMembers.serverId, serverId));
    return { memberCount: summary?.memberCount ?? 0 };
  });
  app.post('/api/servers/:serverId/channels', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return reply;
    const { serverId } = request.params as { serverId: string };
    if (!await memberOf(serverId, user.id)) return reply.code(404).send({ error: 'Server nicht gefunden.' });
    if (!await hasPermission(serverId, user.id, 'manage_channels')) return reply.code(403).send({ error: 'Dir fehlt die Berechtigung, Kanäle zu verwalten.' });
    const parsed = z.object({ name: channelNameSchema, kind: z.enum(['text', 'voice']).default('text') }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Kanalname oder Kanaltyp ist ungültig.' });
    const [created] = await db.insert(channels).values({ serverId, name: parsed.data.name, kind: parsed.data.kind }).returning({ id: channels.id, name: channels.name, kind: channels.kind });
    return reply.code(201).send(created);
  });
  app.post('/api/voice/:channelId/token', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return reply;
    const { channelId } = request.params as { channelId: string };
    const [channel] = await db.select({ id: channels.id, serverId: channels.serverId, kind: channels.kind }).from(channels).where(eq(channels.id, channelId)).limit(1);
    if (!channel || channel.kind !== 'voice' || !await memberOf(channel.serverId, user.id)) return reply.code(404).send({ error: 'Voice-Kanal nicht gefunden.' });
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    const internalUrl = process.env.LIVEKIT_SERVER_URL;
    const clientUrl = process.env.LIVEKIT_PUBLIC_URL;
    if (!apiKey || !apiSecret || !internalUrl || !clientUrl) return reply.code(503).send({ error: 'Voice ist auf diesem Server noch nicht konfiguriert.' });
    const timeout = await activeRestriction(channel.serverId, user.id, 'timeout');
    const roomName = `${channel.serverId}:${channel.id}`;
    const accessToken = new AccessToken(apiKey, apiSecret, { identity: user.id, name: user.displayName, ttl: '5m' });
    accessToken.addGrant({ roomJoin: true, room: roomName, canPublish: !timeout, canSubscribe: true, canPublishData: false });
    return { url: clientUrl, token: await accessToken.toJwt(), roomName, canPublish: !timeout };
  });

  app.get('/api/servers/:serverId/roles', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return reply;
    const { serverId } = request.params as { serverId: string };
    if (!await memberOf(serverId, user.id)) return reply.code(404).send({ error: 'Server nicht gefunden.' });
    return db.select({ id: roles.id, name: roles.name, permissions: roles.permissions, position: roles.position, isDefault: roles.isDefault }).from(roles).where(eq(roles.serverId, serverId)).orderBy(desc(roles.position));
  });
  app.post('/api/servers/:serverId/roles', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return reply;
    const { serverId } = request.params as { serverId: string };
    if (!await hasPermission(serverId, user.id, 'manage_roles')) return reply.code(403).send({ error: 'Dir fehlt die Berechtigung, Rollen zu verwalten.' });
    const parsed = z.object({ name: z.string().trim().min(2).max(48).regex(/^[\p{L}\p{N}_ -]+$/u), permissions: z.array(z.enum(['manage_invites', 'moderate_members', 'manage_channels', 'manage_roles', 'view_audit_log'])).max(5).default([]) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Ungültiger Rollenname oder Berechtigungen.' });
    const actorPermissions = await permissionsFor(serverId, user.id);
    if (parsed.data.permissions.some((permission) => !actorPermissions.has(permission))) return reply.code(403).send({ error: 'Du kannst nur Berechtigungen vergeben, die du selbst besitzt.' });
    const [created] = await db.insert(roles).values({ serverId, ...parsed.data, permissions: [...new Set(parsed.data.permissions)] }).returning({ id: roles.id, name: roles.name, permissions: roles.permissions, position: roles.position, isDefault: roles.isDefault });
    return reply.code(201).send(created);
  });
  app.put('/api/servers/:serverId/members/:targetId/roles/:roleId', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return reply;
    const { serverId, targetId, roleId } = request.params as { serverId: string; targetId: string; roleId: string };
    if (!await hasPermission(serverId, user.id, 'manage_roles')) return reply.code(403).send({ error: 'Dir fehlt die Berechtigung, Rollen zu verwalten.' });
    if (!await memberOf(serverId, targetId)) return reply.code(404).send({ error: 'Mitglied nicht gefunden.' });
    const [role] = await db.select({ id: roles.id, isDefault: roles.isDefault, permissions: roles.permissions }).from(roles).where(and(eq(roles.id, roleId), eq(roles.serverId, serverId))).limit(1);
    if (!role || role.isDefault) return reply.code(404).send({ error: 'Rolle nicht gefunden.' });
    const actorPermissions = await permissionsFor(serverId, user.id);
    if (role.permissions.some((permission) => !actorPermissions.has(permission))) return reply.code(403).send({ error: 'Du kannst nur Rollen mit deinen eigenen Berechtigungen vergeben.' });
    await db.insert(memberRoles).values({ serverId, userId: targetId, roleId }).onConflictDoNothing();
    return { ok: true };
  });
  app.delete('/api/servers/:serverId/members/:targetId/roles/:roleId', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return reply;
    const { serverId, targetId, roleId } = request.params as { serverId: string; targetId: string; roleId: string };
    if (!await hasPermission(serverId, user.id, 'manage_roles')) return reply.code(403).send({ error: 'Dir fehlt die Berechtigung, Rollen zu verwalten.' });
    const [role] = await db.select({ isDefault: roles.isDefault, permissions: roles.permissions }).from(roles).where(and(eq(roles.id, roleId), eq(roles.serverId, serverId))).limit(1);
    if (!role || role.isDefault) return reply.code(404).send({ error: 'Rolle nicht gefunden.' });
    const actorPermissions = await permissionsFor(serverId, user.id);
    if (role.permissions.some((permission) => !actorPermissions.has(permission))) return reply.code(403).send({ error: 'Du kannst keine Rollen mit Berechtigungen entfernen, die du nicht selbst besitzt.' });
    await db.delete(memberRoles).where(and(eq(memberRoles.serverId, serverId), eq(memberRoles.userId, targetId), eq(memberRoles.roleId, roleId)));
    return { ok: true };
  });

  app.get('/api/servers/:serverId/invitations', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return reply;
    const { serverId } = request.params as { serverId: string };
    if (!await hasPermission(serverId, user.id, 'manage_invites')) return reply.code(403).send({ error: 'Dir fehlt die Berechtigung, Einladungen zu verwalten.' });
    return db.select({ id: invitations.id, expiresAt: invitations.expiresAt, maxUses: invitations.maxUses, uses: invitations.uses, revokedAt: invitations.revokedAt, createdAt: invitations.createdAt }).from(invitations).where(eq(invitations.serverId, serverId)).orderBy(desc(invitations.createdAt));
  });
  app.post('/api/servers/:serverId/invitations', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return reply;
    const { serverId } = request.params as { serverId: string };
    if (!await hasPermission(serverId, user.id, 'manage_invites')) return reply.code(403).send({ error: 'Dir fehlt die Berechtigung, Einladungen zu verwalten.' });
    const parsed = z.object({ expiresInHours: z.number().int().min(1).max(720).nullable().default(168), maxUses: z.number().int().min(1).max(1000).nullable().default(null) }).safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Ungültiges Ablaufdatum oder Nutzungslimit.' });
    const code = randomBytes(32).toString('base64url');
    const expiresAt = parsed.data.expiresInHours === null ? null : new Date(Date.now() + parsed.data.expiresInHours * 60 * 60 * 1000);
    const [created] = await db.insert(invitations).values({ serverId, codeHash: hashToken(code), createdBy: user.id, expiresAt, maxUses: parsed.data.maxUses }).returning({ id: invitations.id });
    return reply.code(201).send({ id: created!.id, code, expiresAt, maxUses: parsed.data.maxUses });
  });
  app.delete('/api/invitations/:invitationId', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return reply;
    const { invitationId } = request.params as { invitationId: string };
    const [invite] = await db.select({ serverId: invitations.serverId }).from(invitations).where(eq(invitations.id, invitationId)).limit(1);
    if (!invite) return reply.code(404).send({ error: 'Einladung nicht gefunden.' });
    if (!await hasPermission(invite.serverId, user.id, 'manage_invites')) return reply.code(403).send({ error: 'Dir fehlt die Berechtigung, Einladungen zu verwalten.' });
    await db.update(invitations).set({ revokedAt: new Date() }).where(eq(invitations.id, invitationId));
    return { ok: true };
  });
  app.get('/api/invites/:code', async (request, reply) => {
    const { code } = request.params as { code: string };
    const [invite] = await db.select({ serverId: invitations.serverId, expiresAt: invitations.expiresAt, maxUses: invitations.maxUses, uses: invitations.uses, revokedAt: invitations.revokedAt }).from(invitations).where(eq(invitations.codeHash, hashToken(code))).limit(1);
    if (!invite || invite.revokedAt || (invite.expiresAt && invite.expiresAt <= new Date()) || (invite.maxUses !== null && invite.uses >= invite.maxUses)) return reply.code(404).send({ error: 'Diese Einladung ist ungültig oder abgelaufen.' });
    const [server] = await db.select({ id: servers.id, name: servers.name, description: servers.description }).from(servers).where(eq(servers.id, invite.serverId)).limit(1);
    return server ?? reply.code(404).send({ error: 'Community nicht gefunden.' });
  });
  app.post('/api/invites/:code/accept', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return reply;
    const { code } = request.params as { code: string };
    const result = await db.transaction(async (tx) => {
      const [invite] = await tx.select().from(invitations).where(eq(invitations.codeHash, hashToken(code))).for('update').limit(1);
      if (!invite || invite.revokedAt || (invite.expiresAt && invite.expiresAt <= new Date()) || (invite.maxUses !== null && invite.uses >= invite.maxUses)) return null;
      const [existing] = await tx.select({ userId: serverMembers.userId }).from(serverMembers).where(and(eq(serverMembers.serverId, invite.serverId), eq(serverMembers.userId, user.id))).limit(1);
      if (existing) return { serverId: invite.serverId, alreadyMember: true };
      const [ban] = await tx.select().from(serverRestrictions).where(and(eq(serverRestrictions.serverId, invite.serverId), eq(serverRestrictions.userId, user.id), eq(serverRestrictions.kind, 'ban'))).limit(1);
      if (ban && (!ban.expiresAt || ban.expiresAt > new Date())) return { banned: true as const };
      if (ban) await tx.delete(serverRestrictions).where(and(eq(serverRestrictions.serverId, invite.serverId), eq(serverRestrictions.userId, user.id), eq(serverRestrictions.kind, 'ban')));
      await tx.update(invitations).set({ uses: invite.uses + 1 }).where(eq(invitations.id, invite.id));
      await tx.insert(serverMembers).values({ serverId: invite.serverId, userId: user.id });
      return { serverId: invite.serverId, alreadyMember: false };
    });
    if (!result) return reply.code(404).send({ error: 'Diese Einladung ist ungültig, abgelaufen oder ausgeschöpft.' });
    if ('banned' in result) return reply.code(403).send({ error: 'Du bist aus dieser Community ausgeschlossen.' });
    return { ok: true, ...result };
  });

  app.post('/api/servers/:serverId/members/:targetId/moderation', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return reply;
    const { serverId, targetId } = request.params as { serverId: string; targetId: string };
    if (!await hasPermission(serverId, user.id, 'moderate_members')) return reply.code(403).send({ error: 'Dir fehlt die Berechtigung, Mitglieder zu moderieren.' });
    if (targetId === user.id) return reply.code(400).send({ error: 'Diese Moderationsaktion kann nicht auf dich selbst angewendet werden.' });
    const parsed = z.object({ action: z.enum(['kick', 'ban', 'timeout', 'untimeout', 'unban']), reason: z.string().trim().max(500).default(''), durationMinutes: z.number().int().min(1).max(40320).optional() }).safeParse(request.body);
    if (!parsed.success || (parsed.success && parsed.data.action === 'timeout' && !parsed.data.durationMinutes)) return reply.code(400).send({ error: 'Ungültige Moderationsaktion oder Dauer.' });
    if (parsed.data.action !== 'unban' && !await memberOf(serverId, targetId)) return reply.code(404).send({ error: 'Mitglied nicht gefunden.' });
    const [targetOwner] = await db.select({ id: servers.id }).from(servers).where(and(eq(servers.id, serverId), eq(servers.ownerId, targetId))).limit(1);
    if (targetOwner) return reply.code(403).send({ error: 'Die Serverinhaberin oder der Serverinhaber kann nicht moderiert werden.' });
    const expiresAt = parsed.data.action === 'timeout' ? new Date(Date.now() + parsed.data.durationMinutes! * 60_000) : null;
    await db.transaction(async (tx) => {
      if (parsed.data.action === 'ban' || parsed.data.action === 'timeout') {
        await tx.insert(serverRestrictions).values({ serverId, userId: targetId, kind: parsed.data.action, actorId: user.id, reason: parsed.data.reason, expiresAt })
          .onConflictDoUpdate({ target: [serverRestrictions.serverId, serverRestrictions.userId, serverRestrictions.kind], set: { actorId: user.id, reason: parsed.data.reason, expiresAt, createdAt: new Date() } });
      } else {
        const kind = parsed.data.action === 'untimeout' ? 'timeout' : 'ban';
        await tx.delete(serverRestrictions).where(and(eq(serverRestrictions.serverId, serverId), eq(serverRestrictions.userId, targetId), eq(serverRestrictions.kind, kind)));
      }
      await tx.insert(moderationActions).values({ serverId, actorId: user.id, targetId, action: parsed.data.action, reason: parsed.data.reason, expiresAt });
      if (parsed.data.action === 'kick' || parsed.data.action === 'ban') await tx.delete(serverMembers).where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, targetId)));
    });
    if (parsed.data.action === 'kick' || parsed.data.action === 'ban') app.websocketServer.clients.forEach((client: any) => { if (client.userId === targetId && client.serverId === serverId) client.close(1008, 'Membership removed'); });
    if ((parsed.data.action === 'kick' || parsed.data.action === 'ban') && process.env.LIVEKIT_SERVER_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET) {
      const voiceChannels = await db.select({ id: channels.id }).from(channels).where(and(eq(channels.serverId, serverId), eq(channels.kind, 'voice')));
      const livekit = new RoomServiceClient(process.env.LIVEKIT_SERVER_URL, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
      const removals = await Promise.allSettled(voiceChannels.map((voiceChannel) => livekit.removeParticipant(`${serverId}:${voiceChannel.id}`, targetId)));
      removals.filter((result) => result.status === 'rejected').forEach((result) => app.log.warn({ error: result.reason }, 'Could not immediately remove moderated member from LiveKit room'));
    }
    if ((parsed.data.action === 'timeout' || parsed.data.action === 'untimeout') && process.env.LIVEKIT_SERVER_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET) {
      const voiceChannels = await db.select({ id: channels.id }).from(channels).where(and(eq(channels.serverId, serverId), eq(channels.kind, 'voice')));
      const livekit = new RoomServiceClient(process.env.LIVEKIT_SERVER_URL, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
      const updates = await Promise.allSettled(voiceChannels.map((voiceChannel) => livekit.updateParticipant(`${serverId}:${voiceChannel.id}`, targetId, undefined, { canPublish: parsed.data.action === 'untimeout', canSubscribe: true })));
      updates.filter((result) => result.status === 'rejected').forEach((result) => app.log.debug({ error: result.reason }, 'Participant is not currently connected to LiveKit room'));
    }
    return { ok: true, action: parsed.data.action, expiresAt };
  });
  app.get('/api/servers/:serverId/moderation-actions', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return reply;
    const { serverId } = request.params as { serverId: string };
    if (!await hasPermission(serverId, user.id, 'view_audit_log')) return reply.code(403).send({ error: 'Dir fehlt die Berechtigung, das Moderationsprotokoll einzusehen.' });
    return db.select({ id: moderationActions.id, action: moderationActions.action, reason: moderationActions.reason, expiresAt: moderationActions.expiresAt, createdAt: moderationActions.createdAt, actorId: moderationActions.actorId, actorName: users.displayName, targetId: moderationActions.targetId })
      .from(moderationActions).innerJoin(users, eq(moderationActions.actorId, users.id)).where(eq(moderationActions.serverId, serverId)).orderBy(desc(moderationActions.createdAt)).limit(100);
  });
  app.get('/api/servers/:serverId/restrictions', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return reply;
    const { serverId } = request.params as { serverId: string };
    if (!await hasPermission(serverId, user.id, 'moderate_members')) return reply.code(403).send({ error: 'Dir fehlt die Berechtigung, aktive Maßnahmen zu verwalten.' });
    return db.select({ userId: serverRestrictions.userId, username: users.username, displayName: users.displayName, kind: serverRestrictions.kind, reason: serverRestrictions.reason, expiresAt: serverRestrictions.expiresAt })
      .from(serverRestrictions).innerJoin(users, eq(serverRestrictions.userId, users.id))
      .where(and(eq(serverRestrictions.serverId, serverId), or(isNull(serverRestrictions.expiresAt), gt(serverRestrictions.expiresAt, new Date()))))
      .orderBy(desc(serverRestrictions.createdAt));
  });
  app.get('/api/channels/:channelId/messages', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return reply;
    const { channelId } = request.params as { channelId: string };
    const [channel] = await db.select({ id: channels.id, serverId: channels.serverId, kind: channels.kind }).from(channels).where(eq(channels.id, channelId)).limit(1);
    if (!channel || channel.kind !== 'text' || !await memberOf(channel.serverId, user.id)) return reply.code(404).send({ error: 'Kanal nicht gefunden.' });
    const query = z.object({ before: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'Ungültige Pagination.' });
    const rows = await db.select({ id: messages.id, content: messages.content, createdAt: messages.createdAt, authorId: users.id, username: users.username, displayName: users.displayName })
      .from(messages).innerJoin(users, eq(messages.authorId, users.id))
      .where(query.data.before ? and(eq(messages.channelId, channelId), lt(messages.createdAt, new Date(query.data.before))) : eq(messages.channelId, channelId))
      .orderBy(desc(messages.createdAt)).limit(query.data.limit);
    return rows.reverse();
  });
  app.post('/api/channels/:channelId/messages', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return reply;
    const { channelId } = request.params as { channelId: string };
    const [channel] = await db.select({ id: channels.id, serverId: channels.serverId, kind: channels.kind }).from(channels).where(eq(channels.id, channelId)).limit(1);
    if (!channel || channel.kind !== 'text' || !await memberOf(channel.serverId, user.id)) return reply.code(404).send({ error: 'Kanal nicht gefunden.' });
    const parsed = z.object({ content: messageSchema }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Nachrichten müssen 1 bis 4000 Zeichen enthalten.' });
    const timeout = await activeRestriction(channel.serverId, user.id, 'timeout');
    if (timeout) return reply.code(403).send({ error: 'Du kannst während einer aktiven Auszeit keine Nachrichten senden.', until: timeout.expiresAt });
    const [created] = await db.insert(messages).values({ channelId, authorId: user.id, content: parsed.data.content }).returning();
    const message = { ...created!, authorId: user.id, username: user.username, displayName: user.displayName };
    app.websocketServer.clients.forEach((client: any) => {
      if (client.readyState === 1 && client.channelId === channelId) client.send(JSON.stringify({ type: 'message:new', message }));
    });
    return reply.code(201).send(message);
  });
  app.get('/api/realtime/:channelId', { websocket: true }, async (socket, request) => {
    const origin = request.headers.origin;
    if (origin !== webOrigin) { socket.close(1008, 'Invalid origin'); return; }
    const user = await userForToken(request.cookies[sessionCookie]);
    const { channelId } = request.params as { channelId: string };
    const [channel] = await db.select({ serverId: channels.serverId, kind: channels.kind }).from(channels).where(eq(channels.id, channelId)).limit(1);
    if (!user || !channel || channel.kind !== 'text' || !await memberOf(channel.serverId, user.id)) { socket.close(1008, 'Not authorized'); return; }
    (socket as any).channelId = channelId;
    (socket as any).userId = user.id;
    (socket as any).serverId = channel.serverId;
    socket.on('error', (error: Error) => app.log.warn({ error }, 'WebSocket error'));
  });
  return app;
}
