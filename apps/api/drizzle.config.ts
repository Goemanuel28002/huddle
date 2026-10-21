import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'drizzle-kit';

const workspaceEnv = resolve(process.cwd(), '../../.env');
config({ path: existsSync(workspaceEnv) ? workspaceEnv : resolve(process.cwd(), '.env') });

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://community:community_dev_only@localhost:5432/community' },
});
