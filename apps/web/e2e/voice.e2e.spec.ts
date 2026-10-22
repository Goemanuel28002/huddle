import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const ownerUsername = `voice_${suffix}`;
const guestUsername = `guest_${suffix}`;
const ownerEmail = `voice-${suffix}@example.test`;
const guestEmail = `guest-${suffix}@example.test`;
const createdUserIds: string[] = [];
let ownerContext: BrowserContext;
let guestContext: BrowserContext;
let ownerPage: Page;
let guestPage: Page;

async function createAccount(page: Page, username: string, displayName: string, email: string) {
  await page.goto('/');
  await page.locator('.auth-switch button').click();
  await page.getByLabel('Benutzername').fill(username);
  await page.getByLabel('Anzeigename').fill(displayName);
  await page.getByLabel('E-Mail-Adresse').fill(email);
  await page.getByLabel('Passwort').fill('correct horse battery staple');
  await page.locator('.auth-form button.primary-button').click();
  await expect(page.locator('.app-shell')).toBeVisible();
  const account = await page.evaluate(async () => (await fetch('/api/auth/me')).json());
  createdUserIds.push(account.user.id);
}

test.afterAll(async () => {
  await ownerContext?.close();
  await guestContext?.close();
  if (createdUserIds.length === 0) return;
  const varsPath = resolve(process.cwd(), '../../.env.preview');
  const vars = Object.fromEntries(readFileSync(varsPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
    const splitAt = line.indexOf('=');
    return [line.slice(0, splitAt), line.slice(splitAt + 1)];
  }));
  const database = new pg.Pool({ connectionString: `postgres://${encodeURIComponent(vars.POSTGRES_USER)}:${encodeURIComponent(vars.POSTGRES_PASSWORD)}@127.0.0.1:55432/connect_together` });
  try {
    await database.query('DELETE FROM servers WHERE owner_id = $1', [createdUserIds[0]]);
    await database.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [createdUserIds]);
  } finally { await database.end(); }
});

test('a guest joins an invited community and participants exchange real LiveKit audio, camera and screen-share tracks', async ({ browser }) => {
  ownerContext = await browser.newContext({ permissions: ['microphone', 'camera'] });
  guestContext = await browser.newContext({ permissions: ['microphone', 'camera'] });
  ownerPage = await ownerContext.newPage();
  guestPage = await guestContext.newPage();
  ownerPage.on('pageerror', (error) => console.error(`[owner page error] ${error.message}`));
  guestPage.on('pageerror', (error) => console.error(`[guest page error] ${error.message}`));

  await createAccount(ownerPage, ownerUsername, 'Voice Owner', ownerEmail);
  await expect(ownerPage.locator('.invite-card')).toBeDisabled();
  await expect(ownerPage.locator('.invite-card')).toContainText('Erstelle zuerst eine Community');
  await ownerPage.locator('.empty-state button').click();
  await ownerPage.getByLabel('Name deiner Community').fill(`Voice Room ${suffix}`);
  await ownerPage.getByLabel('Kurze Beschreibung').fill('LiveKit end-to-end check');
  await ownerPage.locator('.modal-card .primary-button').click();
  await expect(ownerPage.locator('.community-card h3')).toContainText(`Voice Room ${suffix}`);

  await ownerPage.locator('.channel-create').click();
  await ownerPage.getByLabel('Kanalname').fill('lounge');
  await ownerPage.getByLabel('Kanaltyp').selectOption('voice');
  await ownerPage.locator('.modal-card .primary-button').click();
  await ownerPage.getByRole('button', { name: /lounge/ }).click();
  await expect(ownerPage.getByRole('button', { name: /Voice beitreten/ })).toBeVisible();

  await ownerPage.locator('.right-callout button').click();
  const invitationUrl = await ownerPage.locator('.modal-card input[readonly]').inputValue();
  await expect(ownerPage.locator('.modal-card')).toContainText('Die lokale Vorschau ist nur von diesem PC erreichbar');
  await ownerPage.locator('.modal-close').click();
  await guestPage.goto(invitationUrl);
  await guestPage.locator('.auth-switch button').click();
  await guestPage.getByLabel('Benutzername').fill(guestUsername);
  await guestPage.getByLabel('Anzeigename').fill('Voice Guest');
  await guestPage.getByLabel('E-Mail-Adresse').fill(guestEmail);
  await guestPage.getByLabel('Passwort').fill('correct horse battery staple');
  await guestPage.locator('.auth-form button.primary-button').click();
  await expect(guestPage.locator('.app-shell')).toBeVisible();
  await expect(guestPage.getByText(`Du bist Voice Room ${suffix} beigetreten.`)).toBeVisible();
  const account = await guestPage.evaluate(async () => (await fetch('/api/auth/me')).json());
  createdUserIds.push(account.user.id);

  await guestPage.getByRole('button', { name: /lounge/ }).click();
  await ownerPage.getByRole('button', { name: /Voice beitreten/ }).click();
  await expect(ownerPage.getByText('Verbunden · echte WebRTC-Medienverbindung')).toBeVisible();
  await guestPage.getByRole('button', { name: /Voice beitreten/ }).click();
  await expect(guestPage.getByText('Verbunden · echte WebRTC-Medienverbindung')).toBeVisible();

  await expect(ownerPage.locator('.voice-person')).toHaveCount(2, { timeout: 30_000 });
  await expect(guestPage.locator('.voice-person')).toHaveCount(2, { timeout: 30_000 });
  await expect(ownerPage.locator('.voice-audio-root audio')).toHaveCount(1, { timeout: 30_000 });
  await expect(guestPage.locator('.voice-audio-root audio')).toHaveCount(1, { timeout: 30_000 });

  await ownerPage.getByRole('button', { name: 'Kamera an' }).click();
  await expect(ownerPage.locator('.voice-video-tile video')).toHaveCount(1, { timeout: 30_000 });
  await expect(guestPage.locator('.voice-video-tile video')).toHaveCount(1, { timeout: 30_000 });
  await guestPage.getByRole('button', { name: 'Kamera an' }).click();
  await expect(ownerPage.locator('.voice-video-tile video')).toHaveCount(2, { timeout: 30_000 });
  await expect(guestPage.locator('.voice-video-tile video')).toHaveCount(2, { timeout: 30_000 });

  await ownerPage.getByRole('button', { name: 'Bildschirm teilen' }).click();
  await expect(ownerPage.locator('.voice-video-label', { hasText: 'Bildschirm' })).toBeVisible({ timeout: 30_000 });
  await expect(guestPage.locator('.voice-video-label', { hasText: 'Bildschirm' })).toBeVisible({ timeout: 30_000 });
  await expect(ownerPage.locator('.voice-video-tile video')).toHaveCount(3, { timeout: 30_000 });
  await expect(guestPage.locator('.voice-video-tile video')).toHaveCount(3, { timeout: 30_000 });
  await ownerPage.getByRole('button', { name: 'Teilen beenden' }).click();
  await expect(ownerPage.locator('.voice-video-label', { hasText: 'Bildschirm' })).toHaveCount(0);
  await expect(guestPage.locator('.voice-video-label', { hasText: 'Bildschirm' })).toHaveCount(0);
  await expect(ownerPage.locator('.voice-video-tile video')).toHaveCount(2);
  await expect(guestPage.locator('.voice-video-tile video')).toHaveCount(2);
  await ownerPage.getByRole('button', { name: 'Kamera aus' }).click();
  await expect(ownerPage.locator('.voice-video-tile video')).toHaveCount(1);
  await expect(guestPage.locator('.voice-video-tile video')).toHaveCount(1);

});
