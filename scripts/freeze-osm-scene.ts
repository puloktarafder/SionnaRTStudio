/**
 * Freeze one production-equivalent OpenStreetMap scene for experiments.
 *
 * The script imports `parseOsmElements` from the application itself, then
 * archives the raw Overpass payload, all rendered features, the building-only
 * backend input, and a manifest with hashes. Node 18+ provides `fetch`.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  buildOsmOverpassQuery,
  OSM_OVERPASS_ENDPOINTS,
  parseOsmElements,
  type OsmBounds,
  type OverpassData,
} from '../src/utils.ts';
import type { GeoAnchor } from '../src/types.ts';

const DEFAULT_ANCHOR: GeoAnchor = { latitude: 38.9226, longitude: -77.0194 };
const DEFAULT_BOUNDS: OsmBounds = {
  south: DEFAULT_ANCHOR.latitude - 0.003,
  west: DEFAULT_ANCHOR.longitude - 0.004,
  north: DEFAULT_ANCHOR.latitude + 0.003,
  east: DEFAULT_ANCHOR.longitude + 0.004,
};

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function numberArgument(name: string, fallback: number): number {
  const raw = argument(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return value;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function main(): Promise<void> {
  const anchor: GeoAnchor = {
    latitude: numberArgument('--anchor-lat', DEFAULT_ANCHOR.latitude),
    longitude: numberArgument('--anchor-lon', DEFAULT_ANCHOR.longitude),
  };
  const bounds: OsmBounds = {
    south: numberArgument('--south', DEFAULT_BOUNDS.south),
    west: numberArgument('--west', DEFAULT_BOUNDS.west),
    north: numberArgument('--north', DEFAULT_BOUNDS.north),
    east: numberArgument('--east', DEFAULT_BOUNDS.east),
  };
  if (!(bounds.south < bounds.north && bounds.west < bounds.east)) {
    throw new Error('Bounds must satisfy south < north and west < east');
  }

  const outputDirectory = resolve(argument('--out-dir') ?? 'artifacts/osm-scene');
  const query = buildOsmOverpassQuery(bounds, 60);
  let endpoint = '';
  let rawResponse = '';
  const failures: string[] = [];
  for (const candidate of OSM_OVERPASS_ENDPOINTS) {
    try {
      const response = await fetch(candidate, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'User-Agent': 'SionnaRTStudio-reproducibility-freezer/1.0',
        },
        body: new URLSearchParams({ data: query }),
      });
      if (!response.ok) {
        failures.push(`${candidate}: ${response.status} ${response.statusText}`);
        continue;
      }
      endpoint = candidate;
      rawResponse = await response.text();
      break;
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!endpoint) {
    throw new Error(`All Overpass mirrors failed (${failures.join('; ')})`);
  }

  const raw = JSON.parse(rawResponse) as OverpassData;
  const features = parseOsmElements(raw, bounds, anchor);
  const buildings = features.filter((feature) => feature.category === 'building');

  const rawText = rawResponse.endsWith('\n') ? rawResponse : `${rawResponse}\n`;
  const featureText = pretty(features);
  const buildingText = pretty(buildings);
  const counts = features.reduce<Record<string, number>>((accumulator, feature) => {
    accumulator[feature.category] = (accumulator[feature.category] ?? 0) + 1;
    return accumulator;
  }, {});
  const manifest = {
    schemaVersion: 1,
    generatedAtUtc: new Date().toISOString(),
    source: {
      provider: 'OpenStreetMap via Overpass API',
      endpoint,
      failedMirrorsBeforeSuccess: failures,
      query,
      querySha256: sha256(query),
    },
    productionParser: 'src/utils.ts::parseOsmElements',
    anchor,
    bounds,
    featureCounts: { total: features.length, ...counts },
    files: {
      'osm_raw.json': { sha256: sha256(rawText), bytes: Buffer.byteLength(rawText) },
      'scene_features.json': { sha256: sha256(featureText), bytes: Buffer.byteLength(featureText) },
      'buildings.json': { sha256: sha256(buildingText), bytes: Buffer.byteLength(buildingText) },
    },
    runtime: { node: process.version, platform: process.platform, architecture: process.arch },
  };

  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(resolve(outputDirectory, 'osm_raw.json'), rawText, 'utf8'),
    writeFile(resolve(outputDirectory, 'scene_features.json'), featureText, 'utf8'),
    writeFile(resolve(outputDirectory, 'buildings.json'), buildingText, 'utf8'),
    writeFile(resolve(outputDirectory, 'osm_scene_manifest.json'), pretty(manifest), 'utf8'),
  ]);

  process.stdout.write(
    `Frozen ${features.length} scene features (${buildings.length} buildings) in ${outputDirectory}\n`,
  );
  process.stdout.write(`buildings.json sha256=${sha256(buildingText)}\n`);
}

await main();
