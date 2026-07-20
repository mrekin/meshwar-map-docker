// MeshCore Wardrive Map - Main Application
// ==========================================

// ---------------------
// Theme management
// ---------------------
let isDarkTheme = true;
let tileLayer = null;

const savedTheme = localStorage.getItem('mapTheme') || 'dark';
if (savedTheme === 'light') {
    isDarkTheme = false;
    document.body.classList.add('light-theme');
}

function toggleTheme() {
    isDarkTheme = !isDarkTheme;
    document.body.classList.toggle('light-theme');
    updateThemeIcon();
    updateMapTiles();
    localStorage.setItem('mapTheme', isDarkTheme ? 'dark' : 'light');
}

function toggleInfoPanel() {
    document.getElementById('info-panel').classList.toggle('hidden');
}

function toggleToolsPanel() {
    document.getElementById('measure-control').classList.toggle('hidden');
}

function updateThemeIcon() {
    document.getElementById('theme-icon').textContent = isDarkTheme ? '☀️' : '🌙';
}

function updateMapTiles() {
    if (tileLayer) map.removeLayer(tileLayer);

    if (isDarkTheme) {
        tileLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
            subdomains: 'abcd',
            maxZoom: 19
        });
    } else {
        tileLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
            maxZoom: 19
        });
    }

    tileLayer.addTo(map);
}

// ---------------------
// Initialize map (Canvas renderer for performance)
// ---------------------
const map = L.map('map', {
    center: [47.6062, -122.3321],
    zoom: 10,
    preferCanvas: true,
    worldCopyJump: false,
    maxBounds: [[-90, -180], [90, 180]],
    maxBoundsViscosity: 1.0,
    zoomControl: false
});

L.control.zoom({ position: 'bottomleft' }).addTo(map);

// Center map: try server config first, then browser geolocation, then default (Seattle)
fetch('/api/config').then(r => r.json()).then(cfg => {
    map.setView(cfg.center, cfg.zoom);
}).catch(() => {});
if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
        (pos) => map.setView([pos.coords.latitude, pos.coords.longitude], 12),
        () => {}
    );
}

// Popup scroll handling
map.on('popupopen', (e) => {
    const el = e.popup.getElement()?.querySelector('.leaflet-popup-content');
    if (el) {
        L.DomEvent.disableScrollPropagation(el);
        L.DomEvent.disableClickPropagation(el);
    }
    e.popup.options.autoPan = true;
    e.popup.options.autoPanPaddingTopLeft = [16, 64];
    e.popup.options.autoPanPaddingBottomRight = [16, 64];
});

updateMapTiles();
updateThemeIcon();

// ---------------------
// Layer groups
// ---------------------
const coverageLayer = L.layerGroup().addTo(map);
const repeaterLayer = L.layerGroup();
const edgeLayer = L.layerGroup();
const heatmapLayer = L.layerGroup(); // Not added by default
const measureLayer = L.layerGroup().addTo(map);

// ---------------------
// State
// ---------------------
let cachedCoverage = null;      // Raw coverage data from API (precision 7)
let currentETag = null;         // ETag for conditional requests
let visibleRectangles = {};     // Map of hash -> L.rectangle currently on screen
let coveragePrecision = 6;      // User-selected display precision
let showRepeaters = false;
let showEdges = false;
let showHeatmap = false;
let renderPending = false;      // Debounce flag for viewport rendering

// Time-lapse state
let timelapseActive = false;
let timelapseDate = null;       // Current slider date (null = show all)
let timelapseInterval = null;   // Animation interval
let timelapseMinDate = null;
let timelapseMaxDate = null;

// Measure tool state
let measureActive = false;
let measurePoints = [];
let measureUnit = 'km';
let measureMarkers = [];
let measureLine = null;

// Shard state (KV sharding)
let shardIndex = {};            // { prefix: { cells, samples, lastUpdate, version } }
let cachedShardVersions = {};   // { prefix: version } - tracks fetched shard versions
let shardLoadPending = false;   // Prevents concurrent shard loads

// Expiry: cells older than this are not rendered
const EXPIRY_DAYS = 90;

// Time filter state (0 = all, N = last N days)
let timeFilterDays = 0;
let activeContributor = '';

// Repeater contacts
let repeaterContacts = [];

// Repeater whitelist filter (empty = show all)
let activeRepeaterFilter = '';

// ---------------------
// Utility functions
// ---------------------
function geohashToBounds(hash) {
    const b = Geohash.bounds(hash);
    return [[b.sw.lat, b.sw.lon], [b.ne.lat, b.ne.lon]];
}

function ageInDays(timestamp) {
    return Math.floor((Date.now() - new Date(timestamp).getTime()) / (1000 * 60 * 60 * 24));
}

