# DEPLOY.md - BizMap on the Windows VPS

BizMap runs on a Windows VPS as one Node process (the API, which also serves the built web app), managed by NSSM, in front of Postgres 18 + PostGIS. There is no Netlify.

```
Browser -> HTTPS reverse proxy (80/443) -> Node API on 127.0.0.1:8787 -> Postgres (localhost:5432)
                                            \-> serves apps/web/dist
```

The API listens only on `127.0.0.1`, so a reverse proxy on the same machine must expose it. Never open ports 5432 or 8787 to the internet.

Replace `C:\path\to\BizMap` and the NSSM service name `bizmap` below with your real values (`nssm list` shows service names; `nssm get bizmap AppDirectory` shows the folder).

---

## 1. Update an existing deployment (the usual task)

Run in PowerShell as Administrator on the VPS.

```powershell
cd C:\path\to\BizMap

# 1. backup the database first
pg_dump -U bizmap -Fc bizmap > C:\backups\bizmap_before_update.dump

# 2. get the code (never overwrites .env or data\, they are not in git)
git pull

# 3. only if package.json / package-lock.json changed
npm ci

# 4. rebuild the web app
npm run app:build

# 5. restart the API
nssm restart bizmap
nssm status bizmap
```

Then hard refresh the site (Ctrl+F5) and check it works.

- The schema migrates automatically when the API starts. There is no manual migration step.
- A healthy start logs: `BizMap API on http://127.0.0.1:8787 - N businesses in Postgres`.
- Logs: `nssm get bizmap AppStdout` and `nssm get bizmap AppStderr` show the log file paths.

### Rollback
```powershell
git log --oneline -5            # find the last good commit
git checkout <good-commit>      # or: git revert <bad-commit>
npm run app:build
nssm restart bizmap
```
Restore the database from the dump only if a release changed the schema or data (`pg_restore -U bizmap -d bizmap --clean C:\backups\<file>.dump`).

---

## 2. First-time setup (reference)

### Prerequisites
- Windows Server/VPS with a public IP and a domain pointing at it.
- Node >= 22.5 (24 is used), Git, NSSM.
- Postgres 18 with PostGIS and `pg_trgm`.
- Firewall: allow only 80 and 443 inbound.

### Database
As the `postgres` user:
```sql
CREATE ROLE bizmap LOGIN PASSWORD '<strong password>';
CREATE DATABASE bizmap OWNER bizmap;
\c bizmap
CREATE EXTENSION postgis;
CREATE EXTENSION pg_trgm;
```

### Code and data
```powershell
git clone https://github.com/HIMURANA/BizMap.git C:\path\to\BizMap
cd C:\path\to\BizMap
npm ci
```
Copy the `data\` folder (it contains `data\db\dhaka.sqlite`) to the server; it is not in git. Then load the businesses once:
```powershell
npm run build-search
npm run pg:sync        # copies ~140k businesses into Postgres (~20 s)
```

### `.env` (in the project root; never commit it)
```
DATABASE_URL=postgres://bizmap:<password>@localhost:5432/bizmap
NODE_ENV=production
APP_URL=https://your-domain.com
APP_SECRET=<long random string>
TRUST_PROXY=1
```
Optional:
- Email: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` (or `SMTP_URL`), `MAIL_FROM`. Without SMTP, emails are only captured in the in-app Outbox.
- Payments: `SSLC_STORE_ID`, `SSLC_STORE_PASSWORD`, `SSLC_LIVE=1`. Without them a fake test gateway is used.
- `TRIAL_CREDITS`, `ALLOW_SIGNUP`, `BILLING_PACKS`.
- `PLATFORM_ADMIN_EMAILS=a@x.com,b@x.com`: these accounts get the **Platform admin** menu (`/admin`): all workspaces, users, credits, suspend/delete and an audit log. The list is applied at every API start, so remove an email and restart to revoke. The account must already exist (sign up first).
- `WORKERS=0` on any extra API server, so campaigns are never sent twice (only one process should run the workers).

