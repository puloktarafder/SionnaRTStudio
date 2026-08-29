/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Coordinate math, OSM (Overpass) fetching/parsing, and file exporters.
 * All RF solving happens on the Sionna RT backend (see api.ts).
 */

import { GeoAnchor, ENUVector, BuildingFootprint, Transmitter, PropagationPath, RadioMapGrid, ChannelGridConfig } from './types';

// Coordinate Math Constants
const M_LAT = 110574;

export function latLonToENU(lat: number, lon: number, anchor: GeoAnchor): ENUVector {
  const latRefRad = (anchor.latitude * Math.PI) / 180;
  const mLon = Math.cos(latRefRad) * 111320;
  const x = (lon - anchor.longitude) * mLon;
  const y = (lat - anchor.latitude) * M_LAT;
  return { x, y, z: 0 };
}

export function enuToLatLon(enu: ENUVector, anchor: GeoAnchor): { lat: number; lon: number } {
  const latRefRad = (anchor.latitude * Math.PI) / 180;
  const mLon = Math.cos(latRefRad) * 111320;
  const lon = anchor.longitude + enu.x / mLon;
  const lat = anchor.latitude + enu.y / M_LAT;
  return { lat, lon };
}

// 2D point-in-polygon test (ray casting) against a building footprint.
// Used by the 3D scene to snap devices onto rooftops.
export function isPointInPolygon(pt: { x: number; y: number }, poly: ENUVector[]): boolean {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersect = ((yi > pt.y) !== (yj > pt.y)) &&
      (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi + 1e-9) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// Free space path loss: FSPL = 20 * log10(d) + 20 * log10(f_GHz) + 32.44
// (display-only — the Analysis panel's link-budget card and FSPL curves).
export function calculatePathLoss(distance: number, freqGhz: number): number {
  if (distance < 0.1) return 0;
  return 20 * Math.log10(distance) + 20 * Math.log10(freqGhz) + 32.44;
}

// Raw OSM `material` / `building:material` tags (e.g. brick, glass, stone) aren't
// our `itu_*` ids. Map the common ones so they survive to the Sionna scene instead
// of silently falling back to concrete on the backend. Returns null for unknown
// values so callers fall back to the type-based default.
const OSM_MATERIAL_ALIASES: Record<string, string> = {
  concrete: 'itu_concrete', cement: 'itu_concrete', stone: 'itu_concrete',
  brick: 'itu_brick', brickwork: 'itu_brick',
  glass: 'itu_glass',
  metal: 'itu_metal', steel: 'itu_metal',
  wood: 'itu_wood', timber: 'itu_wood',
};

export function normalizeOsmMaterial(raw: string | undefined | null): string | null {
  if (!raw) return null;
  if (raw.startsWith('itu_')) return raw;
  return OSM_MATERIAL_ALIASES[raw.trim().toLowerCase()] ?? null;
}

export function getBuildingAttributes(type: string, id: string): { height: number; material: string } {
  // Simple deterministic jitter based on ID hash
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = id.charCodeAt(i) + ((hash << 5) - hash);
  }
  const jitter = ((Math.abs(hash) % 100) / 100) * 3 - 1.5; // -1.5m to +1.5m jitter

  let baseHeight = 8.0;
  let material = 'itu_concrete';

  switch (type.toLowerCase()) {
    case 'house':
    case 'detached':
    case 'residential':
      baseHeight = 6.5;
      material = 'itu_brick';
      break;
    case 'apartments':
    case 'terrace':
      baseHeight = 15.0;
      material = 'itu_concrete';
      break;
    case 'office':
    case 'commercial':
      baseHeight = 22.0;
      material = 'itu_glass';
      break;
    case 'retail':
    case 'supermarket':
      baseHeight = 10.0;
      material = 'itu_glass';
      break;
    case 'school':
    case 'university':
    case 'hospital':
      baseHeight = 14.5;
      material = 'itu_concrete';
      break;
    case 'industrial':
    case 'warehouse':
      baseHeight = 12.0;
      material = 'itu_metal';
      break;
    default:
      baseHeight = 9.0;
      material = 'itu_concrete';
  }

  return {
    height: Math.max(3.0, baseHeight + jitter),
    material,
  };
}

