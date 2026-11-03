# Private VPS staging with Docker Compose

`compose.yaml` is a staging deployment, not the public production configuration.
It uses pinned Node 24 and PostgreSQL 16 images, a private database network, an
isolated persistent database volume, and a web port bound only to
`127.0.0.1:3101`.

The database uses PostgreSQL trust authentication only because it has no published
port, is on an internal Docker network, and contains no production data. Do not
reuse this setting for a publicly reachable or production database. Add production
database credentials, configure an approved HTTPS hostname, and migrate and verify
production data before any live cutover.

No NVIDIA or Telegram credentials are passed to this stage. In particular, do not
set `TELEGRAM_BOT_TOKEN`: starting with the production bot token changes its
Telegram webhook. The existing Replit deployment stays untouched.

From the repository root on the VPS:

```sh
docker compose -f compose.yaml up -d --build
docker compose -f compose.yaml ps
curl --fail http://127.0.0.1:3101/health/live
curl --fail http://127.0.0.1:3101/health/ready
```

The site is not public through Nginx. Use an SSH tunnel to view it:

```sh
ssh -L 3101:127.0.0.1:3101 YOUR_VPS_USER@YOUR_VPS_HOST
```

To stop only this stage and preserve its database volume:

```sh
docker compose -f compose.yaml down
```

Do not add `-v` or use Docker prune commands when stopping the stage.
