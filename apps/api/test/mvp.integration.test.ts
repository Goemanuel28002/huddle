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
let cookie = '';
let baseUrl = '';

function request(method: 'GET' | 'POST', url: string, payload?: unknown, authCookie?: string) {
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
    const denied = await request('GET', `/api/servers/${serverId}/channels`, undefined, sessionCookie(outsider));
    expect(denied.statusCode).toBe(404);
    await db.delete(users).where(eq(users.id, outsider.json().user.id));
  });

  it('rejects state-changing requests from a foreign origin', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin: 'https://attacker.example' } });
    expect(response.statusCode).toBe(403);
  });
});
