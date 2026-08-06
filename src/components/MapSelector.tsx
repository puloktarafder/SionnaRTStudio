/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { GeoAnchor, Transmitter, Receiver } from '../types';
import { RequestTimeoutError, withRequestTimeout } from '../utils';
import { Search, MapPin, CloudDownload } from 'lucide-react';

interface MapSelectorProps {
  anchor: GeoAnchor;
  setAnchor: (anchor: GeoAnchor) => void;
  tx: Transmitter;
  rx: Receiver;
  txs?: Transmitter[];
  rxs?: Receiver[];
  onTxUpdate: (tx: Transmitter) => void;
  onRxUpdate: (rx: Receiver) => void;
  onDownloadOSM: (bounds: L.LatLngBounds) => void;
  isLoading: boolean;
  downloadProgress: string;
  trajectoryPoints: { lat: number; lon: number; enu: { x: number; y: number; z: number } }[];
}

// Map marker showing a colored dot + a name label (e.g. "Tx 1", "Rx 2").
function deviceIcon(name: string, color: string, active: boolean): L.DivIcon {
  const dot = active ? 18 : 13;
  return L.divIcon({
    className: 'custom-m-dev',
    html:
      `<div style="display:flex;align-items:center;gap:4px;white-space:nowrap;">` +
        `<div style="width:${dot}px;height:${dot}px;background:${color};border-radius:50%;` +
          `border:${active ? 3 : 2}px solid #000;box-shadow:0 0 ${active ? 12 : 6}px ${color};` +
          `${active ? '' : 'opacity:0.85;'}"></div>` +
        `<span style="background:rgba(11,12,14,0.82);color:#fff;font-size:9px;font-weight:700;` +
          `line-height:1;padding:2px 5px;border-radius:3px;border:1px solid ${color};">${name}</span>` +
      `</div>`,
    iconSize: [dot, dot],
    iconAnchor: [dot / 2, dot / 2],
  });
}