function getCoverageColor(received, lost) {
    const total = received + lost;
    if (total === 0) return '#cccccc';

    const rate = received / total;
    if (rate >= 0.80) return '#00ff00';
    if (rate >= 0.50) return '#88ff00';
    if (rate >= 0.30) return '#ffff00';
    if (rate >= 0.10) return '#ffaa00';
    return '#ff0000';
}

function getFreshnessStatus(daysOld) {
    if (daysOld <= 7) {
        return { label: '🟢 Live Coverage', color: '#00ff00', opacity: 1.0, dashArray: null };
    } else if (daysOld <= 30) {
        return { label: `🟡 Recent Coverage (${daysOld} days ago)`, color: '#ffff00', opacity: 0.8, dashArray: null };
    }
    return { label: `⚪ Last Known Coverage (${daysOld} days ago)`, color: '#888888', opacity: 0.6, dashArray: '5, 5' };
}

// Get appropriate precision for current zoom level
function getPrecisionForZoom(zoom) {
    if (zoom < 8) return 4;     // ~20km cells at country/regional zoom
    if (zoom < 10) return 5;    // ~5km cells at regional zoom
    if (zoom <= 12) return 6;   // ~1.2km cells at city zoom
    return 7;                   // ~153m cells when zoomed in
}

// Effective display precision: follows zoom in "Auto" mode, otherwise the
// user-selected value. Replaces direct reads of the resolution selector.
function getEffectivePrecision() {
    const selector = document.getElementById('resolution-selector');
    if (!selector || selector.value === 'auto') return getPrecisionForZoom(map.getZoom());
    return parseInt(selector.value);
}

// ---------------------
// Viewport-based rendering
// ---------------------
function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => {
        renderPending = false;
        renderVisibleCoverage();
    });
}

