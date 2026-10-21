import { createApp } from './app.js';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db } from './db/index.js';

await migrate(db, { migrationsFolder: new URL('../drizzle/', import.meta.url).pathname });
const app = await createApp();
const port = Number(process.env.PORT ?? 3000);
try { await app.listen({ port, host: '0.0.0.0' }); }
catch (error) { app.log.error(error); process.exit(1); }
