# Tools

Import utilities for the MeshCore Wardrive Map. All commands below run
**inside the container** via `docker exec`.

## Where to put input files

Drop your export files (`.json`, `.gpx`) into the host `./imports/` folder — it
is mounted into the container at `/app/imports`. Keep `./tools/` for the tools
themselves (on first start they are seeded from the image if missing).

> Replace `meshwar-map` with your `container_name` if you changed it in
> `docker-compose.yml`.

---

## import.js — wardrive samples (JSON export)

Import coverage pings exported from the MeshCore Wardrive app
(Settings → Export Data → JSON).

```bash
docker exec -it meshwar-map node /app/tools/import.js /app/imports/mydata.json \
  --contributor Chuck --region WA
```

Options:
- `--dry-run` — validate only, do not write to the database.
- `--contributor NAME` — who collected the data.
- `--region CODE` — region code (e.g. `WA`, `NSW`).

## import.sh — interactive samples import

Prompts for contributor, date, region; validates (dry-run); imports; archives
the file to `data/processed/`. Place **one** `.json` file in `./imports/` first.

```bash
docker exec -it meshwar-map bash -c "cd /app/tools && bash import.sh"
```

## import-repeaters.js — repeater contacts (JSON)

Import true repeater locations (node_id → lat/lon) for the "Show repeaters" and
"Show Edges" map layers.

```bash
docker exec -it meshwar-map node /app/tools/import-repeaters.js \
  /app/imports/repeaters.json --added-by mrekin
```

JSON format:
```json
[
  { "node_id": "BAD5DC49", "name": "Hilltop Repeater", "lat": 55.75, "lon": 37.61 },
  ...
]
```

## import-repeaters-gpx.js — repeaters from GPX (meshcore-open export)

Import repeaters from a GPX file produced by the meshcore-open exporter.

```bash
docker exec -it meshwar-map node /app/tools/import-repeaters-gpx.js \
  /app/imports/meshcore_repeaters.gpx --added-by mrekin
```

- Imports only `Type: Repeater` waypoints (`Type: Room` is skipped).
- `node_id` is derived from the first 8 hex chars of the repeater's public key
  (uppercase) — matches the wardrive-app convention, so edge lines link correctly.
- Idempotent: re-running updates existing rows, no duplicates.
- `--added-by NAME` is optional (defaults to `gpx-import`).

---

## Notes

- After importing repeaters, **reload the map page** — `/api/repeaters` is
  fetched on page load, so markers/edges appear after refresh.
- All repeater imports are idempotent (upsert by `node_id`).
- Entries without coordinates, at `(0,0)`, or out of range are skipped silently.