export function MapSelector({
  anchor,
  setAnchor,
  tx,
  rx,
  txs,
  rxs,
  onTxUpdate,
  onRxUpdate,
  onDownloadOSM,
  isLoading,
  downloadProgress,
  trajectoryPoints
}: MapSelectorProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerTxRef = useRef<L.Marker | null>(null);
  const markerRxRef = useRef<L.Marker | null>(null);
  const extraMarkersRef = useRef<L.Marker[]>([]);
  const pathMarkersRef = useRef<L.Marker[]>([]);
  const pathLineRef = useRef<L.Polyline | null>(null);
  const bboxRectRef = useRef<L.Rectangle | null>(null);

  const [searchQuery, setSearchQuery] = useState('Howard University');
  const [bboxInfo, setBboxInfo] = useState<{ s: number; w: number; n: number; e: number } | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  const txRef = useRef(tx);
  txRef.current = tx;
  const rxRef = useRef(rx);
  rxRef.current = rx;
  // User-chosen square selection size in meters (the chunk of map to fetch).
  const [boxSizeM, setBoxSizeM] = useState(400);
  const boxSizeRef = useRef(boxSizeM);
  boxSizeRef.current = boxSizeM;

  // Square bounding box of `boxSizeM` meters centred on the anchor.
  const computeBbox = (lat: number, lon: number, sizeM: number = boxSizeRef.current) => {
    const half = sizeM / 2;
    const latDelta = half / 111320; // metres -> degrees latitude
    const lonDelta = half / (111320 * Math.cos((lat * Math.PI) / 180)); // adjust for latitude
    return {
      s: lat - latDelta,
      w: lon - lonDelta,
      n: lat + latDelta,
      e: lon + lonDelta,
    };
  };

  // 1. Initialise Leaflet Map
  useEffect(() => {
    if (!mapContainerRef.current) return;

    // Create Map
    const map = L.map(mapContainerRef.current, {
      center: [anchor.latitude, anchor.longitude],
      zoom: 16,
      zoomControl: true,
      attributionControl: false
    });

    mapRef.current = map;

    // Premium high-contrast light minimal map tile layer (CartoDB Positron)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19
    }).addTo(map);

    // Initial bbox rectangle representing the active twin boundaries
    const bbox = computeBbox(anchor.latitude, anchor.longitude);
    setBboxInfo(bbox);

    const bounds = L.latLngBounds([bbox.s, bbox.w], [bbox.n, bbox.e]);
    const rect = L.rectangle(bounds, {
      color: '#cc785c',
      weight: 1.5,
      fillColor: '#cc785c',
      fillOpacity: 0.08,
      dashArray: '4, 4'
    }).addTo(map);
    bboxRectRef.current = rect;

    // Spawn labeled, draggable markers for the active Tx / Rx.
    const mTx = L.marker([tx.latitude, tx.longitude], { icon: deviceIcon(tx.name, '#cc785c', true), draggable: true }).addTo(map);
    const mRx = L.marker([rx.latitude, rx.longitude], { icon: deviceIcon(rx.name, '#4a727e', true), draggable: true }).addTo(map);
    
    markerTxRef.current = mTx;
    markerRxRef.current = mRx;

    // Click the map to recenter the digital-twin anchor. Mobility paths are drawn in the 3D scene.
    map.on('click', (e) => {
      const { lat, lng } = e.latlng;
      
      // Dynamic shift scene anchor to clicked center
      setAnchor({ latitude: lat, longitude: lng });

      // Shift transmitter and receiver inside the new bounding box gracefully
      onTxUpdate({
        ...txRef.current,
        latitude: lat + 0.0003,
        longitude: lng - 0.0004
      });
      onRxUpdate({
        ...rxRef.current,
        latitude: lat - 0.0003,
        longitude: lng + 0.0004
      });
    });

    // Drag pins events
    mTx.on('dragend', () => {
      const pos = mTx.getLatLng();
      onTxUpdate({
        ...txRef.current,
        latitude: pos.lat,
        longitude: pos.lng
      });
    });

    mRx.on('dragend', () => {
      const pos = mRx.getLatLng();
      onRxUpdate({
        ...rxRef.current,
        latitude: pos.lat,
        longitude: pos.lng
      });
    });

    // Leaflet caches the container size at init and never re-reads it, so any
    // layout change (panel resize, window resize, the inspector rail width)
    // leaves it drawing against a stale pixel origin — which shows up as the
    // selection box drifting off-centre. Re-measure whenever the box changes.
    const resizeObserver = new ResizeObserver(() => {
      map.invalidateSize({ animate: false });
    });
    resizeObserver.observe(mapContainerRef.current);

    return () => {
      resizeObserver.disconnect();
      pathMarkersRef.current.forEach((m) => m.remove());
      pathLineRef.current?.remove();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // 2. Map coordinates sync handlers (pushes updates outward immediately)
  useEffect(() => {
    if (!mapRef.current) return;

    const bbox = computeBbox(anchor.latitude, anchor.longitude, boxSizeM);
    setBboxInfo(bbox);

    const bounds = L.latLngBounds([bbox.s, bbox.w], [bbox.n, bbox.e]);

    // Update rect bounding box representation
    if (bboxRectRef.current) {
      bboxRectRef.current.setBounds(bounds);
    }

    // Frame the selection: fit the box (with padding) so resizing is visible.
    mapRef.current.fitBounds(bounds, { padding: [24, 24], animate: true });
  }, [anchor, boxSizeM]);

  // Handle marker position changes on external props updates (e.g., from 3D dragging)
  useEffect(() => {
    if (markerTxRef.current) {
      markerTxRef.current.setLatLng([tx.latitude, tx.longitude]);
    }
  }, [tx.latitude, tx.longitude]);

  useEffect(() => {
    if (markerRxRef.current) {
      markerRxRef.current.setLatLng([rx.latitude, rx.longitude]);
    }
  }, [rx.latitude, rx.longitude]);

  // Relabel the active markers when the active device changes.
  useEffect(() => {
    markerTxRef.current?.setIcon(deviceIcon(tx.name, '#cc785c', true));
  }, [tx.name]);
  useEffect(() => {
    markerRxRef.current?.setIcon(deviceIcon(rx.name, '#4a727e', true));
  }, [rx.name]);

  // Render static pins for every NON-active Tx/Rx (the active two are the
  // draggable markers above). Refreshed whenever the device lists change.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    extraMarkersRef.current.forEach((m) => m.remove());
    extraMarkersRef.current = [];

    (txs ?? []).forEach((t) => {
      if (t.id === tx.id) return;
      extraMarkersRef.current.push(
        L.marker([t.latitude, t.longitude], { icon: deviceIcon(t.name, '#cc785c', false), interactive: false }).addTo(map),
      );
    });
    (rxs ?? []).forEach((r) => {
      if (r.id === rx.id) return;
      extraMarkersRef.current.push(
        L.marker([r.latitude, r.longitude], { icon: deviceIcon(r.name, '#4a727e', false), interactive: false }).addTo(map),
      );
    });
  }, [txs, rxs, tx.id, rx.id, tx.name, rx.name]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    pathMarkersRef.current.forEach((m) => m.remove());
    pathMarkersRef.current = [];
    pathLineRef.current?.remove();
    pathLineRef.current = null;

    if (trajectoryPoints.length === 0) return;

    const latLngs = trajectoryPoints.map((p) => [p.lat, p.lon] as [number, number]);
    pathLineRef.current = L.polyline(latLngs, {
      color: '#5f7f5a',
      weight: 4,
      opacity: 0.95,
      dashArray: '6, 5',
    }).addTo(map);

    trajectoryPoints.forEach((p, idx) => {
      const marker = L.circleMarker([p.lat, p.lon], {
        radius: idx === 0 || idx === trajectoryPoints.length - 1 ? 5 : 3.5,
        color: idx === 0 ? '#5f7f5a' : idx === trajectoryPoints.length - 1 ? '#cc785c' : '#141413',
        fillColor: idx === 0 ? '#5f7f5a' : idx === trajectoryPoints.length - 1 ? '#cc785c' : '#f5f3ec',
        fillOpacity: 1,
        weight: 2,
      }).addTo(map);
      pathMarkersRef.current.push(marker);
    });
  }, [trajectoryPoints]);

  // Global OSM location searches
  const handleQuerySearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;

    setSearchError(null);
    try {
      const data = await withRequestTimeout(15_000, async (signal) => {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchQuery)}`,
          { signal },
        );
        if (!res.ok) throw new Error('Query error');
        return await res.json();
      });
      if (data && data.length > 0) {
        const topResult = data[0];
        const lat = parseFloat(topResult.lat);
        const lon = parseFloat(topResult.lon);

        setAnchor({ latitude: lat, longitude: lon });
        onTxUpdate({ ...tx, latitude: lat + 0.0003, longitude: lon - 0.0004 });
        onRxUpdate({ ...rx, latitude: lat - 0.0003, longitude: lon + 0.0004 });
      } else {
        setSearchError('Place not found. Try entering coordinate pairs (e.g. 51.5, -0.1)');
      }
    } catch (error) {
      setSearchError(
        error instanceof RequestTimeoutError
          ? 'Nominatim did not respond in 15s. Check your connection and retry.'
          : 'Search API error, please double check location inputs.',
      );
    }
  };

  const handleDownloadClick = () => {
    if (!bboxInfo) return;
    const bounds = L.latLngBounds([bboxInfo.s, bboxInfo.w], [bboxInfo.n, bboxInfo.e]);
    onDownloadOSM(bounds);
  };

  return (
    <div id="map-selection-sub" className="flex flex-col gap-3.5 panel p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <MapPin className="w-4 h-4 text-[#cc785c]" />
          <h3 className="panel-title">Digital Twin Coordinate Anchor</h3>
        </div>
        <span className="eyebrow shrink-0 whitespace-nowrap bg-[#ebe7dc] border border-[#e3e0d6] px-2 py-0.5 rounded">OSM Global</span>
      </div>

      {/* Global search nomination bar */}
      <form onSubmit={handleQuerySearch} className="flex gap-1.5 animate-fade-in">
        <div className="relative flex-1">
          <input
            id="map-location-query"
            type="text"
            className="w-full text-[14px] py-2 pl-8 pr-3 bg-[#f5f3ec] border border-[#e3e0d6] focus:outline-none focus:border-[#cc785c] rounded text-slate-800 placeholder-slate-600 font-medium transition-all"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search city, coordinates, or street..."
          />
          <Search className="w-3.5 h-3.5 text-slate-600 absolute left-2.5 top-2.5" />
        </div>
        <button
          type="submit"
          id="btn-trigger-nom-search"
          className="px-4.5 bg-[#ebe7dc] border border-[#e3e0d6] text-[#141413] hover:bg-[#e3e0d6] hover:text-slate-900 text-[14px] font-semibold rounded transition cursor-pointer"
        >
          Locate
        </button>
      </form>

      {searchError && <p className="text-[13px] text-[#cc785c] font-medium bg-[#f8f1ec] border border-[#e8d3c2] p-2.5 rounded">{searchError}</p>}

      {/* 2D Leaflet Container */}
      <div className="relative border border-[#e3e0d6] rounded overflow-hidden shadow-inner h-[240px] bg-[#f5f3ec]">
        <div ref={mapContainerRef} className="w-full h-full" style={{ zIndex: 1 }} />
      </div>

      {/* Current selection metrics & sync actions */}
      <div className="flex flex-col gap-2 p-3 bg-[#f5f3ec] rounded border border-[#e3e0d6] text-slate-700 text-[14px] shadow-xl">
        <div className="flex flex-wrap justify-between items-baseline gap-x-3 font-mono text-[13px]">
          <span className="eyebrow whitespace-nowrap">Twin Anchor:</span>
          <span className="font-semibold text-slate-900 ml-auto whitespace-nowrap">{anchor.latitude.toFixed(5)}°N, {anchor.longitude.toFixed(5)}°E</span>
        </div>
        <div className="flex flex-wrap justify-between items-baseline gap-x-3 font-mono text-[13px]">
          <span className="eyebrow whitespace-nowrap">Bounding Extent:</span>
          <span className="font-semibold text-slate-900 ml-auto whitespace-nowrap">{boxSizeM} m × {boxSizeM} m ({((boxSizeM / 1000) ** 2).toFixed(2)} km²)</span>
        </div>
        <div className="flex flex-wrap justify-between items-baseline gap-x-3 font-mono text-[13px]">
          <span className="eyebrow whitespace-nowrap">3D Mobility Path:</span>
          <span className="font-semibold text-slate-900 ml-auto whitespace-nowrap">{trajectoryPoints.length} waypoint{trajectoryPoints.length === 1 ? '' : 's'}</span>
        </div>

        {/* Selection size — choose how big a chunk of the map to capture */}
        <div className="flex flex-col gap-1 pt-1">
          <div className="flex justify-between items-center">
            <label className="eyebrow">Selection Size</label>
            <span className="font-mono text-[13px] text-[#cc785c] font-bold">{boxSizeM} m</span>
          </div>
          <input
            type="range"
            id="slider-box-size"
            min="100"
            max="2000"
            step="50"
            className="accent-[#cc785c] cursor-ew-resize w-full"
            value={boxSizeM}
            onChange={(e) => setBoxSizeM(parseInt(e.target.value, 10))}
          />
          <span className="text-[11px] text-slate-600 font-mono">
            Click the map to recenter · drag the slider to resize the fetch area
          </span>
        </div>

        <button
          onClick={handleDownloadClick}
          id="btn-trigger-gis-downloader"
          disabled={isLoading}
          className="w-full mt-2.5 btn-signal text-[14px] py-2.5 px-3 flex items-center justify-center gap-1.5 cursor-pointer"
        >
          <CloudDownload className="w-4 h-4" />
          {isLoading ? 'Downloading Overpass...' : 'Fetch OSM Physical Twin'}
        </button>

        {isLoading && (
          <div className="mt-2 p-2.5 bg-[#ebe7dc] text-[#cc785c] text-[12px] font-mono border border-[#e3e0d6] rounded flex flex-col gap-1.5 animate-pulse">
            <span>{downloadProgress || 'Retrieving structures footprint from Overpass...'}</span>
            <div className="w-full bg-[#f5f3ec] h-1 rounded overflow-hidden">
              <span className="block h-full bg-[#cc785c] animate-pulse" style={{ width: '40%' }} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
