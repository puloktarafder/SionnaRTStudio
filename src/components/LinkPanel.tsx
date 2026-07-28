/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Transmitter, Receiver, PropagationPath, ChannelMetrics, MatrixCell } from '../types';
import { DeviceRow } from './DeviceRow';
import { Waves, Activity, Zap } from 'lucide-react';

interface LinkPanelProps {
  txs: Transmitter[];
  rxs: Receiver[];
  activeTxId: string;
  activeRxId: string;
  onSelectTx: (id: string) => void;
  onSelectRx: (id: string) => void;
  onAddTx: () => void;
  onAddRx: () => void;
  onRemoveTx: (id: string) => void;
  onRemoveRx: (id: string) => void;
  matrix: Record<string, MatrixCell>;
  matrixLoading: boolean;
  matrixProgress: string;
  onSolveMatrix: () => void;
  onSelectPair: (txId: string, rxId: string) => void;
  paths: PropagationPath[];
  metrics: ChannelMetrics;
  onSolve: () => void;
  solving: boolean;
  solveError: string;
  backendOnline: boolean;
}

// Channel Impulse Response Taps Chart
function CIRChart({ paths }: { paths: PropagationPath[] }) {
  if (paths.length === 0) {
    return (
      <div className="h-[140px] flex items-center justify-center bg-slate-50 border border-slate-100 rounded-lg text-slate-600 text-[14px]">
        No multipaths resolved. Fetch an OSM area.
      </div>
    );
  }

  const minDelay = 0;
  const maxDelay = Math.max(...paths.map((p) => p.delayNs)) * 1.15 || 500;
  const minPower = -120;
  const maxPower = -30;

  const mapX = (ns: number) => 40 + ((ns - minDelay) / (maxDelay - minDelay)) * 340;
  const mapY = (dbm: number) => 10 + (1 - (dbm - minPower) / (maxPower - minPower)) * 90;

  return (
    <div className="bg-[#f5f3ec] border border-[#e3e0d6] rounded p-3 flex flex-col gap-2">
      <h4 className="panel-title flex items-center gap-1.5">
        <Activity className="w-3.5 h-3.5 text-[#cc785c]" />
        Multipath Channel Impulse Response (CIR Taps)
      </h4>

      <svg className="w-full h-[140px]" viewBox="-28 -4 436 136">
        {/* Grid lines */}
        <line x1="40" y1="100" x2="380" y2="100" stroke="#cbc6b6" strokeWidth="1" />
        <line x1="40" y1="10" x2="40" y2="100" stroke="#cbc6b6" strokeWidth="1" />

        {/* Label coordinates */}
        <text x="35" y="10" textAnchor="end" fontSize="12" fontWeight="700" fill="#141413" fontFamily="monospace">
          -30 dBm
        </text>
        <text x="35" y="55" textAnchor="end" fontSize="12" fontWeight="700" fill="#141413" fontFamily="monospace">
          -75 dBm
        </text>
        <text x="35" y="100" textAnchor="end" fontSize="12" fontWeight="700" fill="#141413" fontFamily="monospace">
          -120 dBm
        </text>

        <text x="40" y="112" fontSize="12" fontWeight="700" fill="#141413" fontFamily="monospace">
          0ns
        </text>
        <text x="210" y="112" textAnchor="middle" fontSize="12" fontWeight="700" fill="#141413" fontFamily="monospace">
          {(maxDelay / 2).toFixed(0)}ns
        </text>
        <text x="380" y="112" textAnchor="end" fontSize="12" fontWeight="700" fill="#141413" fontFamily="monospace">
          {maxDelay.toFixed(0)}ns (Delay)
        </text>

        {/* Wave vertical taps */}
        {paths.map((path) => {
          const txVal = mapX(path.delayNs);
          const tyVal = mapY(Math.min(-30, Math.max(-120, path.receivedPowerDbm)));
          const isLOS = path.type === 'LOS';

          return (
            <g key={path.id}>
              {/* Discrete trace bar */}
              <line
                x1={txVal}
                y1="100"
                x2={txVal}
                y2={tyVal}
                stroke={isLOS ? '#5f7f5a' : '#cc785c'}
                strokeWidth={isLOS ? '3' : '1.5'}
                strokeDasharray={isLOS ? '0' : '1'}
              />
              {/* Tap point */}
              <circle
                cx={txVal}
                cy={tyVal}
                r={isLOS ? '4' : '2.5'}
                fill={isLOS ? '#5f7f5a' : '#cc785c'}
                className="hover:scale-150 transition-all duration-150 cursor-pointer"
              >
                <title>{`${path.type}: ${path.receivedPowerDbm.toFixed(1)} dBm @ ${path.delayNs.toFixed(1)}ns`}</title>
              </circle>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// LINK ANALYSIS VIEWPORT — device manager, Sionna solve, KPIs, all-pairs matrix.
export function LinkPanel({
  txs,
  rxs,
  activeTxId,
  activeRxId,
  onSelectTx,
  onSelectRx,
  onAddTx,
  onAddRx,
  onRemoveTx,
  onRemoveRx,
  matrix,
  matrixLoading,
  matrixProgress,
  onSolveMatrix,
  onSelectPair,
  paths,
  metrics,
  onSolve,
  solving,
  solveError,
  backendOnline,
}: LinkPanelProps) {
  return (
    <div className="panel p-4 flex flex-col gap-4">
      <div className="flex items-center gap-1.5 justify-between">
        <div className="flex items-center gap-1.5">
          <Zap className="w-4 h-4 text-[#cc785c] animate-pulse" />
          <h3 className="panel-title">Propagation Physics KPIs</h3>
        </div>
        <span
          className={`text-[11px] px-2.5 py-0.5 rounded font-bold border  ${
            metrics.losStatus === 'LOS'
              ? 'bg-[#5f7f5a]/10 border-[#5f7f5a]/30 text-[#5f7f5a]'
              : 'bg-[#cc785c]/10 border-[#cc785c]/30 text-[#cc785c]'
          }`}
        >
          Link: {metrics.losStatus}
        </span>
      </div>

      {/* DEVICE MANAGER — multiple Tx & Rx. Click a chip to make it active
          (sliders / map / 3D edit it); × removes it; + adds one. */}
      <div className="flex flex-col gap-2 bg-[#f5f3ec] border border-[#e3e0d6] rounded p-2.5">
        <DeviceRow label="TX" list={txs} activeId={activeTxId} onSelect={onSelectTx} onRemove={onRemoveTx} onAdd={onAddTx} dotClass="bg-[#cc785c]" />
        <DeviceRow label="RX" list={rxs} activeId={activeRxId} onSelect={onSelectRx} onRemove={onRemoveRx} onAdd={onAddRx} dotClass="bg-[#4a727e]" />
      </div>

      {/* Run real Sionna RT solve on demand */}
      <button
        id="btn-solve-link"
        onClick={onSolve}
        disabled={solving || !backendOnline}
        className="w-full btn-signal text-[14px] font-bold py-2.5 px-3 rounded uppercase tracking-widest flex items-center justify-center gap-2 transition shadow-sm cursor-pointer border-none"
      >
        <Zap className={`w-4 h-4 ${solving ? 'animate-pulse' : ''}`} />
        {solving ? 'Tracing rays (Sionna RT)…' : backendOnline ? 'Solve Link · Sionna RT' : 'Backend offline'}
      </button>
      {solveError && (
        <div className="text-[12px] text-red-400 bg-red-500/10 border border-red-500/30 rounded px-2.5 py-1.5 font-mono">
          {solveError}
        </div>
      )}
      {paths.length === 0 && !solving && !solveError && (
        <div className="text-[12px] text-slate-600 text-center -mt-1">
          Place Tx/Rx and press <strong className="text-[#cc785c]">Solve Link</strong> to run GPU ray tracing.
        </div>
      )}

      {/* Core Numerical results meters */}
      <div className="grid grid-cols-3 gap-2.5">
        <div className="flex flex-col gap-0.5 bg-[#f5f3ec] p-3 rounded border border-[#e3e0d6]">
          <span className="text-[11px] text-[#6b6862] font-bold">RX Power</span>
          <span className="text-[15px] font-bold text-[#141413] font-mono">
            {metrics.totalRxPowerDbm.toFixed(1)} <span className="text-[11px] font-normal text-slate-600">dBm</span>
          </span>
          <span className="text-[11px] text-[#5f7f5a] font-bold font-mono">
            {(Math.pow(10, metrics.totalRxPowerDbm / 10) * 1e6).toFixed(4)} μW
          </span>
        </div>

        <div className="flex flex-col gap-0.5 bg-[#f5f3ec] p-3 rounded border border-[#e3e0d6]">
          <span className="text-[11px] text-[#6b6862] font-bold">Delay Spread</span>
          <span className="text-[15px] font-bold text-[#141413] font-mono">
            {metrics.rmsDelaySpreadValid === false
              ? 'N/A'
              : <>{metrics.rmsDelaySpreadNs.toFixed(1)} <span className="text-[11px] font-normal text-slate-600">ns</span></>}
          </span>
          <span className="text-[11px] text-slate-600 font-semibold uppercase">Multipath</span>
        </div>

        <div className="flex flex-col gap-0.5 bg-[#f5f3ec] p-3 rounded border border-[#e3e0d6]">
          <span className="text-[11px] text-[#6b6862] font-bold">Active Rays</span>
          <span className="text-[15px] font-bold text-[#141413] font-mono">
            {metrics.numPaths} <span className="text-[11px] font-normal text-slate-600">resolved</span>
          </span>
          <span className="text-[11px] text-slate-600 font-semibold uppercase">Bounces</span>
        </div>
      </div>

      {/* ALL-PAIRS LINK MATRIX — RX power for every Tx→Rx pair.
          Click a cell to focus that pair (shows its multipath in 3D). */}
      {(txs.length > 1 || rxs.length > 1) && (
        <div className="flex flex-col gap-2 bg-[#f5f3ec] border border-[#e3e0d6] rounded p-3">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-bold text-slate-700">Tx × Rx Link Matrix</span>
            <span className="text-[11px] text-slate-600 font-mono">{txs.length}×{rxs.length} = {txs.length * rxs.length} links</span>
          </div>
          <button
            id="btn-solve-matrix"
            onClick={onSolveMatrix}
            disabled={matrixLoading || !backendOnline}
            className="w-full bg-[#ebe7dc] hover:bg-[#e3e0d6] disabled:opacity-50 text-slate-900 text-[13px] font-bold py-2 px-3 rounded uppercase tracking-widest flex items-center justify-center gap-2 transition cursor-pointer border border-[#e3e0d6]"
          >
            <Activity className={`w-3.5 h-3.5 ${matrixLoading ? 'animate-spin' : ''}`} />
            {matrixLoading ? (matrixProgress || 'Solving matrix…') : 'Solve All Pairs · Sionna RT'}
          </button>

          {Object.keys(matrix).length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px] font-mono border-collapse">
                <thead>
                  <tr className="text-slate-600">
                    <th className="p-1 text-left font-bold sticky left-0 bg-[#f5f3ec]">RX&nbsp;Pwr&nbsp;dBm</th>
                    {rxs.map((r) => (
                      <th key={r.id} className="p-1 font-bold text-[#4a727e] whitespace-nowrap">{r.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {txs.map((t) => (
                    <tr key={t.id}>
                      <td className="p-1 font-bold text-[#cc785c] whitespace-nowrap sticky left-0 bg-[#f5f3ec]">{t.name}</td>
                      {rxs.map((r) => {
                        const cell = matrix[`${t.id}|${r.id}`];
                        const isActive = t.id === activeTxId && r.id === activeRxId;
                        const p = cell?.metrics.totalRxPowerDbm;
                        const los = cell?.metrics.losStatus === 'LOS';
                        return (
                          <td
                            key={r.id}
                            onClick={() => cell && onSelectPair(t.id, r.id)}
                            title={cell ? `${t.name}→${r.name}: ${los ? 'LOS' : 'NLOS'}, ${cell.metrics.numPaths} paths` : ''}
                            className={`p-1 text-center cursor-pointer border transition ${
                              isActive ? 'border-[#cc785c] bg-[#cc785c]/10' : 'border-[#ebe7dc] hover:bg-[#ebe7dc]'
                            } ${los ? 'text-emerald-400' : 'text-slate-700'}`}
                          >
                            {cell ? (p! <= -200 ? '—' : p!.toFixed(1)) : '·'}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-[11px] text-slate-600 mt-1.5">Green = LOS · click a cell to focus that pair in 3D.</p>
            </div>
          )}
        </div>
      )}

      {/* Discrete Tap Scatter representation */}
      <CIRChart paths={paths} />

      {/* Ray paths resolved table breakdown */}
      <div className="flex flex-col gap-1.5 mt-1">
        <h4 className="eyebrow flex items-center gap-1.5">
          <Waves className="w-3.5 h-3.5 text-[#cc785c]" />
          Resolved Ray Propagation Paths
        </h4>

        <div className="max-h-[145px] overflow-y-auto border border-[#e3e0d6] rounded text-[13px] text-[#141413] bg-[#f5f3ec]">
          <table className="w-full text-left font-mono">
            <thead className="bg-[#ffffff] border-b border-[#e3e0d6] text-slate-600 text-[11px] uppercase font-bold sticky top-0">
              <tr>
                <th className="py-2 px-3">Path Type</th>
                <th className="py-2 px-2">Dist</th>
                <th className="py-2 px-2">Delay</th>
                <th className="py-2 px-3 text-right">Rx Power</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#e3e0d6]">
              {paths.map((p, idx) => (
                <tr key={p.id} className="hover:bg-[#ebe7dc]/50 duration-105 font-semibold">
                  <td className="py-1.5 px-3 flex items-center gap-1.5">
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${p.type === 'LOS' ? 'bg-[#5f7f5a]' : 'bg-[#cc785c]'}`}
                    />
                    <span className="font-sans font-bold text-slate-800">
                      {p.type === 'LOS' ? 'LOS Link' : `Reflection (W_${idx})`}
                    </span>
                  </td>
                  <td className="py-1.5 px-2 text-slate-600">{p.distance.toFixed(0)}m</td>
                  <td className="py-1.5 px-2 text-slate-600">{p.delayNs.toFixed(0)}ns</td>
                  <td
                    className={`py-1.5 px-3 text-right ${
                      p.receivedPowerDbm > -65 ? 'text-[#5f7f5a]' : p.receivedPowerDbm > -90 ? 'text-[#4a727e]' : 'text-slate-600'
                    }`}
                  >
                    {p.receivedPowerDbm.toFixed(1)} dBm
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
