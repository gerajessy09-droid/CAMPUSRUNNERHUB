# CampusRunner (Netlify)

Static site in `public/`, API in `netlify/functions/api.js` (Postgres + Paystack),
auto-release job in `netlify/functions/autorelease.js` (every 10 minutes).

## Deploy (about 10 minutes)
1. Create a free Postgres database at https://neon.tech and copy the connection string.
2. Upload this folder's contents to a new GitHub repository (repo root = the files here).
3. In Netlify: Add new site > Import an existing project > pick the repo. Settings come from `netlify.toml`.
4. Add environment variables (see `.env.example`). Tables and the admin account are created on the first request.
5. Paystack (Settings > API Keys & Webhooks): put the test secret key in `PAYSTACK_SECRET_KEY` and set the
   webhook URL to `https://YOUR-SITE.netlify.app/api/payments/webhook`.

## Logins
- **Admin:** the `ADMIN_EMAIL` and `ADMIN_PASSWORD` you set. Sign in at `/#/login?mode=login`; you land on the Admin page.
- **Students:** register on the site, then approve them in Admin > IDs.
- **Quick test without Paystack:** set `ALLOW_DEMO=1` before the first visit. You get a fake checkout and these logins
  (password `demo1234`): `admin@example.com`, `ada@example.com`, `tunde@example.com`.
  Post as Ada, accept as Tunde in a private window. Remove `ALLOW_DEMO` before real use.
