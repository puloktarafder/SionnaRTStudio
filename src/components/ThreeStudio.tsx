/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { BuildingFootprint, GeoAnchor, Transmitter, Receiver, PropagationPath, ENUVector } from '../types';
import { cn } from '../lib/utils';
import { enuToLatLon, isPointInPolygon } from '../utils';
import { RadioMapGrid } from '../types';
import { ColormapName, sampleColormap } from '../lib/colormaps';
import { Compass, Activity } from 'lucide-react';

// Sample the selected colormap at t in [0,1] into `out`.
function colormapColor(name: ColormapName, t: number, out: THREE.Color): THREE.Color {
  const [r, g, b] = sampleColormap(name, t);
  return out.setRGB(r, g, b);
}

// Free the GPU resources (geometry, materials, textures) held by an object tree.
// three.js does not release these on remove(), so skipping this leaks VRAM.
function disposeObject3D(obj: THREE.Object3D) {
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const material = (mesh as THREE.Mesh).material;
    const mats = Array.isArray(material) ? material : material ? [material] : [];
    for (const m of mats) {
      const tex = (m as THREE.SpriteMaterial).map;
      if (tex) tex.dispose();
      m.dispose();
    }
  });
}

// Remove and dispose every child of a group.
function clearGroup(group: THREE.Group) {
  while (group.children.length > 0) {
    const child = group.children[0];
    group.remove(child);
    disposeObject3D(child);
  }
}

// Muted, matte building palette in the spirit of Sionna RT's preview renderer
// (earthy tan / beige / sage / mauve / terracotta / slate tones).
const BUILDING_PALETTE = [
  0xb08968, 0xddbea9, 0xa5a58d, 0x9a8c98,
  0xcb997e, 0x8d99ae, 0xb5838d, 0xc9ada7,
];
function buildingColor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return BUILDING_PALETTE[h % BUILDING_PALETTE.length];
}

// A camera-facing text label (e.g. "Tx 1") rendered as a sprite, for the 3D scene.
function makeLabelSprite(text: string, borderColor: string): THREE.Sprite {
  const fontSize = 48;
  const pad = 18;
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = `bold ${fontSize}px sans-serif`;
  const tw = Math.ceil(measure.measureText(text).width);
  const canvas = document.createElement('canvas');
  canvas.width = tw + pad * 2;
  canvas.height = fontSize + pad * 2;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(11,12,14,0.82)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 3;
  ctx.strokeRect(1.5, 1.5, canvas.width - 3, canvas.height - 3);
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  const worldH = 7; // label height in world units
  sprite.scale.set((worldH * canvas.width) / canvas.height, worldH, 1);
  sprite.renderOrder = 20;
  return sprite;
}

interface ThreeStudioProps {
  buildings: BuildingFootprint[];
  anchor: GeoAnchor;
  tx: Transmitter;
  rx: Receiver;
  txs?: Transmitter[];
  rxs?: Receiver[];
  activeTxId?: string;
  activeRxId?: string;
  paths: PropagationPath[];
  matrixPaths?: PropagationPath[];
  showRaysOnHeatmap?: boolean;
  radioMap: RadioMapGrid | null;
  rmColormap: ColormapName;
  rmAutoRange: boolean;
  rmVmin: number;
  rmVmax: number;
  onTxUpdate: (tx: Transmitter) => void;
  onRxUpdate: (rx: Receiver) => void;
  activeMode: 'link' | 'heatmap' | 'playback';
  placementMode: 'none' | 'tx' | 'rx';
  setPlacementMode: (mode: 'none' | 'tx' | 'rx') => void;
  showOutlines: boolean;
  setShowOutlines: (val: boolean) => void;
  mobilityRxPosition: ENUVector | null;
  trajectoryPoints: { lat: number; lon: number; enu: { x: number; y: number; z: number } }[];
  setTrajectoryPoints: (pts: { lat: number; lon: number; enu: { x: number; y: number; z: number } }[]) => void;
}

// Map ENU Vector to Three.js vector
// East (X) -> +X
// North (Y) -> -Z
// Up (Z) -> +Y
function enuToThree(v: ENUVector): THREE.Vector3 {
  return new THREE.Vector3(v.x, v.z, -v.y);
}

