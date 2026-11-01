# Host Nemotron on a VPS

These instructions run the primary Nemotron service (`ai-agent/`) on one Linux VPS. The service hosts the web UI and Telegram webhook on the same port. The generated Replit API and component-preview services are not required for Nemotron.

## Before you begin

- A supported Debian/Ubuntu VPS with a stable public IP, SSH access, and a DNS name pointing to it.
- Node.js **24.x** and npm installed system-wide. The application package requires Node 24.
- PostgreSQL 16 or later, either on the VPS or on a managed PostgreSQL provider.
- An NVIDIA API key and a Telegram bot created with `@BotFather`.
- HTTPS for your domain. Telegram webhooks require a publicly reachable HTTPS URL.

**Credential warning:** An environment file was committed to the original project history. Do not retrieve or reuse its values. Rotate any real NVIDIA, Telegram, database, signing, or encryption credentials it contained, then put new values only in the VPS secret file. The [clean GitHub export procedure](GITHUB_UPLOAD.md) excludes that file and the original commit history. Plan signing/encryption-key rotation carefully if you already have signed invoices or encrypted bot credentials; changing keys without migrating dependent data can make that data unusable.

## 1. Prepare the VPS

Allow inbound SSH and web traffic (ports 22, 80, and 443) in your provider's firewall. Install Git, Nginx, PostgreSQL if hosting the database locally, and Node.js 24. Confirm:

```sh
node --version   # should be v24.x
npm --version
```

Create a service account and checkout the private GitHub repository. For SSH checkout, add a read-only deploy key to the repository and install its private half securely on the VPS; do not paste a GitHub token into shell commands or commit it.

```sh
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin nemotron
sudo mkdir -p /srv/nemotron
sudo chown "$USER":"$USER" /srv/nemotron
git clone git@github.com:calvin-munene/nemotron.git /srv/nemotron
cd /srv/nemotron/ai-agent
npm ci --omit=dev --ignore-scripts
```

If you use HTTPS instead of SSH to clone a private repository, authenticate using your VPS's approved Git credential manager rather than embedding a token in the clone URL.

## 2. Create the PostgreSQL database

For local PostgreSQL, open `psql` with `sudo -u postgres psql`, then create a dedicated database and owner:

```sql
CREATE ROLE nemotron LOGIN;
\password nemotron
CREATE DATABASE nemotron OWNER nemotron;
\q
```

The `\password` command prompts securely instead of placing the password in shell history. Use that password in `DATABASE_URL`; percent-encode reserved URL characters. For a managed database, use its TLS-enabled connection string and restrict access to this VPS.

The first app startup applies the app's checksummed database migrations. The database user must own the application database. Back up existing data before upgrading.

Do not set `NVID_SCHEMA_MODE=verify` for a fresh VPS database: that Replit production setting expects an already-provisioned schema. It is intentionally not used by the standalone systemd setup here.

**Moving the existing live bot:** A fresh database has none of the current users, credits, payments, groups, or encrypted bot credentials. Before production cutover, take a verified backup of the current production database, restore it through your approved migration process, and confirm balances and required keys. Do not point the production bot at an empty database unless you intentionally want a fresh installation.

## 3. Configure environment variables

Store production settings outside the checkout:

```sh
sudo install -d -m 700 -o root -g root /etc/nemotron
sudo install -m 600 -o root -g root /dev/null /etc/nemotron/nemotron.env
sudoedit /etc/nemotron/nemotron.env
```

Set these values in `/etc/nemotron/nemotron.env`:

```dotenv
NODE_ENV=production
PORT=3000
PUBLIC_URL=https://YOUR_DOMAIN
DATABASE_URL=postgresql://nemotron:URL_ENCODED_PASSWORD@127.0.0.1:5432/nemotron

NVIDIA_API_KEY=REPLACE_WITH_A_NEW_NVIDIA_KEY
TELEGRAM_BOT_TOKEN=REPLACE_WITH_A_ROTATED_BOT_TOKEN
TELEGRAM_WEBHOOK_SECRET=REPLACE_WITH_A_RANDOM_SECRET
TELEGRAM_ADMIN_USER_ID=YOUR_NUMERIC_TELEGRAM_USER_ID
TELEGRAM_STARS_REQUIRED=true
TELEGRAM_STAR_SIGNING_SECRET=REPLACE_WITH_A_DIFFERENT_RANDOM_SECRET

# Leave blank on a VPS behind the Nginx configuration below.
TRUST_PROXY=
```