function renderVisibleCoverage() {
    if (!cachedCoverage) return;

    const mapBounds = map.getBounds();
    const zoom = map.getZoom();
    const targetPrecision = getEffectivePrecision();

    // Re-aggregate at target precision (Auto mode follows zoom; manual = selected value)
    const aggregated = aggregateAtPrecision(cachedCoverage, targetPrecision);

    // Clear existing rectangles
    coverageLayer.clearLayers();
    visibleRectangles = {};

    let visibleCount = 0;

    Object.entries(aggregated).forEach(([hash, cell]) => {
        // Time-lapse filter
        if (timelapseActive && timelapseDate) {
            const cellDate = new Date(cell.lastUpdate);
            if (cellDate > timelapseDate) return;
        }

        // Expiry filter: hide cells older than 90 days
        if (ageInDays(cell.lastUpdate) > EXPIRY_DAYS) return;

        // Time filter: hide cells older than selected period
        if (timeFilterDays > 0 && ageInDays(cell.lastUpdate) > timeFilterDays) return;

        // Skip cells with no actual ping data (GPS-only uploads)
        if ((cell.received + cell.lost) === 0) return;

        const bounds = geohashToBounds(hash);
        const cellBounds = L.latLngBounds(bounds);

        // Viewport culling: skip cells not visible on screen
        if (!mapBounds.intersects(cellBounds)) return;

        visibleCount++;
        const daysOld = ageInDays(cell.lastUpdate);
        const freshness = getFreshnessStatus(daysOld);
        const color = getCoverageColor(cell.received, cell.lost);

        const rectangle = L.rectangle(bounds, {
            color: color,
            fillColor: color,
            weight: 2,
            opacity: freshness.opacity,
            fillOpacity: freshness.opacity * 0.3,
            dashArray: freshness.dashArray
        });

        const successRate = cell.received + cell.lost > 0
            ? ((cell.received / (cell.received + cell.lost)) * 100).toFixed(1)
            : 0;

        // Build repeaters popup HTML
        let repeatersHtml = 'None';
        if (cell.repeaters && typeof cell.repeaters === 'object') {
            const repeaterList = Object.values(cell.repeaters).map(rep => {
                const escapedName = (rep.name || 'Unknown').replace(/'/g, "\\'");
                return `<span class="repeater-link" onclick="showRepeaterInfo('${escapedName}', ${rep.rssi}, ${rep.snr}, '${rep.lastSeen}')" title="Click for details">${rep.name}</span>`;
            });
            if (repeaterList.length > 0) repeatersHtml = repeaterList.join(', ');
        }

        rectangle.bindPopup(`
            <div class="popup-content">
                <div style="color: ${freshness.color}; font-weight: bold; margin-bottom: 8px;">
                    ${freshness.label}
                </div>
                <div><span class="popup-label">Success Rate:</span> ${successRate}%</div>
                <div><span class="popup-label">Received:</span> ${Math.round(cell.received)}</div>
                <div><span class="popup-label">Lost:</span> ${Math.round(cell.lost)}</div>
                <div><span class="popup-label">Samples:</span> ${cell.samples}</div>
                <div><span class="popup-label">Repeaters:</span> ${repeatersHtml}</div>
                <div style="font-size: 10px; color: #888; margin-top: 4px;">Click repeater name for signal details</div>
                <div><span class="popup-label">Last Update:</span> ${new Date(cell.lastUpdate).toLocaleDateString()}</div>
                ${cell.appVersion ? `<div><span class="popup-label">App Version:</span> ${cell.appVersion}</div>` : ''}
            </div>
        `);

        coverageLayer.addLayer(rectangle);
        visibleRectangles[hash] = rectangle;
    });

    console.log(`Rendered ${visibleCount} cells at precision ${targetPrecision} (${Object.keys(aggregated).length} total)`);

    // Update heatmap if active
    if (showHeatmap) updateHeatmap(aggregated);

    // Update edge lines if active
    if (showEdges) updateEdgeLines(aggregated);
}

// Re-aggregate coverage cells from precision 7 to a target precision
function aggregateAtPrecision(coverage, targetPrecision) {
    if (targetPrecision === 7) return coverage; // Already at storage precision

    const aggregated = {};

    Object.entries(coverage).forEach(([hash, cell]) => {
        // Expiry filter: skip cells older than 90 days
        if (ageInDays(cell.lastUpdate) > EXPIRY_DAYS) return;

        // Skip cells with no actual ping data
        if ((cell.received + cell.lost) === 0) return;

        // Time-lapse filter for aggregation
        if (timelapseActive && timelapseDate) {
            const cellDate = new Date(cell.lastUpdate);
            if (cellDate > timelapseDate) return;
        }

        const center = Geohash.center(hash);
        const newHash = Geohash.encode(center.lat, center.lon, targetPrecision);

        if (!aggregated[newHash]) {
            aggregated[newHash] = {
                received: 0, lost: 0, samples: 0,
                repeaters: {},
                lastUpdate: cell.lastUpdate,
                appVersion: cell.appVersion || 'unknown'
            };
        }

        const agg = aggregated[newHash];
        agg.received += cell.received || 0;
        agg.lost += cell.lost || 0;
        agg.samples += cell.samples || 0;

        // Merge repeaters (keep best signal per repeater)
        if (cell.repeaters && typeof cell.repeaters === 'object') {
            Object.entries(cell.repeaters).forEach(([nodeId, rep]) => {
                const existing = agg.repeaters[nodeId];
                if (!existing || (rep.lastSeen || '') > (existing.lastSeen || '')) {
                    agg.repeaters[nodeId] = rep;
                }
            });
        }

        // Keep most recent version info
        if (cell.appVersion && cell.appVersion !== 'unknown') {
            if (agg.appVersion === 'unknown' || cell.lastUpdate > agg.lastUpdate) {
                agg.appVersion = cell.appVersion;
            }
        }
        if (cell.lastUpdate > agg.lastUpdate) {
            agg.lastUpdate = cell.lastUpdate;
        }
    });

    return aggregated;
}

// ---------------------
// Heatmap layer
// ---------------------
let heatLayer = null;

function toggleHeatmapLayer() {
    showHeatmap = document.getElementById('toggle-heatmap').checked;
    if (showHeatmap) {
        map.addLayer(heatmapLayer);
        if (cachedCoverage) {
            const aggregated = aggregateAtPrecision(cachedCoverage, getEffectivePrecision());
            updateHeatmap(aggregated);
        }
    } else {
        map.removeLayer(heatmapLayer);
        if (heatLayer) {
            heatmapLayer.removeLayer(heatLayer);
            heatLayer = null;
        }
    }
}

function updateHeatmap(aggregated) {
    if (!showHeatmap) return;

    // Remove old heat layer
    if (heatLayer) {
        heatmapLayer.removeLayer(heatLayer);
        heatLayer = null;
    }

    const heatData = [];
    const mapBounds = map.getBounds();

    Object.entries(aggregated).forEach(([hash, cell]) => {
        const center = Geohash.center(hash);

        // Viewport culling
        if (!mapBounds.contains([center.lat, center.lon])) return;

        const total = cell.received + cell.lost;
        if (total === 0) return;

        // Intensity based on success rate (0-1)
        const intensity = cell.received / total;
        heatData.push([center.lat, center.lon, intensity]);
    });

    if (heatData.length > 0 && typeof L.heatLayer === 'function') {
        heatLayer = L.heatLayer(heatData, {
            radius: 25,
            blur: 15,
            maxZoom: 17,
            max: 1.0,
            gradient: {
                0.0: '#ff0000',
                0.25: '#ffaa00',
                0.5: '#ffff00',
                0.75: '#88ff00',
                1.0: '#00ff00'
            }
        });
        heatmapLayer.addLayer(heatLayer);
    }
}

// ---------------------
// Repeater markers
// ---------------------
function toggleRepeaterLayer() {
    showRepeaters = document.getElementById('toggle-repeaters').checked;
    if (showRepeaters) {
        map.addLayer(repeaterLayer);
        updateRepeaterContactMarkers();
    } else {
        map.removeLayer(repeaterLayer);
    }
}

function toggleEdgeLayer() {
    showEdges = document.getElementById('toggle-edges').checked;
    if (showEdges) {
        map.addLayer(edgeLayer);
        if (cachedCoverage) {
            const aggregated = aggregateAtPrecision(cachedCoverage, getEffectivePrecision());
            updateEdgeLines(aggregated);
        }
    } else {
        map.removeLayer(edgeLayer);
    }
}

// Build edge lines from repeater contact positions to coverage cells they were heard in
function updateEdgeLines(aggregated) {
    edgeLayer.clearLayers();
    if (!showEdges || repeaterContacts.length === 0) return;

    const mapBounds = map.getBounds();

    // Build a lookup of repeater contacts by node_id prefix (first 8 chars uppercase)
    const contactLookup = {};
    repeaterContacts.forEach(rep => {
        const key = (rep.node_id.length > 8 ? rep.node_id.substring(0, 8) : rep.node_id).toUpperCase();
        contactLookup[key] = rep;
    });

    let edgeCount = 0;

    Object.entries(aggregated).forEach(([hash, cell]) => {
        if (!cell.repeaters || typeof cell.repeaters !== 'object') return;

        const cellCenter = Geohash.center(hash);

        Object.keys(cell.repeaters).forEach(nodeId => {
            // Repeater whitelist filter: only show edges for the selected repeater
            if (activeRepeaterFilter && nodeId !== activeRepeaterFilter) return;

            const contact = contactLookup[nodeId];
            if (!contact) return;

            // Skip if both endpoints are outside the viewport
            const repPos = [contact.latitude, contact.longitude];
            const cellPos = [cellCenter.lat, cellCenter.lon];
            if (!mapBounds.contains(repPos) && !mapBounds.contains(cellPos)) return;

            // Skip 0,0 repeater positions
            if (contact.latitude === 0 && contact.longitude === 0) return;

            const line = L.polyline([repPos, cellPos], {
                color: '#bb86fc',
                weight: 1.5,
                opacity: 0.4,
                dashArray: '4, 6',
            });

            edgeLayer.addLayer(line);
            edgeCount++;
        });
    });

    console.log(`Drew ${edgeCount} edge lines`);
}

// ---------------------
// Time-lapse
// ---------------------
function toggleTimelapse() {
    timelapseActive = !timelapseActive;
    const control = document.getElementById('timelapse-control');
    const btn = document.getElementById('timelapse-toggle-btn');

    if (timelapseActive) {
        control.classList.add('show');
        btn.textContent = '⏹ Stop Time-lapse';
        initTimelapse();
    } else {
        control.classList.remove('show');
        btn.textContent = '⏱ Time-lapse';
        stopTimelapseAnimation();
        timelapseDate = null;
        scheduleRender();
    }
}

function initTimelapse() {
    if (!cachedCoverage) return;

    // Find date range from coverage data
    let minTime = Infinity, maxTime = 0;
    Object.values(cachedCoverage).forEach(cell => {
        const t = new Date(cell.lastUpdate).getTime();
        if (t < minTime) minTime = t;
        if (t > maxTime) maxTime = t;
    });

    timelapseMinDate = new Date(minTime);
    timelapseMaxDate = new Date(maxTime);

    const slider = document.getElementById('timelapse-slider');
    slider.min = 0;
    slider.max = 100;
    slider.value = 100;

    timelapseDate = timelapseMaxDate;
    updateTimelapseDisplay();
    scheduleRender();
}

function onTimelapseSliderChange() {
    const slider = document.getElementById('timelapse-slider');
    const pct = parseInt(slider.value) / 100;

    const minT = timelapseMinDate.getTime();
    const maxT = timelapseMaxDate.getTime();
    timelapseDate = new Date(minT + (maxT - minT) * pct);

    updateTimelapseDisplay();
    scheduleRender();
}

function updateTimelapseDisplay() {
    const dateEl = document.getElementById('timelapse-date');
    if (timelapseDate) {
        dateEl.textContent = timelapseDate.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    }
}

function playTimelapse() {
    if (timelapseInterval) {
        stopTimelapseAnimation();
        return;
    }

    const slider = document.getElementById('timelapse-slider');
    const playBtn = document.getElementById('timelapse-play-btn');
    playBtn.textContent = '⏸ Pause';
    playBtn.classList.add('active');

    // Start from beginning if at end
    if (parseInt(slider.value) >= 100) slider.value = 0;

    timelapseInterval = setInterval(() => {
        let val = parseInt(slider.value) + 1;
        if (val > 100) {
            stopTimelapseAnimation();
            return;
        }
        slider.value = val;
        onTimelapseSliderChange();
    }, 200);
}

function stopTimelapseAnimation() {
    if (timelapseInterval) {
        clearInterval(timelapseInterval);
        timelapseInterval = null;
    }
    const playBtn = document.getElementById('timelapse-play-btn');
    if (playBtn) {
        playBtn.textContent = '▶ Play';
        playBtn.classList.remove('active');
    }
}

function resetTimelapse() {
    stopTimelapseAnimation();
    const slider = document.getElementById('timelapse-slider');
    slider.value = 100;
    timelapseDate = timelapseMaxDate;
    updateTimelapseDisplay();
    scheduleRender();
}

// ---------------------
// Shard-aware data loading
// ---------------------

// Determine which 3-char geohash prefixes are visible in the current viewport
function getVisiblePrefixes() {
    const bounds = map.getBounds();
    const visible = [];

    Object.keys(shardIndex).forEach(prefix => {
        try {
            const b = Geohash.bounds(prefix);
            const prefixBounds = L.latLngBounds([b.sw.lat, b.sw.lon], [b.ne.lat, b.ne.lon]);
            if (bounds.intersects(prefixBounds)) {
                visible.push(prefix);
            }
        } catch(e) {
            visible.push(prefix); // Include if bounds check fails
        }
    });

    return visible;
}

// Fetch specific shard prefixes from the API
async function loadShardData(prefixList) {
    if (prefixList.length === 0) return;
    if (!cachedCoverage) cachedCoverage = {};

    try {
        const resp = await fetch(`/api/samples?prefixes=${prefixList.join(',')}`);
        if (!resp.ok) {
            console.error('Failed to load shards:', resp.status);
            return;
        }

        const data = await resp.json();
        if (!data.coverage) return;

        // Merge into cached coverage
        Object.entries(data.coverage).forEach(([hash, cell]) => {
            cachedCoverage[hash] = cell;
        });

        // Mark these prefixes as fetched at current version
        prefixList.forEach(p => {
            if (shardIndex[p]) {
                cachedShardVersions[p] = shardIndex[p].version;
            }
        });
    } catch(e) {
        console.error('Error loading shard data:', e);
    }
}

// Load visible shards that are new or have changed
async function loadVisibleShards() {
    const visible = getVisiblePrefixes();
    const toFetch = visible.filter(p => {
        const remote = shardIndex[p];
        const cached = cachedShardVersions[p];
        return remote && (cached === undefined || cached !== remote.version);
    });

    if (toFetch.length === 0) return false;

    await loadShardData(toFetch);
    return true;
}

// Update stats from cached coverage data
function updateStatsFromCoverage() {
    if (!cachedCoverage) return;

    const uniqueNodes = new Set();
    let totalSamples = 0;

    Object.values(cachedCoverage).forEach(cell => {
        if (cell.repeaters && typeof cell.repeaters === 'object') {
            Object.keys(cell.repeaters).forEach(nodeId => uniqueNodes.add(nodeId.substring(0, 2)));
        }
        totalSamples += cell.samples || 0;
    });

    document.getElementById('total-samples').textContent = totalSamples.toLocaleString();
    document.getElementById('unique-nodes').textContent = uniqueNodes.size;
    document.getElementById('last-update').textContent = new Date().toLocaleString();
}

// Update node count from loaded data
function updateNodeCount() {
    const uniqueNodes = new Set();
    Object.values(cachedCoverage).forEach(cell => {
        if (cell.repeaters && typeof cell.repeaters === 'object') {
            Object.keys(cell.repeaters).forEach(nodeId => uniqueNodes.add(nodeId.substring(0, 2)));
        }
    });
    document.getElementById('unique-nodes').textContent = uniqueNodes.size;
}

// Handle viewport changes — load new shards as user pans/zooms
async function onViewportChange() {
    scheduleRender();

    if (Object.keys(shardIndex).length > 0 && !shardLoadPending) {
        shardLoadPending = true;
        try {
            const loaded = await loadVisibleShards();
            if (loaded) {
                updateNodeCount();
                scheduleRender();
            }
        } finally {
            shardLoadPending = false;
        }
    }
}

// ---------------------
// Data loading with ETag caching (shard-aware)
// ---------------------
async function loadData() {
    try {
        const headers = {};
        if (currentETag) {
            headers['If-None-Match'] = currentETag;
        }

        let url = '/api/samples';
        if (activeContributor) url += `?contributor=${encodeURIComponent(activeContributor)}`;
        const response = await fetch(url, { headers });

        // 304 Not Modified — data hasn't changed
        if (response.status === 304) {
            console.log('Data unchanged (304)');
            return;
        }

        // Save ETag for next request
        const etag = response.headers.get('ETag');
        if (etag) currentETag = etag;

        const data = await response.json();
        document.getElementById('loading').style.display = 'none';

        // --- Legacy format (pre-migration) ---
        if (data.coverage) {
            cachedCoverage = data.coverage;
            updateStatsFromCoverage();
            populateRepeaterFilter();
            if (timelapseActive) initTimelapse();
            scheduleRender();
            return;
        }

        // --- Sharded format ---
        if (data.shards) {
            shardIndex = data.shards;

            // Show stats from index metadata immediately
            document.getElementById('total-samples').textContent = (data.totalSamples || 0).toLocaleString();
            document.getElementById('last-update').textContent = new Date().toLocaleString();

            // Load visible shards
            await loadVisibleShards();

            // Update node count from actual loaded data
            updateNodeCount();

    if (document.getElementById('toggle-repeaters').checked) {
        showRepeaters = true;
        updateRepeaterContactMarkers();
    }
    if (document.getElementById('toggle-edges').checked) {
        showEdges = true;
        updateEdgeLines(aggregateAtPrecision(cachedCoverage, getEffectivePrecision()));
    }

            if (timelapseActive) initTimelapse();
            scheduleRender();
            return;
        }

        console.log('No coverage data found');

    } catch (error) {
        console.error('Error loading data:', error);
        document.getElementById('loading').textContent = 'Error loading data. Check console.';
    }
}

// ---------------------
// Resolution change handler
// ---------------------
function changeResolution() {
    coveragePrecision = getEffectivePrecision();
    scheduleRender();
}

// ---------------------
// Map event handlers for viewport rendering
// ---------------------
map.on('moveend', onViewportChange);
map.on('zoomend', onViewportChange);

// ---------------------
// Toggle functions
// ---------------------
function toggleCoverage() {
    if (document.getElementById('toggle-coverage').checked) {
        map.addLayer(coverageLayer);
    } else {
        map.removeLayer(coverageLayer);
    }
}

// ---------------------
// Measure tool
// ---------------------
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

function convertDistance(distanceKm) {
    switch(measureUnit) {
        case 'mi': return distanceKm * 0.621371;
        case 'm': return distanceKm * 1000;
        case 'ft': return distanceKm * 3280.84;
        default: return distanceKm;
    }
}

function formatDistance(distanceKm) {
    const converted = convertDistance(distanceKm);
    const formatted = (measureUnit === 'm' || measureUnit === 'ft')
        ? Math.round(converted).toLocaleString()
        : converted.toFixed(2);
    return `${formatted} ${measureUnit}`;
}

function updateMeasureDisplay() {
    if (measurePoints.length === 2) {
        const distance = calculateDistance(
            measurePoints[0].lat, measurePoints[0].lng,
            measurePoints[1].lat, measurePoints[1].lng
        );
        document.getElementById('measure-distance').textContent = formatDistance(distance);
        document.getElementById('measure-info').classList.add('show');
    } else {
        document.getElementById('measure-info').classList.remove('show');
    }
}

function toggleMeasure() {
    measureActive = !measureActive;
    const btn = document.getElementById('measure-btn');

    if (measureActive) {
        btn.classList.add('active');
        btn.textContent = '✕ Cancel Measure';
        map.getContainer().style.cursor = 'crosshair';
    } else {
        btn.classList.remove('active');
        btn.textContent = '📏 Measure Distance';
        map.getContainer().style.cursor = '';
        clearMeasure();
    }
}

function clearMeasure() {
    measurePoints = [];
    measureMarkers.forEach(marker => measureLayer.removeLayer(marker));
    measureMarkers = [];
    if (measureLine) {
        measureLayer.removeLayer(measureLine);
        measureLine = null;
    }
    updateMeasureDisplay();
}

function setUnit(unit) {
    measureUnit = unit;
    document.querySelectorAll('.unit-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.unit === unit);
    });
    updateMeasureDisplay();
}

