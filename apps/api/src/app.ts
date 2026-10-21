import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import argon2 from 'argon2';
import { and, count, desc, eq, gt, lt } from 'drizzle-orm';
import { z } from 'zod';
import { db } from './db/index.js';
import { channels, messages, serverMembers, servers, sessions, users } from './db/schema.js';
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
    if (!await ownerOf(serverId, user.id)) return reply.code(403).send({ error: 'Nur die Serverinhaberin oder der Serverinhaber kann Kanäle erstellen.' });
    const parsed = z.object({ name: channelNameSchema }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Kanalnamen dürfen Buchstaben, Zahlen, Bindestriche und Unterstriche enthalten.' });
    const [created] = await db.insert(channels).values({ serverId, name: parsed.data.name }).returning({ id: channels.id, name: channels.name, kind: channels.kind });
    return reply.code(201).send(created);
  });
  app.get('/api/channels/:channelId/messages', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return reply;
    const { channelId } = request.params as { channelId: string };
    const [channel] = await db.select({ id: channels.id, serverId: channels.serverId }).from(channels).where(eq(channels.id, channelId)).limit(1);
    if (!channel || !await memberOf(channel.serverId, user.id)) return reply.code(404).send({ error: 'Kanal nicht gefunden.' });
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
    const [channel] = await db.select({ id: channels.id, serverId: channels.serverId }).from(channels).where(eq(channels.id, channelId)).limit(1);
    if (!channel || !await memberOf(channel.serverId, user.id)) return reply.code(404).send({ error: 'Kanal nicht gefunden.' });
    const parsed = z.object({ content: messageSchema }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Nachrichten müssen 1 bis 4000 Zeichen enthalten.' });
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
    const [channel] = await db.select({ serverId: channels.serverId }).from(channels).where(eq(channels.id, channelId)).limit(1);
    if (!user || !channel || !await memberOf(channel.serverId, user.id)) { socket.close(1008, 'Not authorized'); return; }
    (socket as any).channelId = channelId;
    (socket as any).userId = user.id;
    socket.on('error', (error: Error) => app.log.warn({ error }, 'WebSocket error'));
  });
  return app;
}