Generate independent secrets (do not use the same value for both):

```sh
openssl rand -hex 32
openssl rand -hex 32
```

Use one value for `TELEGRAM_WEBHOOK_SECRET` and the other for `TELEGRAM_STAR_SIGNING_SECRET`. Keep the Stars secret stable: changing it later can prevent verification of previously signed payment data. Set `TELEGRAM_STARS_REQUIRED=false` only if you deliberately want to disable prepaid Stars billing. With Stars enabled, the bot token, administrator ID, signing secret, and PostgreSQL database are required.

Set optional Telegram website-login variables only if you have configured Telegram's OIDC flow in BotFather. Set `TELEGRAM_OIDC_REDIRECT_URI` to `https://YOUR_DOMAIN/auth/telegram/callback`. Leave WhatsApp and managed-bot settings unset unless you separately configure those integrations. Never copy the old uploaded environment file.

## 4. Add a systemd service

Check the system-wide Node path with `command -v node`. The unit below assumes `/usr/bin/node`; change `ExecStart` if yours differs.

```ini
# /etc/systemd/system/nemotron.service
[Unit]
Description=Nemotron AI service
Wants=network-online.target
After=network-online.target postgresql.service

[Service]
Type=simple
User=nemotron
Group=nemotron
WorkingDirectory=/srv/nemotron/ai-agent
EnvironmentFile=/etc/nemotron/nemotron.env
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict

[Install]
WantedBy=multi-user.target
```

Ensure the checkout is readable by the `nemotron` service account, then start the app:

```sh
sudo chown -R root:root /srv/nemotron
sudo chmod -R go-w /srv/nemotron
sudo systemctl daemon-reload
sudo systemctl enable --now nemotron
sudo systemctl status nemotron
```

## 5. Configure Nginx and HTTPS

Create `/etc/nginx/sites-available/nemotron` (replace `YOUR_DOMAIN`):

```nginx
server {
    listen 80;
    server_name YOUR_DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

Enable the site and request a TLS certificate with Certbot:

```sh
sudo ln -s /etc/nginx/sites-available/nemotron /etc/nginx/sites-enabled/nemotron
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d YOUR_DOMAIN
```

After HTTPS is active, verify `PUBLIC_URL` is exactly the HTTPS origin (no path or trailing route) and restart:

```sh
sudo systemctl restart nemotron
curl --fail https://YOUR_DOMAIN/health/live
curl --fail https://YOUR_DOMAIN/health/ready
```

Check startup and runtime logs with `sudo journalctl -u nemotron -f`. `/health/ready` returns HTTP 200 when PostgreSQL and required Telegram setup are ready. Keep the database and payment ledger healthy; do not expose PostgreSQL or port 3000 publicly.

## Telegram webhook cutover

**Starting this service with the same `TELEGRAM_BOT_TOKEN` as the currently published Replit app changes the bot's single Telegram webhook to this VPS.** This will move new bot updates away from the Replit deployment. First verify the VPS with a separate test bot, then schedule a cutover using the production bot token. To move back, restore the previous public URL and restart the Replit deployment so it registers the webhook again.

## Updating the VPS

Take a database backup first, then deploy the selected GitHub revision:

```sh
cd /srv/nemotron
git pull --ff-only
cd ai-agent
npm ci --omit=dev --ignore-scripts
sudo systemctl restart nemotron
sudo journalctl -u nemotron -n 100 --no-pager
curl --fail https://YOUR_DOMAIN/health/ready
```

If the service does not become ready, inspect the journal and PostgreSQL connectivity before retrying; never work around a failed migration by deleting production tables.
