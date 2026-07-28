/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo } from 'react';
import { BuildingFootprint, GeoAnchor, MaterialConfig, ScatteringPattern } from '../types';
import { Search, Filter, Building, Compass, Milestone, TreePine, Droplet, Hash, Ruler, Layers } from 'lucide-react';

interface GeographyPanelProps {
  buildings: BuildingFootprint[];
  anchor: GeoAnchor;
  materialIds: string[];
  materialConfigs: MaterialConfig[];
  onMaterialChange: (cfg: MaterialConfig) => void;
}

export function GeographyPanel({ buildings, anchor, materialIds, materialConfigs, onMaterialChange }: GeographyPanelProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');

  // Compute stats on current geographic twin
  const stats = useMemo(() => {
    const totalCount = buildings.length;
    const structures = buildings.filter((b) => b.category === 'building');
    const buildingCount = structures.length;
    const roadCount = buildings.filter((b) => b.category === 'infrastructure').length;
    const parkCount = buildings.filter((b) => b.category === 'terrain').length;
    const waterCount = buildings.filter((b) => b.category === 'water').length;

    let totalHeightSum = 0;
    let maxBuildingHeight = 0;
    let concreteCount = 0;
    let glassCount = 0;
    let brickCount = 0;
    let metalCount = 0;

    for (const b of structures) {
      totalHeightSum += b.height;
      if (b.height > maxBuildingHeight) {
        maxBuildingHeight = b.height;
      }
      if (b.material === 'itu_concrete') concreteCount++;
      else if (b.material === 'itu_glass') glassCount++;
      else if (b.material === 'itu_brick') brickCount++;
      else if (b.material === 'itu_metal') metalCount++;
    }

    const averageHeight = buildingCount > 0 ? totalHeightSum / buildingCount : 0;

    return {
      totalCount,
      buildingCount,
      roadCount,
      parkCount,
      waterCount,
      averageHeight,
      maxBuildingHeight,
      materials: {
        concrete: concreteCount,
        glass: glassCount,
        brick: brickCount,
        metal: metalCount,
        others: Math.max(0, buildingCount - (concreteCount + glassCount + brickCount + metalCount)),
      },
    };
  }, [buildings]);

  // Filter structures list
  const filteredBuildings = useMemo(() => {
    return buildings.filter((b) => {
      // search match
      const label = `${b.id} ${b.type} ${b.material}`.toLowerCase();
      const matchesSearch = label.includes(searchTerm.toLowerCase());

      // category match
      const matchesCategory = categoryFilter === 'all' || b.category === categoryFilter;

      return matchesSearch && matchesCategory;
    });
  }, [buildings, searchTerm, categoryFilter]);

  // Map material text to human readable strings
  const getMaterialLabel = (mat: string) => {
    switch (mat) {
      case 'itu_concrete':
        return 'Standard Concrete';
      case 'itu_glass':
        return 'Sapphire Glass';
      case 'itu_brick':
        return 'Thermal Brick';
      case 'itu_metal':
        return 'Polished Metal';
      default:
        return 'Dry Ground / Base';
    }
  };

  return (
    <div id="geography-insights-panel" className="panel p-5 flex flex-col gap-6 h-full overflow-y-auto">
      {/* Header section */}
      <div className="flex items-center gap-2 border-b border-[#e3e0d6] pb-3">
        <Compass className="w-5 h-5 text-[#cc785c] animate-spin-slow" />
        <div>
          <h3 className="panel-title">Geographic Physical Twin Information</h3>
          <p className="text-[12px] text-[#6b6862] font-semibold">Loaded Coordinates & Structure Classifications</p>
        </div>
      </div>

      {/* Anchor Meta Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="bg-[#f5f3ec] p-3 rounded border border-[#e3e0d6] flex flex-col gap-1">
          <span className="text-[11px] text-[#6b6862] font-bold">Active Anchor Location</span>
          <span className="text-[14px] font-mono font-bold text-[#141413]">
            {anchor.latitude.toFixed(6)}°N, {anchor.longitude.toFixed(6)}°E
          </span>
          <span className="text-[11px] text-green-500 font-bold font-mono">WGS84 Reference Spherical EPSG:4326</span>
        </div>

        <div className="bg-[#f5f3ec] p-3 rounded border border-[#e3e0d6] flex flex-col gap-1">
          <span className="text-[11px] text-[#6b6862] font-bold">Twin Bounding Extent</span>
          <span className="text-[14px] font-mono font-bold text-[#141413]">~ 400m × 500m area</span>
          <span className="text-[11px] text-[#cc785c] font-bold">Local ENU Coordinates Anchored</span>
        </div>

        <div className="bg-[#f5f3ec] p-3 rounded border border-[#e3e0d6] flex flex-col gap-1">
          <span className="text-[11px] text-[#6b6862] font-bold">Feature Population</span>
          <span className="text-[14px] font-mono font-bold text-[#141413]">
            {stats.totalCount} active nodes mapped
          </span>
          <span className="text-[11px] text-slate-600 font-bold">Extruded & Rendered Layers</span>
        </div>
      </div>

      {/* Material editor — per-material scattering + EM overrides (Sionna RadioMaterial) */}
      {materialIds.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-[#cc785c]" />
            <h4 className="panel-title">Material & Scattering Editor</h4>
          </div>
          <p className="text-[12px] text-slate-600 leading-relaxed -mt-1">
            Tune the diffuse scattering coefficient, cross-pol (XPD) and scattering pattern per material.
            Sent with every solve; changes re-trace the scene.
          </p>
          <div className="flex flex-col gap-3">
            {materialIds.map((id) => {
              const cfg = materialConfigs.find((m) => m.id === id)
                ?? { id, scatteringCoefficient: 0, xpdCoefficient: 0, scatteringPattern: 'none' as ScatteringPattern };
              return (
                <div key={id} className="bg-[#f5f3ec] border border-[#e3e0d6] rounded p-3 flex flex-col gap-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[13px] font-bold text-slate-800">{getMaterialLabel(id)}</span>
                    <span className="text-[11px] font-mono text-slate-500">{id}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] text-slate-600 font-bold">Scattering S: {cfg.scatteringCoefficient.toFixed(2)}</span>
                      <input
                        type="range" min="0" max="1" step="0.05"
                        className="accent-[#cc785c] cursor-ew-resize"
                        value={cfg.scatteringCoefficient}
                        onChange={(e) => onMaterialChange({ ...cfg, scatteringCoefficient: parseFloat(e.target.value) })}
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] text-slate-600 font-bold">XPD: {cfg.xpdCoefficient.toFixed(2)}</span>
                      <input
                        type="range" min="0" max="1" step="0.05"
                        className="accent-[#cc785c] cursor-ew-resize"
                        value={cfg.xpdCoefficient}
                        onChange={(e) => onMaterialChange({ ...cfg, xpdCoefficient: parseFloat(e.target.value) })}
                      />
                    </label>
                  </div>
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] text-slate-600 font-bold">Scattering Pattern</span>
                    <select
                      className="text-[14px] py-1.5 px-2 bg-white border border-[#e3e0d6] rounded text-slate-900 focus:outline-none focus:border-[#cc785c] cursor-pointer"
                      value={cfg.scatteringPattern}
                      onChange={(e) => onMaterialChange({ ...cfg, scatteringPattern: e.target.value as ScatteringPattern })}
                    >
                      <option value="none">None (specular only)</option>
                      <option value="lambertian">Lambertian (uniform)</option>
                      <option value="directive">Directive</option>
                      <option value="backscattering">Backscattering</option>
                    </select>
                  </label>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Numerical Metrics Cards */}
      <h4 className="eyebrow -mb-3">
         Statistical Breakdown of Mapped Structures
      </h4>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="panel-flush p-3 flex items-center gap-3">
          <div className="p-2.5 bg-[#ebe7dc] border border-[#e3e0d6] rounded text-[#4a727e]">
            <Building className="w-4 h-4" />
          </div>
          <div className="flex flex-col">
            <span className="text-[11px] text-slate-600 font-bold">Buildings</span>
            <span className="text-[20px] font-bold font-mono text-slate-900">{stats.buildingCount}</span>
          </div>
        </div>

        <div className="panel-flush p-3 flex items-center gap-3">
          <div className="p-2.5 bg-[#ebe7dc] border border-[#e3e0d6] rounded text-slate-600">
            <Milestone className="w-4 h-4" />
          </div>
          <div className="flex flex-col">
            <span className="text-[11px] text-slate-600 font-bold">Roads</span>
            <span className="text-[20px] font-bold font-mono text-slate-900">{stats.roadCount}</span>
          </div>
        </div>

        <div className="panel-flush p-3 flex items-center gap-3">
          <div className="p-2.5 bg-[#ebe7dc] border border-[#e3e0d6] rounded text-[#5f7f5a]">
            <TreePine className="w-4 h-4" />
          </div>
          <div className="flex flex-col">
            <span className="text-[11px] text-slate-600 font-bold">Parks/Forests</span>
            <span className="text-[20px] font-bold font-mono text-slate-900">{stats.parkCount}</span>
          </div>
        </div>

        <div className="panel-flush p-3 flex items-center gap-3">
          <div className="p-2.5 bg-[#ebe7dc] border border-[#e3e0d6] rounded text-[#4a727e]">
            <Droplet className="w-4 h-4" />
          </div>
          <div className="flex flex-col">
            <span className="text-[11px] text-slate-600 font-bold">Waterways</span>
            <span className="text-[20px] font-bold font-mono text-slate-900">{stats.waterCount}</span>
          </div>
        </div>
      </div>

      {/* Extrusion Height statistics */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-[#f5f3ec] border border-[#e3e0d6] rounded p-4">
        <div className="flex flex-col gap-2">
          <h4 className="eyebrow flex items-center gap-1.5">
            <Ruler className="w-3.5 h-3.5 text-[#cc785c]" /> Extrusion Geometry Analysis
          </h4>
          <div className="flex justify-between border-b border-[#e3e0d6] py-2 text-[14px]">
            <span className="text-slate-600 font-medium">Average Building height:</span>
            <span className="font-bold font-mono text-slate-900">{stats.averageHeight.toFixed(1)} meters</span>
          </div>
          <div className="flex justify-between border-b border-[#e3e0d6] py-2 text-[14px]">
            <span className="text-slate-600 font-medium">Max Building height:</span>
            <span className="font-bold font-mono text-slate-900">{stats.maxBuildingHeight.toFixed(1)} meters</span>
          </div>
          <div className="flex justify-between py-2 text-[14px]">
            <span className="text-slate-600 font-medium">Approximate Volumetric Footprint:</span>
            <span className="font-bold font-mono text-[#cc785c]">
              {(stats.buildingCount * stats.averageHeight * 240).toLocaleString(undefined, { maximumFractionDigits: 0 })} m³
            </span>
          </div>
        </div>

        {/* Material Distribution Bars */}
        <div className="flex flex-col gap-2">
          <h4 className="eyebrow flex items-center gap-1.5">
            <Hash className="w-3.5 h-3.5 text-[#cc785c]" /> Material Classification Count
          </h4>

          {/* Concrete */}
          <div className="flex flex-col gap-1">
            <div className="flex justify-between text-[13px] font-mono leading-none">
              <span className="text-slate-600">Concrete ({stats.materials.concrete})</span>
              <span className="text-slate-600 font-bold">
                {stats.buildingCount > 0 ? ((stats.materials.concrete / stats.buildingCount) * 100).toFixed(0) : 0}%
              </span>
            </div>
            <div className="w-full h-1.5 rounded bg-slate-100">
              <div
                className="h-full bg-slate-400 rounded"
                style={{ width: `${stats.buildingCount > 0 ? (stats.materials.concrete / stats.buildingCount) * 100 : 0}%` }}
              />
            </div>
          </div>

          {/* Glass */}
          <div className="flex flex-col gap-1">
            <div className="flex justify-between text-[13px] font-mono leading-none">
              <span className="text-slate-600">Sapphire Glass ({stats.materials.glass})</span>
              <span className="text-slate-600 font-bold">
                {stats.buildingCount > 0 ? ((stats.materials.glass / stats.buildingCount) * 100).toFixed(0) : 0}%
              </span>
            </div>
            <div className="w-full h-1.5 rounded bg-slate-100">
              <div
                className="h-full bg-[#4a727e] rounded"
                style={{ width: `${stats.buildingCount > 0 ? (stats.materials.glass / stats.buildingCount) * 100 : 0}%` }}
              />
            </div>
          </div>

          {/* Brick */}
          <div className="flex flex-col gap-1">
            <div className="flex justify-between text-[13px] font-mono leading-none">
              <span className="text-slate-600">Terracotta Brick ({stats.materials.brick})</span>
              <span className="text-slate-600 font-bold">
                {stats.buildingCount > 0 ? ((stats.materials.brick / stats.buildingCount) * 100).toFixed(0) : 0}%
              </span>
            </div>
            <div className="w-full h-1.5 rounded bg-slate-100">
              <div
                className="h-full bg-[#b2624a] rounded"
                style={{ width: `${stats.buildingCount > 0 ? (stats.materials.brick / stats.buildingCount) * 100 : 0}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Interactive Map Filter & Table Directory */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-col md:flex-row gap-3 items-center justify-between">
          <h4 className="eyebrow">
            Coordinate Node Classification Directory
          </h4>

          {/* Search Table and filters */}
          <div className="flex flex-wrap items-center gap-3 w-full md:w-auto">
            <div className="relative flex-1 md:flex-initial">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-600" />
              <input
                type="text"
                placeholder="Search by ID/Type..."
                className="text-[14px] bg-[#f5f3ec] border border-[#e3e0d6] rounded pl-8 pr-3 py-1.5 text-slate-900 placeholder-slate-500 focus:outline-none focus:border-[#cc785c] w-full md:w-48"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>

            {/* Category selection filter dropdown */}
            <div className="flex items-center gap-1.5">
              <Filter className="w-3.5 h-3.5 text-slate-600" />
              <select
                className="text-[13px] bg-[#f5f3ec] border border-[#e3e0d6] rounded px-2 py-1.5 text-slate-900 font-medium focus:outline-none focus:border-[#cc785c]"
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
              >
                <option value="all">All Layers</option>
                <option value="building">Buildings</option>
                <option value="infrastructure">Infrastructure</option>
                <option value="terrain">Parks & Terrain</option>
                <option value="water">Water Bodies</option>
              </select>
            </div>
          </div>
        </div>

        {/* List table */}
        <div className="border border-[#e3e0d6] rounded text-[14px] overflow-hidden max-h-[200px] overflow-y-auto bg-[#f5f3ec]">
          <table className="w-full text-left font-mono">
            <thead className="bg-[#ffffff] border-b border-[#e3e0d6] sticky top-0 text-[11px] text-slate-600 font-bold">
              <tr>
                <th className="py-2.5 px-3">Structure ID / Layer</th>
                <th className="py-2.5 px-3">Classification</th>
                <th className="py-2.5 px-3">Geo-Height</th>
                <th className="py-2.5 px-3">Surface Material</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#e3e0d6] text-[13px] text-[#6b6862]">
              {filteredBuildings.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-6 px-3 text-center text-slate-600">
                    No nodes matching your query criteria.
                  </td>
                </tr>
              ) : (
                filteredBuildings.map((b) => (
                  <tr key={b.id} className="hover:bg-[#ebe7dc]/40 transition duration-150 text-slate-700">
                    <td className="py-2 px-3 flex items-center gap-2">
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${
                          b.category === 'building'
                            ? 'bg-[#4a727e]'
                            : b.category === 'infrastructure'
                            ? 'bg-slate-400'
                            : b.category === 'terrain'
                            ? 'bg-[#5f7f5a]'
                            : 'bg-[#4a727e]'
                        }`}
                      />
                      <span className="font-sans font-bold">{b.id}</span>
                    </td>
                    <td className="py-2 px-3 text-slate-600 capitalize">{b.type || 'Undefined'}</td>
                    <td className="py-2 px-3 text-slate-600 font-mono font-semibold">
                      {b.category === 'infrastructure' || b.category === 'terrain' || b.category === 'water' ? 'Ground Plan' : `${b.height.toFixed(1)} meters`}
                    </td>
                    <td className="py-2 px-3 select-all cursor-copy text-[14px] text-slate-600">
                      {getMaterialLabel(b.material)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