map.on('click', function(e) {
    if (!measureActive) return;

    if (measurePoints.length < 2) {
        measurePoints.push(e.latlng);

        const marker = L.circleMarker(e.latlng, {
            radius: 6, fillColor: '#00e676', color: '#fff',
            weight: 2, opacity: 1, fillOpacity: 1
        });

        const label = measurePoints.length === 1 ? 'Point A' : 'Point B';
        marker.bindPopup(label).openPopup();
        measureMarkers.push(marker);
        measureLayer.addLayer(marker);

        if (measurePoints.length === 2) {
            measureLine = L.polyline(measurePoints, {
                color: '#00e676', weight: 3, opacity: 0.8, dashArray: '10, 5'
            });
            measureLayer.addLayer(measureLine);
            updateMeasureDisplay();
        }
    }
});

// ---------------------
// Modal functions
// ---------------------
let __scrollLockY = 0;

function lockPageScroll() {
    __scrollLockY = window.scrollY || window.pageYOffset || 0;
    document.body.style.position = 'fixed';
    document.body.style.top = `-${__scrollLockY}px`;
    document.body.style.left = '0';
    document.body.style.right = '0';
    document.body.style.width = '100%';
    document.body.classList.add('modal-open');
}

function unlockPageScroll() {
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.left = '';
    document.body.style.right = '';
    document.body.style.width = '';
    document.body.classList.remove('modal-open');
    window.scrollTo(0, __scrollLockY);
}