// ── Bounded network requests ─────────────────────────────────────────────────

/** Thrown when a request outlives its budget, so callers can say "timed out"
 *  rather than reporting a generic abort. */
export class RequestTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = 'RequestTimeoutError';
  }
}

/**
 * Run a request under a deadline and abort it if the deadline passes.
 *
 * `run` receives the signal and is expected to pass it to `fetch` *and* to do
 * its body read inside the callback. Both halves matter: a server can complete
 * the response headers and then stall mid-body, and a timeout that only covers
 * `fetch()` would hang forever on the `.json()`. Everything the callback awaits
 * is inside the budget.
 *
 * Uses AbortController rather than `AbortSignal.timeout()` — the latter needs
 * Safari 16+, and this is the one path a first-run Mac user hits.
 */
export async function withRequestTimeout<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } catch (error) {
    // Distinguish "we gave up" from "the caller/page aborted us".
    if (controller.signal.aborted) throw new RequestTimeoutError(timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// ── Overpass API fetch & parsing ─────────────────────────────────────────────

export interface OsmBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface OverpassData {
  elements?: any[];
}

// Overpass mirrors, tried in order. Both serve the full planet — a regional
// extract (e.g. overpass.osm.ch, Switzerland only) must never go in this list:
// it answers 200 with an empty `elements` array outside its region, which reads
// as "no buildings here" rather than as a failure.
//
// A mirror that accepts the connection and then goes silent is the failure mode
// that matters, so every request below is bounded by OSM_FETCH_TIMEOUT_MS.
export const OSM_OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
] as const;

/** Per-mirror ceiling. Overpass runs the query under `[out:json][timeout:25]`,
 *  so a healthy-but-busy server still fits; past this it is not coming back. */
export const OSM_FETCH_TIMEOUT_MS = 30_000;

interface OsmClassification {
  category: BuildingFootprint['category'];
  type: string;
  height: number;
  material: string;
  levels?: number;
  name?: string;
}

// Classify a tagged OSM element into a scene feature (or null if not rendered).
function classifyOsmTags(tags: Record<string, string>, elemId: string | number): OsmClassification | null {
  if (tags.building) {
    // Guard parseFloat/parseInt: tags like height="12'6\"" produce NaN, which
    // would serialize to null and fail backend validation.
    let height: number | undefined;
    const tagged = parseFloat(tags.height ?? '');
    if (Number.isFinite(tagged) && tagged > 0) height = tagged;
    const levelsRaw = parseInt(tags['building:levels'] ?? '', 10);
    const levels = Number.isFinite(levelsRaw) && levelsRaw > 0 ? levelsRaw : undefined;
    if (height === undefined && levels !== undefined) height = levels * 3.5;
    const attrs = getBuildingAttributes(tags.building, String(elemId));
    return {
      category: 'building',
      type: tags.building,
      height: height ?? attrs.height,
      material: normalizeOsmMaterial(tags.material || tags['building:material']) || attrs.material,
      levels,
    };
  }
  if (tags.highway) {
    const name = tags.name?.trim() || tags.ref?.trim() || undefined;
    return {
      category: 'infrastructure',
      type: tags.highway,
      height: 0.1,
      material: 'itu_dry_ground',
      name,
    };
  }
  if (
    tags.leisure === 'park' ||
    tags.landuse === 'grass' ||
    tags.landuse === 'forest' ||
    tags.landuse === 'meadow' ||
    tags.natural === 'wood' ||
    tags.natural === 'scrub'
  ) {
    return {
      category: 'terrain',
      type: tags.leisure || tags.landuse || tags.natural || 'vegetation',
      height: 0.05,
      material: 'itu_dry_ground',
    };
  }
  if (tags.natural === 'water' || tags.water) {
    return { category: 'water', type: tags.natural || tags.water || 'water', height: 0.02, material: 'itu_dry_ground' };
  }
  return null;
}

// Stitch a multipolygon relation's outer ways (node-id lists) into closed rings.
// Ways arrive in arbitrary order/direction; connect them by shared endpoints.
function stitchRings(ways: number[][]): number[][] {
  const remaining = ways.map((w) => [...w]);
  const rings: number[][] = [];
  while (remaining.length > 0) {
    const ring = remaining.shift()!;
    let extended = true;
    while (ring[0] !== ring[ring.length - 1] && extended) {
      extended = false;
      for (let i = 0; i < remaining.length; i++) {
        const w = remaining[i];
        const end = ring[ring.length - 1];
        if (w[0] === end) {
          ring.push(...w.slice(1));
        } else if (w[w.length - 1] === end) {
          ring.push(...[...w].reverse().slice(1));
        } else {
          continue;
        }
        remaining.splice(i, 1);
        extended = true;
        break;
      }
    }
    // Keep only rings that actually closed (open chains are dropped).
    if (ring.length >= 4 && ring[0] === ring[ring.length - 1]) rings.push(ring);
  }
  return rings;
}

/** Build the exact Overpass query used by both the browser and paper freezer. */
export function buildOsmOverpassQuery(bounds: OsmBounds, timeoutSeconds = 25): string {
  const { south, west, north, east } = bounds;
  return `[out:json][timeout:${timeoutSeconds}];
(
  way["building"](${south},${west},${north},${east});
  relation["building"](${south},${west},${north},${east});
  way["highway"](${south},${west},${north},${east});
  way["leisure"="park"](${south},${west},${north},${east});
  way["landuse"~"grass|forest|meadow|orchard"](${south},${west},${north},${east});
  way["natural"~"wood|scrub|water"](${south},${west},${north},${east});
);
out body;
>;
out skel qt;`;
}

export async function fetchOSMBuildings(
  south: number,
  west: number,
  north: number,
  east: number,
  anchor: GeoAnchor,
  onProgress?: (message: string) => void,
): Promise<BuildingFootprint[]> {
  const bounds = { south, west, north, east };
  const query = buildOsmOverpassQuery(bounds);

  let lastError = 'no Overpass endpoint responded';
  for (const [index, endpoint] of OSM_OVERPASS_ENDPOINTS.entries()) {
    const host = new URL(endpoint).host;
    onProgress?.(
      `Querying Overpass (mirror ${index + 1} of ${OSM_OVERPASS_ENDPOINTS.length}: ${host})...`,
    );
    try {
      // Timeout spans the body read too — a mirror can accept the POST and then
      // never answer, which is what used to wedge the download indefinitely.
      const data = await withRequestTimeout(OSM_FETCH_TIMEOUT_MS, async (signal) => {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body: new URLSearchParams({ data: query }),
          signal,
        });
        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`);
        }
        return await response.json() as OverpassData;
      });
      return parseOsmElements(data, bounds, anchor);
    } catch (error) {
      lastError = `${host}: ${error instanceof Error ? error.message : String(error)}`;
      onProgress?.(`Mirror ${host} failed (${lastError}); trying the next one...`);
    }
  }
  throw new Error(`Failed to fetch OSM data from configured Overpass mirrors (${lastError})`);
}

/**
 * Convert an Overpass response into the exact feature objects consumed by the
 * renderer and backend. This is intentionally pure so benchmark/reproduction
 * scripts import production logic instead of maintaining a drifting clone.
 */
export function parseOsmElements(
  data: OverpassData,
  bounds: OsmBounds,
  anchor: GeoAnchor,
): BuildingFootprint[] {
  const { south, west, north, east } = bounds;
  const elements: any[] = data.elements ?? [];

  // Index nodes and every way's node-id list (skeleton ways carry the geometry
  // of multipolygon relation members).
  const nodes: { [id: string]: { lat: number; lon: number } } = {};
  const wayNodeIds: { [id: string]: number[] } = {};
  for (const elem of elements) {
    if (elem.type === 'node') {
      nodes[elem.id] = { lat: elem.lat, lon: elem.lon };
    } else if (elem.type === 'way' && Array.isArray(elem.nodes)) {
      wayNodeIds[elem.id] = elem.nodes;
    }
  }

  const buildings: BuildingFootprint[] = [];

  const pushFeature = (id: string, nodeIds: number[], cls: OsmClassification) => {
    const polyPoints: { lat: number; lon: number }[] = [];
    for (const nodeId of nodeIds) {
      const n = nodes[nodeId];
      if (n) polyPoints.push(n);
    }
    // Streets need >= 2 points; closed footprints normally have >= 3.
    if (polyPoints.length < 2) return;

    // Buildings keep their true footprint — clamping border-straddling
    // buildings to the bbox used to squash them into degenerate prisms.
    // Roads/terrain/water (visual layers) are clamped to keep the scene bounded.
    const points = cls.category === 'building'
      ? polyPoints
      : polyPoints.map((p) => ({
          lat: Math.max(south, Math.min(north, p.lat)),
          lon: Math.max(west, Math.min(east, p.lon)),
        }));

    buildings.push({
      id,
      name: cls.name,
      points,
      enuPoints: points.map((p) => latLonToENU(p.lat, p.lon, anchor)),
      height: cls.height,
      levels: cls.levels,
      category: cls.category,
      type: cls.type,
      material: cls.material,
    });
  };

  // Tagged ways (buildings, roads, parks, water).
  for (const elem of elements) {
    if (elem.type !== 'way' || !elem.tags) continue;
    const cls = classifyOsmTags(elem.tags, elem.id);
    if (!cls) continue;
    pushFeature(`osm_${elem.id}`, elem.nodes ?? [], cls);
  }

  // Multipolygon building relations: assemble each outer ring into a footprint
  // (previously these were fetched but silently dropped).
  for (const elem of elements) {
    if (elem.type !== 'relation' || !elem.tags?.building || !Array.isArray(elem.members)) continue;
    const cls = classifyOsmTags(elem.tags, elem.id);
    if (!cls) continue;
    const outerWays = elem.members
      .filter((m: any) => m.type === 'way' && (m.role === 'outer' || !m.role))
      .map((m: any) => wayNodeIds[m.ref])
      .filter((w: number[] | undefined): w is number[] => Array.isArray(w) && w.length >= 2);
    stitchRings(outerWays).forEach((ring, ri) => {
      pushFeature(`osm_rel_${elem.id}_${ri}`, ring, cls);
    });
  }

  return buildings;
}

// Generate an explicitly labeled coverage-derived channel-grid proxy.
//
// IMPORTANT: this is a *synthetic* H, NOT a Sionna ray-traced channel. Per cell
// the magnitude is taken from the best-server coverage power and the per-subcarrier
// phase is a deterministic function of the cell coordinate — a lightweight,
// reproducible stand-in for ML scaffolding. For a true ray-traced channel use the
// CIR/CFR export (paths.cir() / paths.cfr()) on the Export tab.
export function exportCoverageChannelGrid(
  tx: Transmitter,
  grid: RadioMapGrid,
  config: ChannelGridConfig,
  freqGhz: number
): string {
  if (grid.metric && grid.metric !== 'power') {
    throw new Error('Coverage proxy requires a received-power radio map');
  }
  const data = {
    metadata: {
      creator: 'SionnaRTStudio',
      timestamp: new Date().toISOString(),
      carrier_frequency_ghz: freqGhz,
      tx_power_dbm: tx.powerDbm,
      // Be explicit about fidelity so downstream users don't mistake this for a
      // ray-traced channel matrix.
      synthetic: true,
      schema: 'sionna_rt_studio_channel_grid_v1',
      dataset_kind: 'coverage_power_proxy',
      source_metric: grid.metric ?? 'power',
      h_model: 'magnitude = best-server coverage power; phase = deterministic f(cell x,y). Not Sionna paths.cfr().',
      antenna_configuration: {
        tx_array: tx.antennaArraySize,
        // RadioMapSolver uses its documented ideal dual-polarized isotropic
        // map
        // receiver rather than scene.rx_array. This proxy is scalar for the
        // same reason; use the ray-traced channel-grid export for physical Rx
        // array ports.
        rx_array: [1, 1],
        receiver_model: 'Sionna RadioMap ideal dual-polarized isotropic receiver; configured scene.rx_array not applied',
        subcarriers: config.numSubcarriers,
        bandwidth_mhz: config.bandwidthMhz,
      },
    },
    dataset: grid.cells.map((cell, idx) => {
      // Voltage magnitude from the cell's coverage power (RSS), shared across
      // subcarriers; the phase below is deterministic per coordinate (reproducible).
      const amplitude = Math.pow(10, cell.powerDbm / 20);
      const subcarriers_data = Array.from({ length: config.numSubcarriers }).map((_, scIdx) => {
        const freqOffset = (scIdx - config.numSubcarriers / 2) * (config.bandwidthMhz / config.numSubcarriers);
        // Deterministic (not random) phase from the cell coordinate.
        const geomPhase = (Math.PI * 2 * (cell.x * scIdx + cell.y * (scIdx + 1))) % (Math.PI * 2);
        return {
          subcarrier_index: scIdx,
          frequency_offset_mhz: freqOffset,
          h_real: amplitude * Math.cos(geomPhase),
          h_imag: amplitude * Math.sin(geomPhase),
        };
      });

      return {
        receiver_index: idx,
        coordinate_enu_m: [cell.x, cell.y, cell.z],
        los_status: cell.isLos ? 1 : 0, // geometric LOS approximation, not an RT output
        received_power_dbm: cell.powerDbm,
        h_matrix: subcarriers_data,
      };
    }),
  };

  return JSON.stringify(data, null, 2);
}

// ---------------------------------------------------------------------------
// GIS / 3D / propagation exporters used by the EXPORT navigation panel.
// ---------------------------------------------------------------------------

// Compile building footprints (+ anchor metadata) into a standard GeoJSON FeatureCollection.
export function exportGeoJSON(buildings: BuildingFootprint[], anchor: GeoAnchor): string {
  const features = buildings.map((b) => {
    let coordinates: [number, number][][] = [];
    if (b.points && b.points.length > 0) {
      coordinates = [b.points.map((p) => [p.lon, p.lat])];
      // Close the polygon safely
      if (
        coordinates[0].length > 0 &&
        (coordinates[0][0][0] !== coordinates[0][coordinates[0].length - 1][0] ||
          coordinates[0][0][1] !== coordinates[0][coordinates[0].length - 1][1])
      ) {
        coordinates[0].push([coordinates[0][0][0], coordinates[0][0][1]]);
      }
    } else {
      coordinates = [
        b.enuPoints.map((ep) => {
          const latLon = enuToLatLon(ep, anchor);
          return [latLon.lon, latLon.lat];
        }),
      ];
      if (
        coordinates[0].length > 0 &&
        (coordinates[0][0][0] !== coordinates[0][coordinates[0].length - 1][0] ||
          coordinates[0][0][1] !== coordinates[0][coordinates[0].length - 1][1])
      ) {
        coordinates[0].push([coordinates[0][0][0], coordinates[0][0][1]]);
      }
    }

    return {
      type: 'Feature',
      properties: {
        id: b.id,
        name: b.name,
        height: b.height,
        category: b.category,
        type: b.type,
        material: b.material,
        levels: b.levels,
      },
      geometry: {
        type: b.category === 'infrastructure' ? 'LineString' : 'Polygon',
        coordinates: b.category === 'infrastructure' ? coordinates[0] : coordinates,
      },
    };
  });

  const geoJson = {
    type: 'FeatureCollection',
    metadata: {
      anchor_latitude: anchor.latitude,
      anchor_longitude: anchor.longitude,
      exported_at: new Date().toISOString(),
      generator: 'SionnaRTStudio Digital-Twin Suite',
    },
    features,
  };

  return JSON.stringify(geoJson, null, 2);
}

// Generate standard Wavefront OBJ file representing the procedural digital twin
export function exportOBJ3D(buildings: BuildingFootprint[]): string {
  let objText = `# SionnaRTStudio 3D Digital Twin Model OBJ Export\n`;
  objText += `# Generated at: ${new Date().toISOString()}\n`;
  objText += `# Bounding element count: ${buildings.length}\n\n`;

  let vertexOffset = 1;

  for (const b of buildings) {
    if (b.enuPoints.length < 2) continue;

    objText += `g ${b.id}_${b.category}_${b.type || 'generic'}\n`;

    if (b.category === 'building' && b.enuPoints.length >= 3) {
      const n = b.enuPoints.length;
      const h = b.height;

      // Add bottom vertices (z = 0)
      for (const p of b.enuPoints) {
        objText += `v ${p.x.toFixed(3)} ${p.y.toFixed(3)} 0.000\n`;
      }
      // Add top vertices (z = H)
      for (const p of b.enuPoints) {
        objText += `v ${p.x.toFixed(3)} ${p.y.toFixed(3)} ${h.toFixed(3)}\n`;
      }

      // 1. Bottom face
      objText += `f `;
      for (let i = n; i >= 1; i--) {
        objText += `${vertexOffset + i - 1} `;
      }
      objText += `\n`;

      // 2. Top face
      objText += `f `;
      for (let i = 1; i <= n; i++) {
        objText += `${vertexOffset + n + i - 1} `;
      }
      objText += `\n`;

      // 3. Side walls
      for (let i = 0; i < n; i++) {
        const next = (i + 1) % n;
        const v1 = vertexOffset + i;
        const v2 = vertexOffset + next;
        const v3 = vertexOffset + n + next;
        const v4 = vertexOffset + n + i;
        objText += `f ${v1} ${v2} ${v3} ${v4}\n`;
      }

      vertexOffset += 2 * n;
    } else if ((b.category === 'terrain' || b.category === 'water') && b.enuPoints.length >= 3) {
      const n = b.enuPoints.length;
      const z = b.category === 'water' ? 0.02 : 0.05;

      for (const p of b.enuPoints) {
        objText += `v ${p.x.toFixed(3)} ${p.y.toFixed(3)} ${z.toFixed(3)}\n`;
      }

      objText += `f `;
      for (let i = 1; i <= n; i++) {
        objText += `${vertexOffset + i - 1} `;
      }
      objText += `\n`;

      vertexOffset += n;
    } else if (b.category === 'infrastructure') {
      const n = b.enuPoints.length;
      for (const p of b.enuPoints) {
        objText += `v ${p.x.toFixed(3)} ${p.y.toFixed(3)} 0.100\n`;
      }
      objText += `l `;
      for (let i = 0; i < n; i++) {
        objText += `${vertexOffset + i} `;
      }
      objText += `\n`;
      vertexOffset += n;
    }
    objText += `\n`;
  }

  return objText;
}

// Compile a detailed CSV spreadsheet representation of the active propagation paths
export function exportPropagationCSV(paths: PropagationPath[]): string {
  let csv = `Path_ID,Path_Type,Reflection_Order,Total_Distance_m,Path_Loss_dB,Received_Power_dBm,Delay_ns,Vertices_ENU\n`;
  for (const p of paths) {
    const ptsStr = p.points
      .map((pt) => `${pt.x.toFixed(2)}:${pt.y.toFixed(2)}:${pt.z.toFixed(2)}`)
      .join(' | ');
    csv += `"${p.id}","${p.type}",${p.order},${p.distance.toFixed(2)},${p.pathLossDb.toFixed(2)},${p.receivedPowerDbm.toFixed(2)},${p.delayNs.toFixed(2)},"${ptsStr}"\n`;
  }
  return csv;
}
