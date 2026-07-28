/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { RadioMapGrid, CoverageMetric } from '../types';
import { ColormapName, COLORMAP_NAMES, colormapCssGradient } from '../lib/colormaps';
import { Waves, Activity, Navigation } from 'lucide-react';
import { NumberField } from './NumberField';

interface CoveragePanelProps {
  txCount: number;
  backendOnline: boolean;
  onRunHeatmap: (resolution: number, height: number, samplesPerTx: number, seed: number) => void;
  heatmapLoading: boolean;
  radioMap: RadioMapGrid | null;
  coverageMetric: CoverageMetric;
  setCoverageMetric: (m: CoverageMetric) => void;
  coverageBandwidthMhz: number;
  setCoverageBandwidthMhz: (v: number) => void;
  coverageNoiseFigureDb: number;
  setCoverageNoiseFigureDb: (v: number) => void;
  coverageHeight: number;
  setCoverageHeight: (v: number) => void;
  coverageRes: number;
  setCoverageRes: (v: number) => void;
  samplesPerTx: number;
  setSamplesPerTx: (v: number) => void;
  radioMapSeed: number;
  setRadioMapSeed: (v: number) => void;
  showRaysOnHeatmap: boolean;
  setShowRaysOnHeatmap: (v: boolean) => void;
  rmColormap: ColormapName;
  setRmColormap: (c: ColormapName) => void;
  rmAutoRange: boolean;
  setRmAutoRange: (v: boolean) => void;
  rmVmin: number;
  setRmVmin: (v: number) => void;
  rmVmax: number;
  setRmVmax: (v: number) => void;
  solveError: string;
}