function closeModal(event) {
    if (!event || event.target.id === 'signal-modal') {
        document.getElementById('signal-modal').classList.remove('show');
        unlockPageScroll();
        try {
            map.dragging.enable();
            map.touchZoom.enable();
            map.doubleClickZoom.enable();
            map.boxZoom.enable();
            map.keyboard.enable();
        } catch(e) {}
    }
}

function lockMapAndScroll() {
    try {
        map.closePopup();
        map.dragging.disable();
        map.touchZoom.disable();
        map.doubleClickZoom.disable();
        map.boxZoom.disable();
        map.keyboard.disable();
    } catch(e) {}
    lockPageScroll();
    document.body.classList.add('modal-open');
}

function showRepeaterInfo(name, rssi, snr, lastSeen) {
    lockMapAndScroll();

    document.getElementById('modal-title').textContent = `Repeater: ${name}`;

    const rssiText = rssi !== null && rssi !== 'null' ? `${rssi} dBm` : 'N/A';
    const snrText = snr !== null && snr !== 'null' ? `${snr} dB` : 'N/A';
    const lastSeenDate = new Date(lastSeen).toLocaleString();

    document.getElementById('modal-body').innerHTML = `
        <div style="padding: 15px;">
            <div style="margin-bottom: 12px;">
                <div style="font-weight: 600; margin-bottom: 8px; font-size: 14px;">Last Signal Reading</div>
            </div>
            <div style="background: rgba(0, 230, 118, 0.15); padding: 12px; border-radius: 4px; margin-bottom: 12px;">
                <div style="margin: 8px 0;">
                    <span style="color: #aaa;">Repeater Name:</span>
                    <strong style="font-size: 15px; color: #00e676; margin-left: 8px;">${name}</strong>
                </div>
                <div style="margin: 8px 0;">
                    <span style="color: #aaa;">RSSI:</span>
                    <strong style="font-size: 15px; color: #00e676; margin-left: 8px;">${rssiText}</strong>
                </div>
                <div style="margin: 8px 0;">
                    <span style="color: #aaa;">SNR:</span>
                    <strong style="font-size: 15px; color: #00e676; margin-left: 8px;">${snrText}</strong>
                </div>
                <div style="margin: 8px 0;">
                    <span style="color: #aaa;">Last Heard:</span>
                    <strong style="font-size: 13px; color: #fff; margin-left: 8px;">${lastSeenDate}</strong>
                </div>
            </div>
            <div style="font-size: 11px; color: #888; text-align: center;">
                This is the most recent reading from this repeater in this coverage area.
            </div>
        </div>
    `;

    document.getElementById('signal-modal').classList.add('show');
}