export function ThreeStudio({
  buildings,
  anchor,
  tx,
  rx,
  txs,
  rxs,
  activeTxId,
  activeRxId,
  paths,
  matrixPaths,
  showRaysOnHeatmap,
  radioMap,
  rmColormap,
  rmAutoRange,
  rmVmin,
  rmVmax,
  onTxUpdate,
  onRxUpdate,
  activeMode,
  placementMode,
  setPlacementMode,
  showOutlines,
  setShowOutlines,
  mobilityRxPosition,
  trajectoryPoints,
  setTrajectoryPoints
}: ThreeStudioProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [fps, setFps] = useState<number>(0);
  const [performanceMode, setPerformanceMode] = useState<'high' | 'eco'>('high');
  const [cameraMode, setCameraMode] = useState<'orbit' | 'lockTx'>('orbit');
  const [pathDrawingMode, setPathDrawingMode] = useState(false);

  const [hoveredCoordinate, setHoveredCoordinate] = useState<ENUVector | null>(null);

  // Keep references to access them in render loops & events stably
  const stateRef = useRef({
    buildings,
    anchor,
    tx,
    rx,
    txs,
    rxs,
    activeTxId,
    activeRxId,
    paths,
    matrixPaths,
    showRaysOnHeatmap,
    radioMap,
    rmColormap,
    rmAutoRange,
    rmVmin,
    rmVmax,
    placementMode,
    activeMode,
    cameraMode,
    showOutlines,
    pathDrawingMode,
    mobilityRxPosition,
    trajectoryPoints,
    setTrajectoryPoints,
    onTxUpdate,
    onRxUpdate,
    setPlacementMode
  });

  useEffect(() => {
    stateRef.current = {
      buildings,
      anchor,
      tx,
      rx,
      txs,
      rxs,
      activeTxId,
      activeRxId,
      paths,
      matrixPaths,
      showRaysOnHeatmap,
      radioMap,
      rmColormap,
      rmAutoRange,
      rmVmin,
      rmVmax,
      placementMode,
      activeMode,
      cameraMode,
      showOutlines,
      pathDrawingMode,
      mobilityRxPosition,
      trajectoryPoints,
      setTrajectoryPoints,
      onTxUpdate,
      onRxUpdate,
      setPlacementMode
    };
  }, [buildings, anchor, tx, rx, txs, rxs, activeTxId, activeRxId, paths, matrixPaths, showRaysOnHeatmap, radioMap, rmColormap, rmAutoRange, rmVmin, rmVmax, placementMode, activeMode, cameraMode, showOutlines, pathDrawingMode, mobilityRxPosition, trajectoryPoints, setTrajectoryPoints, onTxUpdate, onRxUpdate, setPlacementMode]);

  useEffect(() => {
    if (!containerRef.current || !canvasRef.current) return;

    const width = containerRef.current.clientWidth;
    const height = containerRef.current.clientHeight || 580;

    // 1. Initial Scene Setup
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf8fafc); // Bright elegant light mode background
    // No distance fog — it washed the whole scene hazy when zoomed out.

    // 2. Camera Setup. Near plane at 1 (not 0.1) so the depth buffer keeps
    // precision across the large city extent → no z-fighting flicker far out.
    const camera = new THREE.PerspectiveCamera(45, width / height, 1, 6000);
    camera.position.set(0, 180, 240);

    // 3. WebGL Renderer. logarithmicDepthBuffer eliminates the flicker between
    // the many coplanar flat layers (ground, grid, roads, parks, water).
    const renderer = new THREE.WebGLRenderer({
      canvas: canvasRef.current,
      antialias: performanceMode === 'high',
      alpha: true,
      logarithmicDepthBuffer: true,
      powerPreference: "high-performance"
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, performanceMode === 'high' ? 2 : 1));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // 4. Orbit Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI / 2 - 0.02; // restrict to ground-level rotations
    controls.screenSpacePanning = true;

    // 5. Lights — soft, even, Sionna-preview style (mostly ambient + sky/ground fill).
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambientLight);

    const hemiLight = new THREE.HemisphereLight(0xffffff, 0xc7ccd4, 0.6);
    hemiLight.position.set(0, 300, 0);
    scene.add(hemiLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.55);
    dirLight.position.set(120, 250, 80);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    dirLight.shadow.camera.near = 0.5;
    dirLight.shadow.camera.far = 1000;
    const dSide = 400;
    dirLight.shadow.camera.left = -dSide;
    dirLight.shadow.camera.right = dSide;
    dirLight.shadow.camera.top = dSide;
    dirLight.shadow.camera.bottom = -dSide;
    dirLight.shadow.bias = -0.0005;
    scene.add(dirLight);

    // Grid Floor matching Light Minimal GIS setup
    const gridHelper = new THREE.GridHelper(1000, 100, 0x94a3b8, 0xcbd5e1);
    gridHelper.position.y = -0.1;
    scene.add(gridHelper);

    // Ground slab
    const groundGeom = new THREE.PlaneGeometry(2000, 2000);
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0xe2e8f0, // Elegant deeper slate-200 ground base for maximum contrast against white buildings
      roughness: 0.9,
      metalness: 0.05
    });
    const ground = new THREE.Mesh(groundGeom, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.2;
    ground.receiveShadow = true;
    scene.add(ground);

    // Grouping nodes for logical clear layers
    const buildingGroup = new THREE.Group();
    const transmitterGroup = new THREE.Group();
    const receiverGroup = new THREE.Group();
    const pathsGroup = new THREE.Group();
    const heatmapGroup = new THREE.Group();
    const trajectoryGroup = new THREE.Group();
    const interactionGroup = new THREE.Group();

    scene.add(buildingGroup);
    scene.add(transmitterGroup);
    scene.add(receiverGroup);
    scene.add(pathsGroup);
    scene.add(heatmapGroup);
    scene.add(trajectoryGroup);
    scene.add(interactionGroup);

    // 6. BUILD GENERATOR: Building Geometry Extruders
    function rebuildBuildings3D() {
      clearGroup(buildingGroup);

      const current = stateRef.current;
      current.buildings.forEach(b => {
        const pts = b.enuPoints;
        if (pts.length < 2) return;

        // --- 1. ROADS / STREETS (INFRASTRUCTURE) ---
        if (b.category === 'infrastructure') {
          // Render a thick, stylish asphalt ribbon for each segment
          for (let i = 0; i < pts.length - 1; i++) {
            const p1 = pts[i];
            const p2 = pts[i + 1];
            const dx = p2.x - p1.x;
            const dy = p2.y - p1.y; // North-South
            const segLen = Math.sqrt(dx * dx + dy * dy);
            if (segLen < 0.1) continue;

            const mx = (p1.x + p2.x) / 2;
            const mz = -(p1.y + p2.y) / 2; // Negate North-South for Three.js Z-axis
            const angle = Math.atan2(dy, dx); // Angle of rotation in XZ

            // Use a gorgeous, high-contrast dark asphalt ribbon (strongly distinct against ground and buildings)
            const roadGeom = new THREE.PlaneGeometry(segLen, 7.5);
            roadGeom.rotateX(-Math.PI / 2); // Lay flat
            roadGeom.rotateY(angle); // Polar rotate

            const roadMat = new THREE.MeshStandardMaterial({
              color: 0x334155, // Charcoal slate asphalt
              roughness: 0.85,
              metalness: 0.1
            });

            const roadMesh = new THREE.Mesh(roadGeom, roadMat);
            roadMesh.position.set(mx, 0.12, mz); // distinct layer height to prevent z-fighting
            roadMesh.receiveShadow = true;
            buildingGroup.add(roadMesh);

            // Add center dashes
            if (current.showOutlines) {
              const dashGeom = new THREE.PlaneGeometry(segLen * 0.95, 0.25);
              dashGeom.rotateX(-Math.PI / 2);
              dashGeom.rotateY(angle);

              const dashMat = new THREE.MeshBasicMaterial({
                color: 0xffffff, // brilliant white dashed center lane
                transparent: true,
                opacity: 0.9
              });

              const dashMesh = new THREE.Mesh(dashGeom, dashMat);
              dashMesh.position.set(mx, 0.018, mz);
              buildingGroup.add(dashMesh);
            }
          }
          return; // skip extrusion
        }

        // --- 2. VEGETATION / FLAT GREEN TERRAIN ---
        if (b.category === 'terrain') {
          if (pts.length < 3) return;

          // Draw green park polygons
          const shape = new THREE.Shape();
          shape.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) {
            shape.lineTo(pts[i].x, pts[i].y);
          }
          shape.closePath();

          const terrainGeom = new THREE.ExtrudeGeometry(shape, { depth: 0.08, bevelEnabled: false });
          terrainGeom.rotateX(-Math.PI / 2);

          const terrainMat = new THREE.MeshStandardMaterial({
            color: 0x86efac, // Vibrant rich pastel park green for highly distinguishable eco zones
            roughness: 0.9,
            metalness: 0.05
          });

          const terrainMesh = new THREE.Mesh(terrainGeom, terrainMat);
          terrainMesh.receiveShadow = true;
          terrainMesh.position.y = 0.05;
          buildingGroup.add(terrainMesh);

          // Add beautiful 3D low-poly conifer trees scattered inside the park area!
          // Compute simple 2D bounding box
          let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
          pts.forEach(p => {
            if (p.x < minX) minX = p.x;
            if (p.x > maxX) maxX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.y > maxY) maxY = p.y;
          });

          // Seeded random tree generation to make it deterministic across rerenders
          let seed = b.id.charCodeAt(b.id.length - 1) || 42;
          const randomSeeded = () => {
            const x = Math.sin(seed++) * 10000;
            return x - Math.floor(x);
          };

          // Scatter trees proportional to park area
          const area = (maxX - minX) * (maxY - minY);
          const numTrees = Math.min(12, Math.max(3, Math.floor(area / 300)));

          for (let t = 0; t < numTrees; t++) {
            const rx = minX + randomSeeded() * (maxX - minX);
            const ry = minY + randomSeeded() * (maxY - minY);

            // Verify if point is physically inside the park footprint
            if (isPointInPolygon({ x: rx, y: ry }, b.enuPoints)) {
              const treeGroup = new THREE.Group();
              treeGroup.position.set(rx, 0.09, -ry);

              // Wood trunk
              const trunkHeight = 1.2 + randomSeeded() * 1.2;
              const trunkGeom = new THREE.CylinderGeometry(0.18, 0.25, trunkHeight, 5);
              const trunkMat = new THREE.MeshStandardMaterial({ color: 0x854d0e, roughness: 0.95 }); // bark brown
              const trunkMesh = new THREE.Mesh(trunkGeom, trunkMat);
              trunkMesh.position.y = trunkHeight / 2;
              trunkMesh.castShadow = true;
              treeGroup.add(trunkMesh);

              // Conical green pine canopy
              const canopyHeight = 2.0 + randomSeeded() * 1.8;
              const canopyRadius = 0.7 + randomSeeded() * 0.7;
              const canopyGeom = new THREE.ConeGeometry(canopyRadius, canopyHeight, 5);
              
              const leafColors = [0x166534, 0x15803d, 0x14532d, 0x15803d];
              const leafColor = leafColors[Math.floor(randomSeeded() * leafColors.length)];
              const canopyMat = new THREE.MeshStandardMaterial({ color: leafColor, roughness: 0.9 });
              const canopyMesh = new THREE.Mesh(canopyGeom, canopyMat);
              canopyMesh.position.y = trunkHeight + canopyHeight / 2 - 0.25;
              canopyMesh.castShadow = true;
              treeGroup.add(canopyMesh);

              buildingGroup.add(treeGroup);
            }
          }
          return;
        }

        // --- 3. WATER BODIES (LAKES / RIVER PIPELINE) ---
        if (b.category === 'water') {
          if (pts.length < 3) return;

          const shape = new THREE.Shape();
          shape.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) {
            shape.lineTo(pts[i].x, pts[i].y);
          }
          shape.closePath();

          const waterGeom = new THREE.ExtrudeGeometry(shape, { depth: 0.03, bevelEnabled: false });
          waterGeom.rotateX(-Math.PI / 2);

          const waterMat = new THREE.MeshStandardMaterial({
            color: 0x0ea5e9, // High-contrast vivid azure glass-blue water surface
            roughness: 0.05,
            metalness: 0.3,
            transparent: true,
            opacity: 0.95
          });

          const waterMesh = new THREE.Mesh(waterGeom, waterMat);
          waterMesh.position.y = 0.08;
          buildingGroup.add(waterMesh);
          return;
        }

        // --- 4. BUILDINGS (DEFAULT RENDERING) ---
        if (pts.length < 3) return;

        const h = b.height;
        const shape = new THREE.Shape();
        // Shape works in 2D coordinates
        // Map East (X) and North (Y) to keep exact rotation directions
        shape.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) {
          shape.lineTo(pts[i].x, pts[i].y);
        }
        shape.closePath();

        const extrudeSettings = {
          depth: h,
          bevelEnabled: false
        };

        const geom = new THREE.ExtrudeGeometry(shape, extrudeSettings);
        // Rotate so depth matches +Y height upright
        geom.rotateX(-Math.PI / 2);

        // Matte, muted, solid buildings — matches Sionna RT's preview look.
        // Each building gets a distinct earthy tone (deterministic by id).
        const meshMat = new THREE.MeshStandardMaterial({
          color: buildingColor(b.id),
          roughness: 0.97,
          metalness: 0.0,
          flatShading: true,
        });

        const mesh = new THREE.Mesh(geom, meshMat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.name = b.id;

        buildingGroup.add(mesh);

        // Optional blueprint edge outlines
        if (current.showOutlines) {
          const edgeGeom = new THREE.EdgesGeometry(geom);
          const outlineLine = new THREE.LineSegments(
            edgeGeom,
            new THREE.LineBasicMaterial({ color: 0x1e293b, linewidth: 1.5 }) // Dark Slate ink-blueprint borders for crisp silhouette
          );
          buildingGroup.add(outlineLine);
        }
      });
    }

    // 7. NODE RENDERING (Tx and Rx panel tower model representations)
    function drawNodes3D() {
      clearGroup(transmitterGroup);
      clearGroup(receiverGroup);

      const current = stateRef.current;

      // Roof height under a device: if it sits over a building footprint, its
      // antenna height is measured from that roof.
      const rooftopZ = (enu: { x: number; y: number }) => {
        const fp = current.buildings.find(
          (b) => b.category === 'building' && b.enuPoints.length >= 3 && isPointInPolygon(enu, b.enuPoints),
        );
        return fp ? fp.height : 0;
      };

      // Draw Transmitter Tower (TX)
      const txEnuPos = { ...current.tx.enu };
      const txBaseZ = rooftopZ(txEnuPos);
      const txThreePos = enuToThree({ ...txEnuPos, z: txBaseZ + current.tx.height });

      // Draw tower pedestal structure
      const towerBaseGeom = new THREE.CylinderGeometry(0.5, 3, txBaseZ + current.tx.height, 4);
      const towerBaseMat = new THREE.MeshStandardMaterial({ color: 0x334155, metalness: 0.8, roughness: 0.2 });
      const towerMesh = new THREE.Mesh(towerBaseGeom, towerBaseMat);
      towerMesh.position.set(txThreePos.x, (txBaseZ + current.tx.height) / 2, txThreePos.z);
      towerMesh.castShadow = true;
      transmitterGroup.add(towerMesh);

      // Pulse red energy dome at transmitter antenna point
      const antennaGeom = new THREE.SphereGeometry(1.5, 16, 16);
      const antennaMat = new THREE.MeshBasicMaterial({ color: 0xef4444 });
      const antennaMesh = new THREE.Mesh(antennaGeom, antennaMat);
      antennaMesh.position.copy(txThreePos);
      transmitterGroup.add(antennaMesh);

      // Name label (e.g. "Tx 1") floating above the active transmitter.
      const txLabel = makeLabelSprite(current.tx.name, '#d9aaa2');
      txLabel.position.set(txThreePos.x, txThreePos.y + 8, txThreePos.z);
      transmitterGroup.add(txLabel);

      // Beam-steering cone — points along the TRUE beam the backend steers.
      // Convention (must match backend _beam_target): azimuth clockwise from
      // North (N=0, E=90), elevation above the horizon. ENU dir =
      // (E=cos(el)sin(az), N=cos(el)cos(az), U=sin(el)); to Three: (E, U, -N).
      const az = ((current.tx.beamsteeringAzimuth || 0) * Math.PI) / 180;
      const el = ((current.tx.beamsteeringElevation || 0) * Math.PI) / 180;
      const beamDir = new THREE.Vector3(
        Math.cos(el) * Math.sin(az),
        Math.sin(el),
        -Math.cos(el) * Math.cos(az),
      ).normalize();

      const beamLen = 28;
      const beamConeGeom = new THREE.ConeGeometry(8, beamLen, 16);
      const beamConeMat = new THREE.MeshBasicMaterial({
        color: 0xfca5a5,
        transparent: true,
        opacity: 0.52,
        wireframe: true,
      });
      const beamCone = new THREE.Mesh(beamConeGeom, beamConeMat);
      // Cone's default axis is +Y; aim it along the beam direction, base at the antenna.
      beamCone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), beamDir);
      beamCone.position.copy(txThreePos).add(beamDir.clone().multiplyScalar(beamLen / 2));
      transmitterGroup.add(beamCone);

      // Draw Receiver Terminal (RX). During mobility playback, use the selected
      // solved sample directly so animation does not mutate the editable Rx state.
      const rxEnuPos = current.activeMode === 'playback' && current.mobilityRxPosition
        ? { ...current.mobilityRxPosition, z: 0 }
        : { ...current.rx.enu };
      const rxBaseZ = rooftopZ(rxEnuPos);
      const rxHeight = current.activeMode === 'playback' && current.mobilityRxPosition
        ? current.mobilityRxPosition.z
        : rxBaseZ + current.rx.height;
      const rxThreePos = enuToThree({ ...rxEnuPos, z: rxHeight });

      // Clean glowing reception dome
      const deviceGeom = new THREE.SphereGeometry(1.2, 16, 16);
      const deviceMat = new THREE.MeshBasicMaterial({ color: 0x3b82f6 });
      const deviceMesh = new THREE.Mesh(deviceGeom, deviceMat);
      deviceMesh.position.copy(rxThreePos);
      receiverGroup.add(deviceMesh);

      const devicePoleGeom = new THREE.CylinderGeometry(0.2, 0.2, rxHeight, 8);
      const devicePoleMat = new THREE.MeshStandardMaterial({ color: 0x475569 });
      const devicePoleMesh = new THREE.Mesh(devicePoleGeom, devicePoleMat);
      devicePoleMesh.position.set(rxThreePos.x, rxHeight / 2, rxThreePos.z);
      receiverGroup.add(devicePoleMesh);

      // Name label (e.g. "Rx 1") floating above the active receiver.
      const rxLabel = makeLabelSprite(current.rx.name, '#a9c2c9');
      rxLabel.position.set(rxThreePos.x, rxThreePos.y + 6, rxThreePos.z);
      receiverGroup.add(rxLabel);

      // ── Markers for the OTHER (non-active) transmitters & receivers ───────
      // The active Tx/Rx already render above with full tower/device geometry;
      // here we add simpler poles+domes so every device in the list is visible.
      const drawMarker = (enu: ENUVector, height: number, color: number, name: string, labelColor: string) => {
        const baseZ = rooftopZ(enu);
        const top = enuToThree({ ...enu, z: baseZ + height });
        const pole = new THREE.Mesh(
          new THREE.CylinderGeometry(0.3, 0.3, baseZ + height, 8),
          new THREE.MeshStandardMaterial({ color: 0x475569, metalness: 0.6, roughness: 0.4 }),
        );
        pole.position.set(top.x, (baseZ + height) / 2, top.z);
        const dome = new THREE.Mesh(
          new THREE.SphereGeometry(1.3, 16, 16),
          new THREE.MeshBasicMaterial({ color }),
        );
        dome.position.copy(top);
        const label = makeLabelSprite(name, labelColor);
        label.position.set(top.x, top.y + 6, top.z);
        return [pole, dome, label];
      };

      (current.txs ?? []).forEach((t) => {
        if (t.id === current.activeTxId) return; // active already drawn
        drawMarker(t.enu, t.height, 0xf87171, t.name, '#d9aaa2').forEach((m) => transmitterGroup.add(m)); // soft red
      });
      (current.rxs ?? []).forEach((r) => {
        if (r.id === current.activeRxId) return;
        drawMarker(r.enu, r.height, 0x60a5fa, r.name, '#a9c2c9').forEach((m) => receiverGroup.add(m)); // soft blue
      });
    }

    // 8. PROPAGATION RAY PATH LINES (LOS & bounces)
    function drawRayPaths3D() {
      clearGroup(pathsGroup);

      const current = stateRef.current;
      // Rays draw in Link/Playback, and in Radio Coverage when the overlay toggle is on.
      const allowRays =
        current.activeMode === 'link' ||
        current.activeMode === 'playback' ||
        (current.activeMode === 'heatmap' && current.showRaysOnHeatmap);
      if (!allowRays) return;

      // Playback must show the active per-step mobility rays. Matrix mode still
      // draws every Tx/Rx pair in link/heatmap overlays.
      const list = current.activeMode !== 'playback' && current.matrixPaths && current.matrixPaths.length > 0
        ? current.matrixPaths
        : current.paths;

      list.forEach(path => {
        const points = path.points.map(enuToThree);
        const geom = new THREE.BufferGeometry().setFromPoints(points);

        // Neon coloring: Link status green, reflections glowing orange splitters
        const color = path.type === 'LOS' ? 0x22c55e : 0xf97316;
        const width = path.type === 'LOS' ? 2.5 : 1.2;

        const mat = new THREE.LineBasicMaterial({
          color: color,
          linewidth: width,
          transparent: true,
          opacity: 0.9
        });

        const line = new THREE.Line(geom, mat);
        pathsGroup.add(line);

        // Stagger animated propagation wave rings moving along the wire!
        points.forEach((pt, pi) => {
          if (pi < points.length - 1) {
            // Render bouncing point spheres
            const ringGeom = new THREE.OctahedronGeometry(0.7, 1);
            const ringMat = new THREE.MeshBasicMaterial({ color: color, wireframe: true });
            const pMesh = new THREE.Mesh(ringGeom, ringMat);
            pMesh.position.copy(pt);
            pathsGroup.add(pMesh);
          }
        });
      });
    }

    // 9. DYNAMIC HEATMAP: Instanced colored grid squares for ultra performance
    function drawRadioMap3D() {
      clearGroup(heatmapGroup);

      const current = stateRef.current;
      if (current.activeMode !== 'heatmap' || !current.radioMap) return;

      const rm = current.radioMap;
      const metric = rm.metric ?? 'power';
      const size = rm.gridSize;

      // Each ground cell carries received power and (for the SINR metric) SINR;
      // colour by whichever metric the map was computed for.
      type ValPt = { x: number; y: number; value: number };
      const valid: ValPt[] = rm.cells
        .map((c) => ({ x: c.x, y: c.y,
          value: metric === 'sinr' ? (c.sinr ?? NaN) : c.powerDbm }))
        .filter((p) => Number.isFinite(p.value) && p.value > -200);
      if (valid.length === 0) return;

      let vmin = Infinity;
      let vmax = -Infinity;
      // Auto-normalize to this map's own min/max. Manual vmin/vmax only applies to
      // the received-power view (the sliders are calibrated in dBm).
      const autoStretch = current.rmAutoRange || metric === 'sinr';
      if (autoStretch) {
        for (const c of valid) {
          if (c.value < vmin) vmin = c.value;
          if (c.value > vmax) vmax = c.value;
        }
      } else {
        // Manual vmin/vmax, like sionna-rt-gui's radio map display sliders.
        vmin = Math.min(current.rmVmin, current.rmVmax);
        vmax = Math.max(current.rmVmin, current.rmVmax);
      }
      const span = vmax - vmin > 1e-6 ? vmax - vmin : 1;

      // Solid cell tiles that tile seamlessly (no gaps), flat on the ground.
      const cellGeom = new THREE.PlaneGeometry(size * 1.02, size * 1.02);
      cellGeom.rotateX(-Math.PI / 2);

      const cellMat = new THREE.MeshBasicMaterial({
        side: THREE.DoubleSide,
        transparent: false,
        opacity: 1.0,
      });

      const instMesh = new THREE.InstancedMesh(cellGeom, cellMat, valid.length);
      instMesh.renderOrder = 3; // draw cleanly over the ground grid
      const dummy = new THREE.Object3D();
      const tmp = new THREE.Color();

      valid.forEach((cell, idx) => {
        // Sit just above the ground plane so the field reads as painted on it.
        const threePos = enuToThree({ x: cell.x, y: cell.y, z: 0.2 });
        dummy.position.copy(threePos);
        dummy.updateMatrix();
        instMesh.setMatrixAt(idx, dummy.matrix);

        const t0 = (cell.value - vmin) / span;
        let t = t0;
        if (autoStretch) {
          // Auto mode: contrast stretch + brightening gamma so the upper range
          // pops. Manual vmin/vmax maps linearly, matching sionna-rt-gui.
          const CONTRAST = 1.7;
          t = (t0 - 0.5) * CONTRAST + 0.5;
          t = Math.min(1, Math.max(0, t));
          t = Math.pow(t, 0.78);
        } else {
          t = Math.min(1, Math.max(0, t));
        }
        colormapColor(current.rmColormap, t, tmp);
        if (autoStretch) {
          const hsl = { h: 0, s: 0, l: 0 };
          tmp.getHSL(hsl);
          tmp.setHSL(hsl.h, Math.min(1, hsl.s * 1.3), hsl.l);
        }
        instMesh.setColorAt(idx, tmp);
      });

      instMesh.instanceColor!.needsUpdate = true;
      heatmapGroup.add(instMesh);
    }


    function drawTrajectory3D() {
      clearGroup(trajectoryGroup);

      const current = stateRef.current;
      if (current.trajectoryPoints.length === 0) return;

      const pts = current.trajectoryPoints.map((p) => enuToThree({ ...p.enu, z: 0.35 }));
      if (pts.length >= 2) {
        const geom = new THREE.BufferGeometry().setFromPoints(pts);
        const mat = new THREE.LineBasicMaterial({ color: 0x10b981, transparent: true, opacity: 0.95 });
        const line = new THREE.Line(geom, mat);
        trajectoryGroup.add(line);
      }

      pts.forEach((pt, idx) => {
        const color = idx === 0 ? 0x10b981 : idx === pts.length - 1 ? 0xf27d26 : 0xe2e8f0;
        const marker = new THREE.Mesh(
          new THREE.SphereGeometry(idx === 0 || idx === pts.length - 1 ? 1.1 : 0.75, 12, 12),
          new THREE.MeshBasicMaterial({ color }),
        );
        marker.position.copy(pt);
        trajectoryGroup.add(marker);
      });
    }

    // Initial build — the dynamic layers (nodes/rays/heatmap/trajectory) draw on
    // the first animation frame via the change watcher below.
    rebuildBuildings3D();

    // 10. ANCHORED RAYCAST EVENT LISTENER (Snaps Tx / Rx precisely onto ground/roof points)
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    function handleContainerClick(e: MouseEvent) {
      const current = stateRef.current;
      if (current.placementMode === 'none' && !(current.activeMode === 'playback' && current.pathDrawingMode)) return;

      // Calculate mouse canvas click coords
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);

      // Target buildings first for roof placement, fallback to ground slab
      const intersects = raycaster.intersectObjects([ground, ...buildingGroup.children], true);

      if (intersects.length > 0) {
        const firstHit = intersects[0];
        const hitPt = firstHit.point;

        // Convert Three coordinate click back to ENU metrics
        // ENU.x = 3D.X
        // ENU.y = -3D.Z
        // Height calculated independently or bound to relative offset
        const east = hitPt.x;
        const north = -hitPt.z;

        if (current.activeMode === 'playback' && current.pathDrawingMode) {
          const enu = { x: east, y: north, z: 0 };
          const ll = enuToLatLon(enu, current.anchor);
          current.setTrajectoryPoints([
            ...current.trajectoryPoints,
            { lat: ll.lat, lon: ll.lon, enu },
          ]);
          return;
        }

        if (current.placementMode === 'tx') {
          const updatedTx: Transmitter = {
            ...current.tx,
            enu: { x: east, y: north, z: 0 }
          };
          current.onTxUpdate(updatedTx);
        } else if (current.placementMode === 'rx') {
          const updatedRx: Receiver = {
            ...current.rx,
            enu: { x: east, y: north, z: 0 }
          };
          current.onRxUpdate(updatedRx);
        }

        // Auto release action Mode picker
        current.setPlacementMode('none');
      }
    }

    function handleMouseMove(e: MouseEvent) {
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObjects([ground, ...buildingGroup.children], true);

      if (intersects.length > 0) {
        const hitPt = intersects[0].point;
        setHoveredCoordinate({
          x: hitPt.x,
          y: -hitPt.z,
          z: hitPt.y
        });
      } else {
        setHoveredCoordinate(null);
      }
    }

    renderer.domElement.addEventListener('click', handleContainerClick);
    renderer.domElement.addEventListener('mousemove', handleMouseMove);

    // 11. CENTRALIZED REALTIME ANIMATION DRAW LOOP
    let animationFrameId: number;
    let lastTime = performance.now();
    let frameCount = 0;

    // Redraw each dynamic layer only when one of its inputs actually changed.
    // App state updates are immutable, so reference comparison is exact — no
    // string keys, no polling interval, no rebuild churn.
    type Snapshot = Partial<typeof stateRef.current>;
    let prev: Snapshot | null = null;

    const watchAndRedraw = () => {
      const c = stateRef.current;
      const first = prev === null;
      const p = prev ?? ({} as Snapshot);

      if (!first && c.showOutlines !== p.showOutlines) rebuildBuildings3D();
      if (first || c.tx !== p.tx || c.rx !== p.rx || c.txs !== p.txs || c.rxs !== p.rxs ||
          c.activeTxId !== p.activeTxId || c.activeRxId !== p.activeRxId ||
          c.activeMode !== p.activeMode || c.mobilityRxPosition !== p.mobilityRxPosition ||
          c.showOutlines !== p.showOutlines) {
        drawNodes3D();
      }
      if (first || c.paths !== p.paths || c.matrixPaths !== p.matrixPaths ||
          c.activeMode !== p.activeMode || c.showRaysOnHeatmap !== p.showRaysOnHeatmap) {
        drawRayPaths3D();
      }
      if (first || c.radioMap !== p.radioMap || c.activeMode !== p.activeMode ||
          c.rmColormap !== p.rmColormap || c.rmAutoRange !== p.rmAutoRange ||
          c.rmVmin !== p.rmVmin || c.rmVmax !== p.rmVmax) {
        drawRadioMap3D();
      }
      if (first || c.trajectoryPoints !== p.trajectoryPoints) drawTrajectory3D();

      prev = { ...c };
    };

    const animate = () => {
      animationFrameId = requestAnimationFrame(animate);

      // FPS tracking counter (skip the state update when the reading is stable
      // so an idle scene doesn't re-render React every second).
      const time = performance.now();
      frameCount++;
      if (time >= lastTime + 1000) {
        const fpsNow = Math.round((frameCount * 1000) / (time - lastTime));
        setFps((old) => (Math.abs(old - fpsNow) > 1 ? fpsNow : old));
        frameCount = 0;
        lastTime = time;
      }

      watchAndRedraw();

      // Camera dynamic lock mode
      const current = stateRef.current;
      if (current.cameraMode === 'lockTx') {
        const txPos = enuToThree({ ...current.tx.enu, z: current.tx.height });
        controls.target.lerp(txPos, 0.1);
      }

      controls.update();
      renderer.render(scene, camera);
    };

    animate();

    // 12. DYNAMIC STATE WATCHERS
    const resizeObserver = new ResizeObserver(() => {
      if (!containerRef.current) return;
      const w = containerRef.current.clientWidth;
      const h = containerRef.current.clientHeight || 580;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      cancelAnimationFrame(animationFrameId);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener('click', handleContainerClick);
      renderer.domElement.removeEventListener('mousemove', handleMouseMove);
      controls.dispose();
      // Release every GPU resource this effect created.
      [buildingGroup, transmitterGroup, receiverGroup, pathsGroup,
       heatmapGroup, trajectoryGroup, interactionGroup].forEach(clearGroup);
      ground.geometry.dispose();
      groundMat.dispose();
      gridHelper.geometry.dispose();
      (gridHelper.material as THREE.Material).dispose();
      renderer.dispose();
    };
  }, [buildings, performanceMode]);


  return (
    <div id="three-studio-frame" className="relative flex-1 min-h-[420px] bg-slate-50 border border-slate-200 rounded overflow-hidden shadow-xl flex flex-col">
      {/* 3D Canvas rendering window */}
      <div ref={containerRef} className="w-full flex-1 relative min-h-[320px]">
        <canvas ref={canvasRef} id="canvas-3d" className="w-full h-full block" />

        {/* Floating coordinate helper & action HUD */}
        <div className="absolute top-4 left-4 bg-white/95 backdrop-blur-md shadow-lg rounded px-4 py-3.5 border border-slate-200 flex flex-col gap-1 text-slate-800 pointer-events-none z-10 transition-all max-w-xs">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[#5f7f5a] animate-pulse" />
            <h4 className="eyebrow">3D PROPAGATION FIELD</h4>
          </div>
          <p className="text-[13px] text-slate-500 font-mono">
            {hoveredCoordinate
              ? `ENU m: E ${hoveredCoordinate.x.toFixed(1)}, N ${hoveredCoordinate.y.toFixed(1)}, Alt ${hoveredCoordinate.z.toFixed(1)}`
              : 'Hover to raycast coordinates'}
          </p>
          {(placementMode !== 'none' || (pathDrawingMode && activeMode === 'playback')) && (
            <div className="mt-2 text-[12px] py-1 px-2.5 bg-[#cc785c]/10 text-[#cc785c] animate-pulse rounded border border-[#cc785c]/30 font-semibold flex items-center gap-1.5">
              <Compass className="w-3.5 h-3.5 rotate-45" />
              <span>{pathDrawingMode && activeMode === 'playback' ? 'Click canvas to add path waypoint' : `Click canvas to place ${placementMode.toUpperCase()}`}</span>
            </div>
          )}
        </div>

        {/* Hovering Toolbar panel */}
        <div className="absolute bottom-4 left-4 right-4 flex flex-wrap justify-between items-center gap-3 bg-white/95 backdrop-blur-md border border-slate-200 p-2 rounded shadow-lg z-10 pointer-events-auto">
          {/* Quick Nodes Placement Actions */}
          <div className="flex items-center gap-2">
            <button
              id="btn-place-tx"
              title="Click to place Transmitter antenna node over map"
              onClick={() => setPlacementMode(placementMode === 'tx' ? 'none' : 'tx')}
              className={cn(
                "px-3.5 py-1.5 text-[12px] font-bold rounded flex items-center gap-1.5  transition-all shadow-sm cursor-pointer border",
                placementMode === 'tx'
                  ? "bg-[#cc785c] text-white border-transparent scale-95"
                  : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50 hover:text-slate-900"
              )}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-[#cc785c] animate-ping" />
              Place TX Antenna
            </button>

            <button
              id="btn-place-rx"
              title="Click to place Receiver device terminal node"
              onClick={() => setPlacementMode(placementMode === 'rx' ? 'none' : 'rx')}
              className={cn(
                "px-3.5 py-1.5 text-[12px] font-bold rounded flex items-center gap-1.5  transition-all shadow-sm cursor-pointer border",
                placementMode === 'rx'
                  ? "bg-[#4a727e] text-white border-transparent scale-95"
                  : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50 hover:text-slate-900"
              )}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-[#6d939e] animate-pulse" />
              Place RX Device
            </button>

            {activeMode === 'playback' && (
              <>
                <button
                  id="btn-draw-3d-mobility-path"
                  title="Click ground or rooftops in the 3D scene to add receiver trajectory waypoints"
                  onClick={() => setPathDrawingMode(!pathDrawingMode)}
                  className={cn(
                    "px-3.5 py-1.5 text-[12px] font-bold rounded flex items-center gap-1.5  transition-all shadow-sm cursor-pointer border",
                    pathDrawingMode
                      ? "bg-[#5f7f5a] text-white border-transparent scale-95"
                      : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50 hover:text-slate-900"
                  )}
                >
                  Draw Path
                </button>
                <button
                  id="btn-undo-3d-mobility-path"
                  title="Remove the last receiver trajectory waypoint"
                  onClick={() => setTrajectoryPoints(trajectoryPoints.slice(0, -1))}
                  disabled={trajectoryPoints.length === 0}
                  className="px-3.5 py-1.5 text-[12px] font-bold rounded transition shadow-sm cursor-pointer border bg-white text-slate-700 border-slate-200 hover:bg-slate-50 disabled:text-slate-300 disabled:bg-slate-100"
                >
                  Undo
                </button>
                <button
                  id="btn-clear-3d-mobility-path"
                  title="Clear receiver trajectory waypoints"
                  onClick={() => setTrajectoryPoints([])}
                  disabled={trajectoryPoints.length === 0}
                  className="px-3.5 py-1.5 text-[12px] font-bold rounded transition shadow-sm cursor-pointer border bg-white text-slate-700 border-slate-200 hover:bg-slate-50 disabled:text-slate-300 disabled:bg-slate-100"
                >
                  Clear
                </button>
              </>
            )}
          </div>

          {/* Aesthetic Controls */}
          <div className="flex items-center gap-1">
            <button
              title="Blueprint outlines toggle"
              onClick={() => setShowOutlines(!showOutlines)}
              className={cn(
                "p-1.5 border hover:text-slate-900 hover:bg-slate-50 rounded duration-150 cursor-pointer text-[12px] font-bold ",
                showOutlines ? "border-[#cc785c]/40 bg-[#cc785c]/10 text-[#cc785c]" : "border-slate-200 bg-white text-slate-600"
              )}
            >
              Outlines
            </button>

            <button
              title="Camera steering tracking toggle"
              onClick={() => setCameraMode(cameraMode === 'orbit' ? 'lockTx' : 'orbit')}
              className={cn(
                "p-1.5 border hover:text-slate-900 hover:bg-slate-50 rounded duration-150 cursor-pointer flex items-center gap-1 text-[12px] font-bold ",
                cameraMode === 'lockTx' ? "border-[#cc785c]/40 bg-[#cc785c]/10 text-[#cc785c]" : "border-slate-200 bg-white text-slate-600"
              )}
            >
              <Compass className={cn("w-3.5 h-3.5", cameraMode === 'lockTx' && "animate-spin")} />
              {cameraMode === 'lockTx' ? 'Target: TX' : 'Free Camera'}
            </button>

            <button
              title="Performance profiling settings toggler"
              onClick={() => setPerformanceMode(performanceMode === 'high' ? 'eco' : 'high')}
              className="p-1.5 border border-slate-200 bg-white hover:bg-slate-50 text-slate-600 hover:text-slate-900 rounded cursor-pointer shadow-sm text-[12px] font-bold"
            >
              {performanceMode === 'high' ? '🔋 High' : '🔋 Eco'}
            </button>
          </div>
        </div>

        {/* Tiny live frame stats tag */}
        <div className="absolute top-4 right-4 bg-white/95 border border-slate-200 backdrop-blur-md rounded px-2.5 py-1 text-[12px] text-slate-600 font-mono shadow-sm flex items-center gap-1.5 z-10 select-none">
          <Activity className="w-3 h-3 text-[#5f7f5a]" />
          <span>{fps} FPS</span>
          <span className="text-slate-400">|</span>
          <span>WebMesh</span>
        </div>
      </div>
    </div>
  );
}