// RADIO COVERAGE VIEWPORT — Sionna RadioMapSolver controls, display, KPIs.
export function CoveragePanel({
  txCount,
  backendOnline,
  onRunHeatmap,
  heatmapLoading,
  radioMap,
  coverageMetric,
  setCoverageMetric,
  coverageBandwidthMhz,
  setCoverageBandwidthMhz,
  coverageNoiseFigureDb,
  setCoverageNoiseFigureDb,
  coverageHeight,
  setCoverageHeight,
  coverageRes,
  setCoverageRes,
  samplesPerTx,
  setSamplesPerTx,
  radioMapSeed,
  setRadioMapSeed,
  showRaysOnHeatmap,
  setShowRaysOnHeatmap,
  rmColormap,
  setRmColormap,
  rmAutoRange,
  setRmAutoRange,
  rmVmin,
  setRmVmin,
  rmVmax,
  setRmVmax,
  solveError,
}: CoveragePanelProps) {
  const coverageStats = radioMap?.stats ?? null;

  return (
    <div className="panel p-4 flex flex-col gap-4">
      <div className="flex items-center gap-1.5 justify-between">
        <div className="flex items-center gap-1.5">
          <Waves className="w-4 h-4 text-[#cc785c]" />
          <h3 className="panel-title">Coverage Solver</h3>
        </div>
        <span className="text-[11px] px-2 py-0.5 rounded font-bold border bg-[#ebe7dc] border-[#e3e0d6] text-slate-600">
          {txCount > 1 ? `Best-server · ${txCount} Tx` : 'Single Tx'}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3.5">
        <div className="flex flex-col gap-1">
          <label className="text-[12px] text-slate-600 font-bold">Grid Height Offset: {coverageHeight}m</label>
          <input
            type="range"
            min="0.5"
            max="10"
            step="0.5"
            className="accent-[#cc785c] cursor-ew-resize"
            value={coverageHeight}
            onChange={(e) => setCoverageHeight(parseFloat(e.target.value))}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[12px] text-slate-600 font-bold">Grid Step: {coverageRes}m</label>
          <input
            type="range"
            min="3"
            max="12"
            step="1"
            className="accent-[#cc785c] cursor-ew-resize"
            value={coverageRes}
            onChange={(e) => setCoverageRes(parseInt(e.target.value, 10))}
          />
        </div>
      </div>

      {/* Metric — interference-aware SINR vs. received power */}
      <div className="flex flex-col gap-1">
        <label className="text-[12px] text-slate-600 font-bold">Metric</label>
        <select
          id="select-coverage-metric"
          className="text-[14px] py-1.5 px-2 bg-white border border-[#e3e0d6] rounded text-slate-900 focus:outline-none focus:border-[#cc785c] cursor-pointer"
          value={coverageMetric}
          onChange={(e) => setCoverageMetric(e.target.value as CoverageMetric)}
        >
          <option value="power">Received Power (dBm)</option>
          <option value="sinr">SINR (dB)</option>
        </select>
      </div>

      {/* Noise model — only affects interference-aware SINR */}
      {coverageMetric === 'sinr' && (
        <div className="grid grid-cols-2 gap-3.5">
          <div className="flex flex-col gap-1">
            <label className="text-[12px] text-slate-600 font-bold">Bandwidth: {coverageBandwidthMhz} MHz</label>
            <input
              type="range" min="1" max="400" step="1"
              className="accent-[#cc785c] cursor-ew-resize"
              value={coverageBandwidthMhz}
              onChange={(e) => setCoverageBandwidthMhz(parseInt(e.target.value, 10))}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[12px] text-slate-600 font-bold">Noise Figure: {coverageNoiseFigureDb} dB</label>
            <input
              type="range" min="0" max="15" step="0.5"
              className="accent-[#cc785c] cursor-ew-resize"
              value={coverageNoiseFigureDb}
              onChange={(e) => setCoverageNoiseFigureDb(parseFloat(e.target.value))}
            />
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3.5 bg-[#f5f3ec] border border-[#e3e0d6] rounded p-2.5">
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-slate-600 font-bold">Monte Carlo rays / Tx</label>
          <select
            id="select-radiomap-samples"
            className="text-[14px] py-1.5 px-2 bg-white border border-[#e3e0d6] rounded text-slate-900 focus:outline-none focus:border-[#cc785c] cursor-pointer"
            value={samplesPerTx}
            onChange={(event) => setSamplesPerTx(parseInt(event.target.value, 10))}
          >
            <option value={100_000}>100k · preview</option>
            <option value={500_000}>500k</option>
            <option value={1_000_000}>1M · default</option>
            <option value={2_000_000}>2M · high quality</option>
            <option value={5_000_000}>5M · high quality</option>
            <option value={10_000_000}>10M · publication</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-slate-600 font-bold">Deterministic seed</label>
          <NumberField
            id="input-radiomap-seed"
            integer
            min={0}
            max={2_147_483_647}
            step={1}
            value={radioMapSeed}
            onChange={setRadioMapSeed}
            className="text-[14px] py-1.5 px-2 bg-white border border-[#e3e0d6] rounded text-slate-900 focus:outline-none focus:border-[#cc785c]"
          />
        </div>
        <p className="col-span-2 text-[11px] text-slate-500 leading-snug">
          Increase rays to reduce estimator variance. Reuse the seed for exact comparisons; change it to test convergence.
        </p>
      </div>

      <button
        id="btn-compute-radio-map"
        onClick={() => onRunHeatmap(coverageRes, coverageHeight, samplesPerTx, radioMapSeed)}
        disabled={heatmapLoading || !backendOnline}
        className="w-full btn-signal text-[14px] font-bold py-2.5 px-3 rounded uppercase tracking-widest flex items-center justify-center gap-1.5 transition shadow-sm cursor-pointer border-none"
      >
        <Activity className={`w-4 h-4 text-white ${heatmapLoading ? 'animate-spin' : ''}`} />
        {heatmapLoading ? 'Computing Propagation Matrix...' : backendOnline ? 'Map Coverage Matrix Grid' : 'Backend offline'}
      </button>
      {solveError && (
        <div className="text-[12px] text-red-400 bg-red-500/10 border border-red-500/30 rounded px-2.5 py-1.5 font-mono">
          {solveError}
        </div>
      )}

      {/* Overlay the ray-tracing links on top of the coverage map */}
      <button
        id="btn-toggle-rays-on-coverage"
        onClick={() => setShowRaysOnHeatmap(!showRaysOnHeatmap)}
        className="flex items-center justify-between gap-2 w-full bg-[#f5f3ec] border border-[#e3e0d6] rounded px-3 py-2 cursor-pointer hover:border-[#cc785c]/50 transition"
      >
        <span className="text-[12px] font-bold text-slate-700 flex items-center gap-1.5">
          <Navigation className="w-3.5 h-3.5 text-[#cc785c]" />
          Show Ray-Tracing Links
        </span>
        <span className={`relative w-9 h-4 rounded-full transition-colors ${showRaysOnHeatmap ? 'bg-[#cc785c]' : 'bg-slate-200'}`}>
          <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${showRaysOnHeatmap ? 'left-5' : 'left-0.5'}`} />
        </span>
      </button>
      {showRaysOnHeatmap && (
        <p className="text-[11px] text-slate-600 -mt-1 leading-relaxed">
          Overlays the multipath rays from the last <strong className="text-[#cc785c]">Solve Link</strong> / <strong className="text-[#cc785c]">Solve All Pairs</strong>. Run a solve first if no rays appear.
        </p>
      )}

      {/* Display controls — colormap + range, like sionna-rt-gui's map panel */}
      <div className="flex flex-col gap-2.5 bg-[#f5f3ec] border border-[#e3e0d6] rounded p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[12px] font-bold text-slate-700">Display</span>
          <label className="flex items-center gap-1.5 text-[12px] font-semibold text-slate-700 cursor-pointer select-none">
            <input
              type="checkbox"
              id="chk-rm-autorange"
              className="accent-[#cc785c] cursor-pointer"
              checked={rmAutoRange}
              onChange={(e) => setRmAutoRange(e.target.checked)}
            />
            Auto range
          </label>
        </div>

        <select
          id="select-rm-colormap"
          className="text-[14px] py-1.5 px-2 bg-[#ffffff] border border-[#e3e0d6] rounded text-slate-900 focus:outline-none focus:border-[#cc785c] cursor-pointer"
          value={rmColormap}
          onChange={(e) => setRmColormap(e.target.value as ColormapName)}
        >
          {COLORMAP_NAMES.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>

        {!rmAutoRange && (
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-[12px] text-slate-600 font-bold">vmin: {rmVmin} dBm</span>
              <input
                type="range"
                id="slider-rm-vmin"
                min="-200"
                max="0"
                step="1"
                className="accent-[#cc785c] cursor-ew-resize"
                value={rmVmin}
                onChange={(e) => setRmVmin(Math.min(parseInt(e.target.value, 10), rmVmax))}
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[12px] text-slate-600 font-bold">vmax: {rmVmax} dBm</span>
              <input
                type="range"
                id="slider-rm-vmax"
                min="-200"
                max="0"
                step="1"
                className="accent-[#cc785c] cursor-ew-resize"
                value={rmVmax}
                onChange={(e) => setRmVmax(Math.max(parseInt(e.target.value, 10), rmVmin))}
              />
            </div>
          </div>
        )}

        {/* Colorbar legend, scaled to the effective range (metric-aware) */}
        {radioMap && (() => {
          const unit = radioMap.unit ?? 'dBm';
          const isSinr = (radioMap.metric ?? 'power') === 'sinr';
          const useManual = !rmAutoRange && !isSinr;
          let vmin = rmVmin;
          let vmax = rmVmax;
          if (!useManual) {
            if (radioMap.stats) {
              vmin = radioMap.stats.minVal;
              vmax = radioMap.stats.maxVal;
            } else {
              const powers = radioMap.cells.map((c) => c.powerDbm).filter((p) => Number.isFinite(p) && p > -300);
              vmin = powers.length ? Math.min(...powers) : -120;
              vmax = powers.length ? Math.max(...powers) : -50;
            }
          }
          const vmid = (vmin + vmax) / 2;
          const label = isSinr ? 'SINR' : 'Received Power';
          return (
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] font-bold text-slate-600 uppercase tracking-widest">{label} · {rmColormap}</span>
              <div className="w-full h-3 rounded" style={{ backgroundImage: colormapCssGradient(rmColormap) }} />
              <div className="flex justify-between font-mono text-[11px] text-slate-600">
                <span>{vmin.toFixed(0)} {unit}</span>
                <span>{vmid.toFixed(0)} {unit}</span>
                <span>{vmax.toFixed(0)} {unit}</span>
              </div>
            </div>
          );
        })()}
      </div>

      {/* Coverage statistics (served %, percentiles) from the Sionna radio map */}
      {coverageStats && (
        <div className="flex flex-col gap-2 bg-[#f5f3ec] border border-[#e3e0d6] rounded p-3">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-bold text-slate-700">Coverage KPIs</span>
            <span className="text-[11px] px-2 py-0.5 rounded font-bold border bg-white border-[#e3e0d6] text-slate-600">
              {coverageStats.metric === 'sinr' ? 'SINR' : 'Power'}
            </span>
          </div>
          <span className="text-[11px] text-slate-500 font-mono">
            {(radioMap?.samplesPerTx ?? samplesPerTx).toLocaleString()} rays/Tx · seed {radioMap?.seed ?? radioMapSeed}
          </span>
          <div className="flex items-center justify-between">
            <span className="text-[12px] text-slate-600 font-semibold">
              Served (≥ {coverageStats.thresholdDb.toFixed(0)} {coverageStats.unit})
            </span>
            <span className="font-mono text-[14px] font-bold text-[#5f7f5a]">{coverageStats.servedPercent.toFixed(1)}%</span>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            {([['Cell-edge (p5)', coverageStats.p5], ['Median (p50)', coverageStats.p50], ['Peak (p95)', coverageStats.p95]] as const).map(([lab, val]) => (
              <div key={lab} className="flex flex-col gap-0.5 bg-white border border-[#e3e0d6] rounded py-1.5">
                <span className="text-[11px] text-slate-500 font-bold">{lab}</span>
                <span className="font-mono text-[13px] font-bold text-slate-800">{val.toFixed(1)}</span>
                <span className="text-[11px] text-slate-400">{coverageStats.unit}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
