import assert from 'node:assert/strict';
import { parseOsmElements, type OverpassData } from '../src/utils.ts';

const bounds = { south: 38.9, west: -77.1, north: 39.0, east: -77.0 };
const anchor = { latitude: 38.95, longitude: -77.05 };
const data: OverpassData = {
  elements: [
    { type: 'node', id: 1, lat: 38.94, lon: -77.04 },
    { type: 'node', id: 2, lat: 38.94, lon: -77.03 },
    { type: 'node', id: 3, lat: 38.95, lon: -77.03 },
    { type: 'node', id: 4, lat: 38.94, lon: -77.04 },
    { type: 'way', id: 10, nodes: [1, 2, 3, 4], tags: {
      building: 'school', height: 'not-a-number', 'building:levels': '2', material: 'brick',
    } },
    { type: 'node', id: 20, lat: 38.89, lon: -77.11 },
    { type: 'node', id: 21, lat: 39.01, lon: -76.99 },
    { type: 'way', id: 11, nodes: [20, 21], tags: { highway: 'primary', name: 'Georgia Avenue NW' } },
    { type: 'node', id: 30, lat: 38.96, lon: -77.06 },
    { type: 'node', id: 31, lat: 38.96, lon: -77.05 },
    { type: 'node', id: 32, lat: 38.97, lon: -77.05 },
    { type: 'way', id: 99, nodes: [30, 31, 32, 30] },
    { type: 'relation', id: 12, tags: { building: 'office', material: 'glass' }, members: [
      { type: 'way', ref: 99, role: 'outer' },
    ] },
  ],
};

const first = parseOsmElements(data, bounds, anchor);
const second = parseOsmElements(data, bounds, anchor);
assert.deepEqual(first, second, 'production parser must be deterministic');
assert.equal(first.length, 3);

const school = first.find((feature) => feature.id === 'osm_10');
assert.equal(school?.height, 7);
assert.equal(school?.material, 'itu_brick');
assert.equal(school?.levels, 2);

const road = first.find((feature) => feature.id === 'osm_11');
assert.equal(road?.category, 'infrastructure');
assert.equal(road?.name, 'Georgia Avenue NW');
assert.deepEqual(road?.points, [
  { lat: bounds.south, lon: bounds.west },
  { lat: bounds.north, lon: bounds.east },
]);

const relation = first.find((feature) => feature.id === 'osm_rel_12_0');
assert.equal(relation?.category, 'building');
assert.equal(relation?.material, 'itu_glass');
assert.equal(relation?.points.length, 4);

process.stdout.write('OSM production parser fixture: PASS\n');