// ---------------------
// Modal touch guards (iOS Safari)
// ---------------------
(function initModalTouchGuards(){
    const overlay = document.getElementById('signal-modal');
    const content = overlay?.querySelector('.modal-content');
    if (!overlay) return;
    overlay.addEventListener('touchmove', (e) => {
        if (!content || !content.contains(e.target)) e.preventDefault();
    }, { passive: false });
    overlay.addEventListener('touchstart', () => {}, { passive: true });
    content?.addEventListener('touchmove', (e) => {
        e.stopPropagation();
    }, { passive: false });
})();

// ---------------------
// Time filter
// ---------------------
function setTimeFilter(days) {
    timeFilterDays = days;
    document.querySelectorAll('.time-btn').forEach(btn => btn.classList.remove('active'));
    event.target.classList.add('active');
    scheduleRender();
}

// ---------------------
// Contributor filter
// ---------------------
function filterByContributor() {
    activeContributor = document.getElementById('contributor-filter').value;
    loadData(); // Reload with filter
}

// ---------------------
// Repeater whitelist filter
// ---------------------
function filterByRepeater() {
    activeRepeaterFilter = document.getElementById('repeater-filter').value;
    if (showEdges && cachedCoverage) {
        const aggregated = aggregateAtPrecision(cachedCoverage, getEffectivePrecision());
        updateEdgeLines(aggregated);
    }
}

