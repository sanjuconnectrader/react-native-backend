# Serveflow POS backend

Node.js/Express API for the Expo and desktop POS clients. Supabase PostgreSQL is the shared source of truth. Payments in this version are confirmed manually by authorized staff; there is no payment gateway.

## Local setup

1. Install Node.js 20+. Open the Supabase project and copy the **Session pooler** connection parameters from **Connect**. Use the direct connection only when the backend host supports IPv6.
2. Run `npm install` in `backend/`.
3. Copy `.env.example` to `.env`. Set `DB_HOST`, `DB_PORT=5432`, `DB_NAME=postgres`, `DB_USER=postgres.<project-ref>` for the Session pooler, and `DB_PASSWORD` to the database password. Keep `DB_SSL=true`. Download the project certificate from **Project Settings → Database → SSL Configuration** to `backend/supabase-ca.crt` and set `DB_SSL_CA_FILE=./supabase-ca.crt`. Set unique random `JWT_SECRET` and `OTP_SECRET`, allowed web origins, and SMTP settings. Never put the database password in an `EXPO_PUBLIC_` variable or mobile bundle.
4. Run `npm run migrate` then `npm run dev`.

On Render free services, configure `RESEND_API_KEY` and `EMAIL_FROM` to send through Resend's HTTPS API. SMTP remains available for local development. Run `npm run check:mail` to verify that the selected email provider is configured.

The supplied local `.env` uses port 5000. SMTP is required for owner registration, 2FA login, and password reset. The API starts without SMTP in development, but those email flows will fail until it is configured. Do not commit `.env`.

On a physical phone, `localhost` means the phone itself. Point the Expo app at this computer's LAN address during development, or the backend's public HTTPS URL after deployment.

For production, set `NODE_ENV=production`, configure TLS at the reverse proxy, use dedicated database credentials, set SMTP and HTTPS origins, and run `npm run migrate` before `npm start`. Access JWTs expire after 15 minutes; refresh sessions expire after 7 days. The Session pooler is suitable for a persistent backend on an IPv4-only network; use Supabase's transaction pooler for a serverless deployment and review ORM compatibility first.

## Supabase storage and access

The Free plan enters read-only mode above **500 MB of database data**. Supabase starts with some space already used by its own schemas and extensions. The application stores no receipt images or binary media in Postgres. Receipt JSON is gzip compressed into `bytea` when this is smaller than the original JSON; short receipts stay uncompressed. Existing receipt snapshots are converted by migration. Expired one-time codes and refresh sessions are pruned automatically every six hours. Orders, payments, refunds, receipts, and audit records are retained because they may be needed for accounting and dispute review.

The migrations enable RLS, remove `anon`, `authenticated`, and `service_role` table grants from the POS tables in `public`, and revoke automatic API grants for future tables, functions, and sequences. The backend continues to use its private PostgreSQL connection. In Supabase **Settings → API**, also disable **Automatically expose new tables** so the dashboard setting reflects this policy; the project creation screenshots show that option enabled. The mobile app only calls the backend API and never receives the database password or service-role key. Run `npm run db:verify` to check table access, receipt storage, and current database size.

Use Supabase's Database Reports to monitor growth. For a quick size breakdown in the SQL editor:

```sql
SELECT pg_size_pretty(pg_database_size(current_database())) AS database_size;
SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) AS total_size
FROM pg_catalog.pg_statio_user_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(relid) DESC;
```

Postgres autovacuum reuses deleted row space; deleting expired rows may not immediately reduce the reported file size. Do not apply gzip to individual order rows, indexed fields, numeric amounts, or password hashes: those are small or incompressible and compression would increase CPU and often storage.

## Main endpoints

All responses use `{ success, message, data }` or `{ success: false, message, errorCode }`.

| Flow | Endpoint |
| --- | --- |
| Owner registration | `POST /api/auth/owner/register`, `/owner/verify-email`, `/owner/set-password`, `/owner/activate` |
| Country picker | `GET /api/countries` |
| Owner login | `POST /api/auth/owner/login`, `/owner/verify-login` |
| Employee login | `POST /api/auth/employee/login` |
| Sessions | `POST /api/auth/refresh`, `/logout`, `/logout-all` |
| Password reset | `POST /api/auth/owner/forgot-password`, `/owner/reset-password` |
| Catalog | `/api/categories`, `/api/menu-items` |
| Tables and reservations | `/api/tables`, `/api/reservations` |
| Orders | `/api/orders`, `/api/orders/:id/items`, `/api/orders/:id/confirm`, `/api/orders/:id/bill` |
| Payments | `POST /api/orders/:id/payments` |
| Refunds | `POST /api/payments/:id/refunds` |
| Receipts | `GET /api/receipts/:id` |
| Management | `/api/employees`, `/api/roles`, `/api/permissions`, `/api/settings`, `/api/dashboard`, `/api/reports` |
| Shifts | `/api/shifts/start`, `/api/shifts/:id/end`, `GET /api/shifts` |

Protected endpoints require `Authorization: Bearer <accessToken>`. Socket.IO connects with `auth: { token: accessToken }` and joins only the authenticated restaurant room.

Registration sends `owner.phoneCountryCode` (two letter ISO country code) and a national `owner.phone`. The backend validates and stores the phone in E.164 format and derives the restaurant's country, currency, and locale. The mobile app supplies its device timezone automatically; the backend accepts an optional IANA timezone and defaults to UTC for other clients. Employee, reservation, and restaurant contact phone updates can also send `phoneCountryCode` with a national `phone`. Country, currency, locale, and timezone are not separate registration inputs.

`/owner/verify-email` returns a short lived `setupToken`; send it to `/owner/set-password`. That endpoint returns an `activationChallenge`, which is required with the emailed code at `/owner/activate`. Later `/owner/login` returns a `loginChallenge` after password validation; send it with the emailed code to `/owner/verify-login`.

Example cash confirmation:

```json
{
  "method": "CASH",
  "cashReceived": "50.00",
  "idempotencyKey": "c42b508e-8d2f-4369-88a3-e319a0d5b4bc",
  "confirmed": true
}
```

The backend loads current order totals and rejects insufficient cash or duplicate confirmation. The client must only send this request after staff physically receives the money. External card and UPI confirmations use `CARD_MANUAL` or `UPI_MANUAL` and are recorded as `verificationMode: MANUAL`.

## Verification

Run `npm run lint`, `npm run typecheck`, and `npm test` in this folder. Run `npx expo lint` and `npx tsc --noEmit` from the repository root for the mobile app.
