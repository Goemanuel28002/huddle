import { createApp } from './app.js';

const app = await createApp();
const port = Number(process.env.PORT ?? 3000);
try { await app.listen({ port, host: '0.0.0.0' }); }
catch (error) { app.log.error(error); process.exit(1); }