function populateRepeaterFilter() {
    if (!cachedCoverage) return;

    const repeaterIds = new Set();
    Object.values(cachedCoverage).forEach(cell => {
        if (cell.repeaters && typeof cell.repeaters === 'object') {
            Object.keys(cell.repeaters).forEach(id => repeaterIds.add(id));
        }
    });

    const select = document.getElementById('repeater-filter');
    if (!select) return;

    const current = select.value;
    select.innerHTML = '<option value="">All Repeaters</option>';

    // Sort and add repeater options
    [...repeaterIds].sort().forEach(id => {
        const opt = document.createElement('option');
        opt.value = id;
        // Find name from contacts if available
        const contact = repeaterContacts.find(r => {
            const key = (r.node_id.length > 8 ? r.node_id.substring(0, 8) : r.node_id).toUpperCase();
            return key === id;
        });
        opt.textContent = contact ? `${contact.name || id} (${id})` : id;
        select.appendChild(opt);
    });

    // Restore previous selection if still valid
    if (current && repeaterIds.has(current)) select.value = current;
}

function loadContributors() {
    fetch('/api/contributors').then(r => r.json()).then(data => {
        const select = document.getElementById('contributor-filter');
        if (!select || !data.contributors) return;
        // Keep first option (All)
        select.innerHTML = '<option value="">All Contributors</option>';
        data.contributors.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c.name;
            opt.textContent = `${c.name} (${c.totalSamples} samples)`;
            select.appendChild(opt);
        });
    }).catch(() => {});
}

