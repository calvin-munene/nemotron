# Nemotron

Nemotron is a Telegram-connected AI assistant with a browser Mini App, PostgreSQL-backed payments and group management, and NVIDIA model access.

## VPS hosting

The main application is `ai-agent/`. It is a Node.js 24 service that serves the web interface and Telegram webhook on one port. The standalone VPS install does not need the Replit preview servers or the generated component-preview service.

Read **[VPS deployment instructions](docs/VPS_DEPLOYMENT.md)** before installing. They cover PostgreSQL, environment variables, HTTPS/reverse proxy, systemd, updates, and Telegram webhook cutover.

For the isolated, loopback-only Docker stage, see **[Docker staging instructions](docs/DOCKER_STAGING.md)**. It is not a production configuration.

## GitHub upload

If the connected GitHub integrations cannot create the repository, follow **[the clean GitHub upload procedure](docs/GITHUB_UPLOAD.md)**. Do not push this workspace's original history: it contains an uploaded environment file.

## Run tests

```sh
cd ai-agent
npm ci
npm test
```

## Secrets

Copy `ai-agent/.env.example` to a private server-side environment file and replace its placeholders. Never commit `.env` files, access tokens, database URLs, or private keys. Credentials that were committed in an uploaded environment file must be rotated before use.
