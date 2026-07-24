// MeshCore Repeater GPX parser (browser-side).
// Ported verbatim from tools/import-repeaters-gpx.js (decodeEntities / cleanName
// / parseGpx) — pure JS, no Node deps. Exposed as globals so the plain <script>
// loading style used by app.js can call parseGpx(text).
//
// GPX format (meshcore-open exporter): <wpt lat=".." lon=".."> waypoints with
//   <name>..</name> and <desc>Type: <Type> Public Key: <64hex></desc>
// Only "Type: Repeater" waypoints are importable. node_id = first 8 hex chars of
// the public key (uppercase) — matches the wardrive-app upload convention so
// edge lines link to the right coverage cells.

// Minimal XML entity decoder (names/desc may contain entities; CDATA unsupported).
function decodeEntities(s) {
    if (s == null) return s;
    return String(s)
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

// Decode entities, strip C0/DEL control chars, trim. The meshcore-open exporter
// encodes nameless repeaters as e.g. "&#x1;"; return null so the frontend falls
// back to node_id instead of rendering a control char.
function cleanName(s) {
    const decoded = decodeEntities(s);
    if (!decoded) return null;
    const cleaned = decoded.replace(/[\x00-\x1F\x7F]/g, '').trim();
    return cleaned || null;
}

// Parse GPX text -> { repeaters, stats }. Pure, no I/O.
function parseGpx(xmlText) {
    const repeaters = [];
    const stats = { waypoints: 0, repeaters: 0, rooms: 0, noKey: 0, malformed: 0 };

    const blockRe = /<wpt\b[^>]*>([\s\S]*?)<\/wpt>/g;
    const latRe = /<wpt\b[^>]*?\slat\s*=\s*["']([^"']+)["']/i;
    const lonRe = /<wpt\b[^>]*?\slon\s*=\s*["']([^"']+)["']/i;
    const nameRe = /<name>([^<]*)<\/name>/;
    const descRe = /<desc>([^<]*)<\/desc>/;
    const typeRe = /Type:\s*([A-Za-z0-9_-]+)/;
    const keyRe = /Public Key:\s*([0-9a-fA-F]{64})/;

    let m;
    while ((m = blockRe.exec(xmlText)) !== null) {
        const full = m[0];   // whole <wpt ...> ... </wpt> (for lat/lon on opening tag)
        const inner = m[1];  // children only (name/desc)
        stats.waypoints++;

        const lat = parseFloat((latRe.exec(full) || [])[1]);
        const lon = parseFloat((lonRe.exec(full) || [])[1]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) { stats.malformed++; continue; }

        const name = cleanName((nameRe.exec(inner) || [])[1]);
        const desc = decodeEntities((descRe.exec(inner) || [, ''])[1]);

        const type = (typeRe.exec(desc) || [])[1];
        if (type !== 'Repeater') { stats.rooms++; continue; }  // Room and any other type

        const pubkey = (keyRe.exec(desc) || [])[1];
        if (!pubkey) { stats.noKey++; continue; }

        repeaters.push({
            node_id: pubkey.substring(0, 8).toUpperCase(),
            latitude: lat,
            longitude: lon,
            name,
            elevation: null,
        });
        stats.repeaters++;
    }

    return { repeaters, stats };
}

window.decodeEntities = decodeEntities;
window.cleanName = cleanName;
window.parseGpx = parseGpx;
