# MeshCore Wardrive Map — Self-Hosted (Docker)

Self-hosted version of the MeshCore wardrive coverage map. Runs locally with SQLite — no cloud dependencies.

## Quick Start

### With Docker
```bash
git clone https://github.com/mintylinux/meshwar-map-docker.git
cd meshwar-map-docker
cp .env.example .env    # Create your config (edit as needed)
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

#### Automate via Node-RED (test)

Import repeaters automatically from a Telegram bot: send a `.gpx` file to the
bot and it parses and posts to `POST /api/repeaters`. A ready-to-import flow and
setup instructions are in [`nodered/`](nodered/README.md).

### App Upload (Optional)

Set `ALLOW_UPLOAD=true` in docker-compose.yml, then add your server as an upload endpoint in the app: `http://your-server:3000/api/samples`

Only enable on trusted networks — there is no authentication.

## API Endpoints

- `GET /api/samples` — Coverage data for the map
- `POST /api/samples` — Upload samples (requires ALLOW_UPLOAD=true)
- `GET /api/stats` — Global statistics
- `GET /api/contributors` — Contributor leaderboard
- `GET /api/repeaters` — List repeater contacts
- `POST /api/repeaters` — Import repeater contacts as JSON (requires token)
- `DELETE /api/repeaters/:nodeId` — Delete a repeater (requires token)

## Configuration

All settings are in `.env` (not tracked by git — safe to customize without merge conflicts):

```bash
cp .env.example .env   # First time setup
```

- `PORT` (default: 3000) — Server port
- `ALLOW_UPLOAD` (default: false) — Enable app uploads
- `DB_PATH` (default: /app/data/meshwar.db) — Database path
- `MAP_CENTER_LAT` / `MAP_CENTER_LON` — Default map center
- `MAP_ZOOM` — Default zoom level

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

## Data Storage

Database: `data/meshwar.db` (SQLite, persisted via Docker volume)

Archived imports: `data/processed/2026-04-15-Chuck-WA-342pings.json`

## License

MIT
