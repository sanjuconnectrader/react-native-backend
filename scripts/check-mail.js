import 'dotenv/config';
import { mailConfigured, mailProvider, verifyMailConnection } from '../src/config/mail.js';

if (!mailConfigured) {
  console.error('Email service configuration is incomplete');
  process.exitCode = 1;
} else {
  try {
    await verifyMailConnection();
    console.log(`${mailProvider} configuration verified; no email was sent`);
  } catch (error) {
    console.error(`${mailProvider || 'Email service'} check failed: ${error.code || error.name}`);
    process.exitCode = 1;
  }
}