Notes:
- `APP_SECRET` encrypts the WhatsApp tokens stored in the database. Back it up; without it stored tokens cannot be decrypted. Do not change it after tokens are saved.
- `NODE_ENV=production` means WhatsApp does not fall back to test mode: each workspace must connect real Meta credentials.
- Cookies are Secure in production, so HTTPS is required.

### Build and run as an NSSM service
```powershell
npm run app:build
nssm install bizmap "C:\Program Files\nodejs\node.exe"
nssm set bizmap AppDirectory C:\path\to\BizMap
nssm set bizmap AppParameters "--import tsx apps/api/server.ts"
nssm set bizmap AppStdout C:\path\to\BizMap\logs\api.out.log
nssm set bizmap AppStderr C:\path\to\BizMap\logs\api.err.log
nssm set bizmap AppRotateFiles 1
nssm set bizmap Start SERVICE_AUTO_START
nssm start bizmap
```
(Check that this matches how your existing service is configured: `nssm dump bizmap`.)

### HTTPS reverse proxy
Caddy example (automatic certificates):
```
your-domain.com {
    reverse_proxy 127.0.0.1:8787
}
```
The proxy must forward `Host`, `X-Forwarded-For` and `X-Forwarded-Proto` (Caddy does by default). IIS with URL Rewrite/ARR or nginx work too.

---

## 3. WhatsApp go-live (per workspace)

1. Create a Meta Business app with WhatsApp Cloud API. Enter the phone number ID, WABA ID, access token and app secret in the app's settings.
2. In Meta, set the webhook URL to `https://your-domain.com/api/whatsapp/webhook` (confirm the exact path in `apps/api/whatsapp.ts`) and the verify token the app shows. Without it, delivery statuses never arrive.
3. Create templates in Meta and wait for approval.
4. Send a small test batch (50-100 numbers) before a full campaign.

### How sending behaves
- No opt-in is required. Numbers that replied STOP (revoked consent) are skipped.
- If Meta reports a number is not on WhatsApp (error 131026), the number is added to the do-not-contact list with the reason "not on WhatsApp", and later campaigns skip it. Review that list after your first batch; remove a number from it to retry it.
- Each recipient uses one credit when the campaign is launched, including numbers that turn out not to be on WhatsApp.
- Marketing messages to people who never agreed to receive them risk user reports, a lower quality rating, lower sending limits and a banned number. A banned number stops campaigns for every customer using it.

---

## 4. Backups and maintenance

- Nightly database backup, with copies kept off the server:
  ```powershell
  pg_dump -U bizmap -Fc bizmap > C:\backups\bizmap_$(Get-Date -Format yyyyMMdd).dump
  ```
  Schedule it with Task Scheduler. Test a restore at least once.
- Back up `.env` (especially `APP_SECRET`) somewhere safe, separate from the database backups.
- `data\app_exports\` holds generated export files; clean it up occasionally.
- Windows Update: reboot at a quiet time. The NSSM service starts automatically.

## 5. Troubleshooting

| Symptom | Check |
|---|---|
| Site down / 502 | `nssm status bizmap`; read the stderr log; is Postgres running? |
| "DATABASE_URL is not set" | `.env` missing in the project root (the folder NSSM uses as `AppDirectory`) |
| "Database not ready" | Postgres stopped, wrong password in `DATABASE_URL`, or PostGIS not installed |
| "Web app not built" | run `npm run app:build` |
| Login works but session is lost | HTTPS or proxy headers wrong; check `TRUST_PROXY=1` and `X-Forwarded-Proto` |
| WhatsApp campaign shows 0 recipients | Preview shows why: no address (invalid number), suppressed, opted out, duplicate |
| WhatsApp "disabled" | Production mode with no Meta credentials saved for that workspace |

## 6. Pre-launch checklist

- [ ] HTTPS works; login cookie is Secure
- [ ] Ports 5432 and 8787 are not reachable from outside
- [ ] `.env` and `data\` are not in git and not web-accessible
- [ ] `ALLOW_SIGNUP` set the way you want
- [ ] Real SMTP and payment keys set (if selling credits)
- [ ] Meta webhook verified
- [ ] Backup restore tested once
- [ ] Bangladesh rules for bulk WhatsApp, email and call outreach reviewed by a lawyer
