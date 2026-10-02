import 'dotenv/config';
import { mailConfigured, verifyMailConnection } from '../src/config/mail.js';

if (!mailConfigured) {
  console.error('SMTP configuration is incomplete');
  process.exitCode = 1;
} else {
  try {
    await verifyMailConnection();
    console.log('SMTP connection and authentication succeeded; no email was sent');
  } catch (error) {
    console.error(`SMTP check failed: ${error.code || error.name}`);
    process.exitCode = 1;
  }
}