// ---------------------
// Repeater contacts layer (true positions)
// ---------------------
function loadRepeaterContacts() {
    fetch('/api/repeaters').then(r => r.json()).then(data => {
        repeaterContacts = data.repeaters || [];
        if (showRepeaters) updateRepeaterContactMarkers();
        if (showEdges && cachedCoverage) {
            const aggregated = aggregateAtPrecision(cachedCoverage, getEffectivePrecision());
            updateEdgeLines(aggregated);
        }
    }).catch(() => {});
}

function updateRepeaterContactMarkers() {
    repeaterLayer.clearLayers();
    if (!showRepeaters || repeaterContacts.length === 0) return;

    const mapBounds = map.getBounds();

    repeaterContacts.forEach(rep => {
        // Skip 0,0 positions
        if (rep.latitude === 0 && rep.longitude === 0) return;
        if (!mapBounds.contains([rep.latitude, rep.longitude])) return;

        const icon = L.divIcon({
            className: 'repeater-marker-icon',
            html: '📡',
            iconSize: [24, 24],
            iconAnchor: [12, 12]
        });

        // Count how many coverage cells heard this repeater
        const nodeKey = (rep.node_id.length > 8 ? rep.node_id.substring(0, 8) : rep.node_id).toUpperCase();
        let cellCount = 0;
        if (cachedCoverage) {
            Object.values(cachedCoverage).forEach(cell => {
                if (cell.repeaters && cell.repeaters[nodeKey]) cellCount++;
            });
        }

        const displayName = rep.name || rep.node_id;
        const marker = L.marker([rep.latitude, rep.longitude], { icon: icon });
        marker.bindPopup(`
            <div class="popup-content">
                <div style="font-weight: bold; color: #00e676; margin-bottom: 8px;">📡 ${displayName}</div>
                <div><span class="popup-label">Node ID:</span> ${rep.node_id}</div>
                <div><span class="popup-label">Location:</span> ${rep.latitude.toFixed(5)}, ${rep.longitude.toFixed(5)}</div>
                ${rep.elevation ? `<div><span class="popup-label">Elevation:</span> ${rep.elevation}m</div>` : ''}
                <div><span class="popup-label">Cells Covered:</span> ${cellCount}</div>
                ${rep.added_by ? `<div><span class="popup-label">Added by:</span> ${rep.added_by}</div>` : ''}
            </div>
        `);

        repeaterLayer.addLayer(marker);
    });

    console.log(`Plotted ${repeaterContacts.length} repeater contacts`);
}

// ---------------------
// Initialize
// ---------------------
loadData();
loadContributors();
loadRepeaterContacts();

// Auto-refresh every 30 seconds
setInterval(loadData, 30000);
