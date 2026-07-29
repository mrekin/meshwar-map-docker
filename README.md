# MeshCore Wardrive Map — Self-Hosted (Docker)

Self-hosted version of the MeshCore wardrive coverage map. Runs locally with SQLite — no cloud dependencies.

## Differences from upstream

This is a fork of [`mintylinux/meshwar-map-docker`](https://github.com/mintylinux/meshwar-map-docker). Upstream ships a single `meshwar-map` service with a flat `.env` (`PORT`, `ALLOW_UPLOAD`, `DB_PATH`, `MAP_CENTER_*`) and JSON-only imports. On top of that, this fork adds:

- **Repeater contacts (GPX)** — browser upload (`public/js/gpx.js`) and CLI import (`tools/import-repeaters-gpx.js`) from meshcore-open GPX exports, with idempotent upsert, staleness guard, and discovery tracking. New endpoints: `GET` / `POST` / `DELETE /api/repeaters`.
- **Tile proxy & cache** (`server/tiles.js`) — on-disk tile cache with stale-while-revalidate / stale-on-error, configurable TTL, size cap, and prune interval; optional SOCKS5 upstream proxy and referer-based hotlink protection.
- **GPS outlier filter** (`server/gpsfilter.js`) — drops teleport jumps, splits multi-drive sessions by time gap, keeps the largest connected component, with optional bbox geofence and debug batch dumps.
- **Sample forwarders** (`server/forwarders.js`) — fan cleaned uploads out to other map instances in the background (fire-and-forget).
- **Configuration (YAML)** (`server/config.js`, `config/meshwar.yaml`, `config_examples/`) — behavioral settings moved to YAML with deep-merged defaults and auto-seed; `.env` reduced to `PORT`, `CONFIG_PATH`, `UPLOAD_TOKEN`.
- **Token auth** — `UPLOAD_TOKEN` guards write endpoints (timing-safe comparison), replacing upstream's boolean `ALLOW_UPLOAD`.
- **UI** — new map styles (Dark Matter / Voyager / Light Positron), a lite theme, and custom icons; plus "Hide 0% cells", repeater-edge filter, contributor filter, and auto coverage resolution.
- **Ops** — Node 24 + `node-sqlite`, multi-arch Docker CI (amd64/arm64, `.github/workflows/docker-publish.yml`), and a `.dockerignore`.

## Quick Start

### With Docker
```bash
git clone https://github.com/mintylinux/meshwar-map-docker.git
cd meshwar-map-docker
cp .env.example .env                                  # port + secret token
cp config_examples/meshwar.example.yaml config/meshwar.yaml    # behavioral settings (edit as needed)
docker-compose up -d
```

### Without Docker
```bash
git clone https://github.com/mintylinux/meshwar-map-docker.git
cd meshwar-map-docker/server
npm install
npm start
```

Open http://localhost:3000 in your browser.

## Features

- Same map interface as the community map
- SQLite backend — single-file database, no external services
- Manual import tool — vet and validate data before adding
- Contributor tracking — track who contributed what data
- Leaderboard API — per-contributor stats
- Upload control — app uploads disabled by default (security-first)
- Docker volume — database persists across restarts

## Importing Data

Input files for import go in the `imports/` directory (mounted at `/app/imports`
in the container). See [`tools/README.md`](tools/README.md) for all import tools.

### Interactive Import (Recommended)

1. Export data from the MeshCore Wardrive app (Settings > Export Data > JSON)
2. Copy the JSON file to the `imports/` directory
3. Run the import script:

```bash
bash tools/import.sh

# Or inside Docker:
docker exec -it meshwar-map bash -c "cd /app/tools && bash import.sh"
```

### Direct Import (Non-Interactive)

```bash
node tools/import.js imports/mydata.json --contributor Chuck --region WA
```

Options: `--dry-run`, `--contributor NAME`, `--region CODE`

### Repeater Contacts (GPX)

Import repeater true locations from a meshcore-open GPX export so "Show
repeaters" and "Show Edges" work on the map:

```bash
docker exec -it meshwar-map node /app/tools/import-repeaters-gpx.js \
  /app/imports/meshcore_repeaters.gpx --added-by mrekin
```

### App Upload (Optional)

Set `server.allow_upload: true` in `config/meshwar.yaml`, then add your server as
an upload endpoint in the app: `http://your-server:3000/api/samples`

Write endpoints are guarded by `UPLOAD_TOKEN` (`.env`) — pass it as `?token=...`
in the URL. Leave `UPLOAD_TOKEN` empty only on trusted networks (writes stay open).

## API Endpoints

- `GET /api/samples` — Coverage data for the map
- `POST /api/samples` — Upload samples (requires `server.allow_upload: true`)
- `GET /api/stats` — Global statistics
- `GET /api/contributors` — Contributor leaderboard
- `GET /api/repeaters` — List repeater contacts
- `POST /api/repeaters` — Import repeater contacts as JSON (requires token)
- `DELETE /api/repeaters/:nodeId` — Delete a repeater (requires token)

## Configuration

Settings are split between `.env` (port, config-file path, secret token) and
`config/meshwar.yaml` (everything else, grouped by section).

```bash
cp .env.example .env                                  # port + secret token
cp config_examples/meshwar.example.yaml config/meshwar.yaml   # behavioral settings
```

**`.env`** (gitignored) — kept minimal:
- `PORT` (default: 3000) — server port (also docker-compose host port mapping)
- `CONFIG_PATH` (default: `config/meshwar.yaml`) — path to the YAML config
- `UPLOAD_TOKEN` — secret auth token for write endpoints (`openssl rand -hex 32`); empty = writes open

**`config/meshwar.yaml`** (gitignored; `config_examples/meshwar.example.yaml` is the
tracked, fully-commented template — the app also seeds a copy into `config/` at
startup if missing). Every key has a default, so omitting the file — or any single
key — keeps the default and the app still boots. Sections:
- `server.allow_upload` — enable wardrive app direct uploads
- `map.center_lat` / `center_lon` / `zoom` — default map view
- `storage.db_path` — SQLite path (default `data/meshwar.db` → `/app/data/meshwar.db` in Docker)
- `tiles.*` — backend tile proxy: disk cache, TTL, size cap, prune interval, optional SOCKS5 upstream
- `gps_filter.*` — GPS outlier filter (speed, session splitting, bbox geofence, debug/dump)
- `forwarders` — fan filtered uploads out to other maps (`[{ name, url }]`)

See [`config_examples/meshwar.example.yaml`](config_examples/meshwar.example.yaml) for the full schema.

## Reverse Proxy

Use nginx or nginx-proxy-manager to expose on your domain with HTTPS:

```nginx
server {
    listen 443 ssl;
    server_name map.yourdomain.com;
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### Caddy

Caddy obtains and renews HTTPS certificates automatically. Minimal `Caddyfile`
(Caddy on the host → `localhost:3000`; Caddy in the same Docker network →
`meshwar-map:3000`):

```caddyfile
map.yourdomain.com {
	reverse_proxy localhost:3000

	# Stop your server from being used as a public tile CDN: block tile
	# requests coming from OTHER sites (hotlinking), allow your own site
	# and direct/no-referer access. Replace the domain with yours.
	@hotlink {
		path /tiles/*
		header Referer *
		not header Referer map.yourdomain.com
	}
	respond @hotlink 403
}
```

Stricter — also block direct/no-referer access (note: this can break tiles for
users with Referer-stripping browser extensions): drop the `header Referer *`
line, so any request whose Referer doesn't match your domain is blocked.

For a semi-private map, allow tiles only from known networks instead of by
referer:

```caddyfile
map.yourdomain.com {
	@tiles path /tiles/*
	handle @tiles {
		@allowed remote_ip 10.0.0.0/8 192.168.0.0/16 172.16.0.0/12
		handle @allowed {
			reverse_proxy localhost:3000
		}
		respond 403
	}
	handle {
		reverse_proxy localhost:3000
	}
}
```

> Edge protection only works if Caddy is the sole entry point — don't expose
> port 3000 directly to the internet.

## Data Storage

Database: `data/meshwar.db` (SQLite, persisted via Docker volume)

Archived imports: `data/processed/2026-04-15-Chuck-WA-342pings.json`

## License

MIT
