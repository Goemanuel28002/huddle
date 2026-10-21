import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { createApp } from '../src/app.js';
import { db, pool } from '../src/db/index.js';
import { servers, users } from '../src/db/schema.js';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const origin = process.env.WEB_ORIGIN ?? 'http://localhost:5173';
const email = `mvp-${suffix}@example.test`;
const username = `mvp_${suffix}`;
let app: FastifyInstance;
let userId = '';
let outsiderId = '';
let targetId = '';
let cookie = '';
let baseUrl = '';

function request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, authCookie?: string) {
  return app.inject({ method, url, payload, headers: { origin, ...(authCookie ? { cookie: authCookie } : {}) } });
}

function sessionCookie(response: Awaited<ReturnType<typeof request>>) {
  const setCookie = response.headers['set-cookie'];
  const match = String(setCookie).match(/sid=([^;]+)/);
  if (!match) throw new Error('Authentication response did not set the session cookie');
  return `sid=${match[1]}`;
}

describe('MVP account, community, channel and chat flow', () => {
  beforeAll(async () => { app = await createApp(); baseUrl = await app.listen({ port: 0, host: '127.0.0.1' }); });
  afterAll(async () => {
    if (userId) {
      await db.delete(servers).where(eq(servers.ownerId, userId));
      await db.delete(users).where(eq(users.id, userId));
    }
    if (outsiderId) await db.delete(users).where(eq(users.id, outsiderId));
    if (targetId) await db.delete(users).where(eq(users.id, targetId));
    await app.close();
    await pool.end();
  });

  it('registers, creates a server and channel, persists chat, and rejects another account', async () => {
    const registered = await request('POST', '/api/auth/register', {
      username, displayName: 'MVP Tester', email, password: 'correct horse battery staple',
    });
    expect(registered.statusCode).toBe(201);
    expect(registered.json().user.username).toBe(username);
    cookie = sessionCookie(registered);
    userId = registered.json().user.id;

    const me = await request('GET', '/api/auth/me', undefined, cookie);
    expect(me.statusCode).toBe(200);
    expect(me.json().user.id).toBe(userId);
    const loggedIn = await request('POST', '/api/auth/login', { email, password: 'correct horse battery staple' });
    expect(loggedIn.statusCode).toBe(200);
    cookie = sessionCookie(loggedIn);

    const createdServer = await request('POST', '/api/servers', { name: 'Test Commons', description: 'API integration test' }, cookie);
    expect(createdServer.statusCode).toBe(201);
    const serverId = createdServer.json().id as string;

    const listedChannels = await request('GET', `/api/servers/${serverId}/channels`, undefined, cookie);
    expect(listedChannels.statusCode).toBe(200);
    expect(listedChannels.json()).toHaveLength(1);
    const newChannel = await request('POST', `/api/servers/${serverId}/channels`, { name: 'testing' }, cookie);
    expect(newChannel.statusCode).toBe(201);
    const voiceChannel = await request('POST', `/api/servers/${serverId}/channels`, { name: 'lounge', kind: 'voice' }, cookie);
    expect(voiceChannel.statusCode).toBe(201);
    expect(voiceChannel.json().kind).toBe('voice');

    const createdInvite = await request('POST', `/api/servers/${serverId}/invitations`, { expiresInHours: 24, maxUses: 5 }, cookie);
    expect(createdInvite.statusCode).toBe(201);
    const invitePreview = await request('GET', `/api/invites/${createdInvite.json().code}`);
    expect(invitePreview.statusCode).toBe(200);
    expect(invitePreview.json().name).toBe('Test Commons');

    const socket = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/api/realtime/${newChannel.json().id}`, { headers: { origin, cookie } });
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const pushed = new Promise<{ type: string; message: { content: string } }>((resolve) => socket.once('message', (data) => resolve(JSON.parse(data.toString()))));

    const sent = await request('POST', `/api/channels/${newChannel.json().id}/messages`, { content: 'Persisted and authorized.' }, cookie);
    expect(sent.statusCode).toBe(201);
    const event = await pushed;
    expect(event.type).toBe('message:new');
    expect(event.message.content).toBe('Persisted and authorized.');
    socket.close();
    await new Promise<void>((resolve) => socket.once('close', () => resolve()));
    const history = await request('GET', `/api/channels/${newChannel.json().id}/messages`, undefined, cookie);
    expect(history.statusCode).toBe(200);
    expect(history.json().map((message: { content: string }) => message.content)).toContain('Persisted and authorized.');

    const outsider = await request('POST', '/api/auth/register', {
      username: `out_${suffix}`, displayName: 'Outside User', email: `out-${suffix}@example.test`, password: 'correct horse battery staple',
    });
    expect(outsider.statusCode).toBe(201);
    const outsiderCookie = sessionCookie(outsider);
    outsiderId = outsider.json().user.id;
    const denied = await request('GET', `/api/servers/${serverId}/channels`, undefined, outsiderCookie);
    expect(denied.statusCode).toBe(404);
    expect((await request('POST', `/api/voice/${voiceChannel.json().id}/token`, {}, outsiderCookie)).statusCode).toBe(404);
    expect((await request('POST', `/api/invites/${createdInvite.json().code}/accept`, {}, outsiderCookie)).statusCode).toBe(200);
    expect((await request('GET', `/api/servers/${serverId}/channels`, undefined, outsiderCookie)).statusCode).toBe(200);

    const moderatorRole = await request('POST', `/api/servers/${serverId}/roles`, { name: 'Moderation', permissions: ['manage_invites', 'moderate_members', 'view_audit_log'] }, cookie);
    expect(moderatorRole.statusCode).toBe(201);
    expect((await request('PUT', `/api/servers/${serverId}/members/${outsiderId}/roles/${moderatorRole.json().id}`, {}, cookie)).statusCode).toBe(200);
    const managedInvite = await request('POST', `/api/servers/${serverId}/invitations`, { expiresInHours: 24, maxUses: 2 }, outsiderCookie);
    expect(managedInvite.statusCode).toBe(201);

    const target = await request('POST', '/api/auth/register', {
      username: `target_${suffix}`, displayName: 'Timeout Target', email: `target-${suffix}@example.test`, password: 'correct horse battery staple',
    });
    expect(target.statusCode).toBe(201);
    targetId = target.json().user.id;
    const targetCookie = sessionCookie(target);
    expect((await request('POST', `/api/invites/${createdInvite.json().code}/accept`, {}, targetCookie)).statusCode).toBe(200);
    const priorLiveKitEnv = { server: process.env.LIVEKIT_SERVER_URL, client: process.env.LIVEKIT_PUBLIC_URL, key: process.env.LIVEKIT_API_KEY, secret: process.env.LIVEKIT_API_SECRET };
    process.env.LIVEKIT_SERVER_URL = 'http://livekit:7880';
    process.env.LIVEKIT_PUBLIC_URL = 'ws://localhost:7880';
    process.env.LIVEKIT_API_KEY = 'devkey';
    process.env.LIVEKIT_API_SECRET = 'secret';
    const voiceToken = await request('POST', `/api/voice/${voiceChannel.json().id}/token`, {}, targetCookie);
    expect(voiceToken.statusCode).toBe(200);
    expect(voiceToken.json().canPublish).toBe(true);
    const granted = JSON.parse(Buffer.from(voiceToken.json().token.split('.')[1], 'base64url').toString('utf8'));
    expect(granted.video.room).toBe(`${serverId}:${voiceChannel.json().id}`);
    expect(granted.video.roomJoin).toBe(true);
    for (const [key, value] of Object.entries({ LIVEKIT_SERVER_URL: priorLiveKitEnv.server, LIVEKIT_PUBLIC_URL: priorLiveKitEnv.client, LIVEKIT_API_KEY: priorLiveKitEnv.key, LIVEKIT_API_SECRET: priorLiveKitEnv.secret })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    const timeout = await request('POST', `/api/servers/${serverId}/members/${targetId}/moderation`, { action: 'timeout', durationMinutes: 30, reason: 'Integration test' }, outsiderCookie);
    expect(timeout.statusCode).toBe(200);
    process.env.LIVEKIT_SERVER_URL = 'http://livekit:7880';
    process.env.LIVEKIT_PUBLIC_URL = 'ws://localhost:7880';
    process.env.LIVEKIT_API_KEY = 'devkey';
    process.env.LIVEKIT_API_SECRET = 'secret';
    const timedOutVoiceToken = await request('POST', `/api/voice/${voiceChannel.json().id}/token`, {}, targetCookie);
    expect(timedOutVoiceToken.statusCode).toBe(200);
    expect(timedOutVoiceToken.json().canPublish).toBe(false);
    for (const [key, value] of Object.entries({ LIVEKIT_SERVER_URL: priorLiveKitEnv.server, LIVEKIT_PUBLIC_URL: priorLiveKitEnv.client, LIVEKIT_API_KEY: priorLiveKitEnv.key, LIVEKIT_API_SECRET: priorLiveKitEnv.secret })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    expect((await request('POST', `/api/channels/${newChannel.json().id}/messages`, { content: 'This should be blocked.' }, targetCookie)).statusCode).toBe(403);
    const actions = await request('GET', `/api/servers/${serverId}/moderation-actions`, undefined, outsiderCookie);
    expect(actions.statusCode).toBe(200);
    expect(actions.json()[0].action).toBe('timeout');
    expect((await request('POST', `/api/servers/${serverId}/members/${targetId}/moderation`, { action: 'untimeout', reason: 'Resolved' }, outsiderCookie)).statusCode).toBe(200);
    expect((await request('POST', `/api/channels/${newChannel.json().id}/messages`, { content: 'Timeout was lifted.' }, targetCookie)).statusCode).toBe(201);

    expect((await request('POST', `/api/servers/${serverId}/members/${targetId}/moderation`, { action: 'ban', reason: 'Repeated abuse' }, outsiderCookie)).statusCode).toBe(200);
    expect((await request('POST', `/api/invites/${createdInvite.json().code}/accept`, {}, targetCookie)).statusCode).toBe(403);
    expect((await request('POST', `/api/servers/${serverId}/members/${targetId}/moderation`, { action: 'unban', reason: 'Appeal accepted' }, outsiderCookie)).statusCode).toBe(200);
    expect((await request('POST', `/api/invites/${createdInvite.json().code}/accept`, {}, targetCookie)).statusCode).toBe(200);
    expect((await request('DELETE', `/api/invitations/${managedInvite.json().id}`, undefined, outsiderCookie)).statusCode).toBe(200);
    expect((await request('GET', `/api/invites/${managedInvite.json().code}`)).statusCode).toBe(404);

    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await request('POST', '/api/auth/register', {})).statusCode).toBe(400);
    }
    expect((await request('POST', '/api/auth/register', {})).statusCode).toBe(429);
  });

  it('rejects state-changing requests from a foreign origin', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin: 'https://attacker.example' } });
    expect(response.statusCode).toBe(403);
  });
});
