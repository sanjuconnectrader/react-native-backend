import http from 'node:http';
import { app } from './src/app.js';
import { db } from './src/config/database.js';
import { config, validateEnv } from './src/config/env.js';
import { mailProvider, verifyMailConnection } from './src/config/mail.js';
import { initSockets } from './src/sockets/index.js';
import { startDatabaseMaintenance } from './src/services/database-maintenance.js';

validateEnv();
await db.authenticate();
console.log('PostgreSQL connected');
try {
  if (await verifyMailConnection()) console.log(`${mailProvider} configured`);
  else console.warn('Email service not configured');
} catch (error) {
  console.error(`${mailProvider || 'Email service'} connection failed: ${error.code || error.name}`);
  if (process.env.NODE_ENV === 'production') throw error;
}
const server = http.createServer(app);
initSockets(server);
const stopMaintenance = startDatabaseMaintenance();
server.listen(config.port, () => console.log(`POS API listening on port ${config.port}`));
const stop = () => { stopMaintenance(); server.close(() => db.close()); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
