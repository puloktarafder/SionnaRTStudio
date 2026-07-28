/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { Transmitter, Receiver, SolverOptions } from '../types';
import { Settings } from 'lucide-react';
import { NumberField } from './NumberField';

interface SolverControlsProps {
  tx: Transmitter;
  rx: Receiver;
  onTxUpdate: (tx: Transmitter) => void;
  onRxUpdate: (rx: Receiver) => void;
  activeMode: 'link' | 'heatmap' | 'playback';
  setActiveMode: (mode: 'link' | 'heatmap' | 'playback') => void;
  freqGhz: number;
  setFreqGhz: (val: number) => void;
  maxDepth: number;
  setMaxDepth: (val: number) => void;
  solverOptions: SolverOptions;
  setSolverOptions: (opts: SolverOptions) => void;
}

// Studio mode tabs + the shared RF transceiver parameters (carrier, ray
// interactions, antenna array, beam steering, heights). The mode-specific
// viewports live in LinkPanel / CoveragePanel / TrajectoryPanel.
export function SolverControls({
  tx,
  rx,
  onTxUpdate,
  onRxUpdate,
  activeMode,
  setActiveMode,
  freqGhz,
  setFreqGhz,
  maxDepth,
  setMaxDepth,
  solverOptions,
  setSolverOptions,
}: SolverControlsProps) {
  // Local RF simulation configs
  const [txPower, setTxPower] = useState(tx.powerDbm);
  const [txAntH, setTxAntH] = useState(tx.antennaArraySize[0]);
  const [txAntV, setTxAntV] = useState(tx.antennaArraySize[1]);
  const [rxAntH, setRxAntH] = useState(rx.antennaArraySize[0]);
  const [rxAntV, setRxAntV] = useState(rx.antennaArraySize[1]);
  const [beamsteeringAz, setBeamsteeringAz] = useState(tx.beamsteeringAzimuth);
  const [beamsteeringEl, setBeamsteeringEl] = useState(tx.beamsteeringElevation);
  const [txHeight, setTxHeight] = useState(tx.height);
  const [rxHeight, setRxHeight] = useState(rx.height);

  // Custom carrier-frequency field keeps its own text so the user can clear it
  // or type intermediate values ("2", "2.") without the controlled number value
  // snapping back. The box stays empty (placeholder) while a preset is active,
  // so it reads as "type a custom value" rather than a fourth fixed preset.
  const FREQ_PRESETS = [2.4, 5.8, 28.0];
  const [freqInput, setFreqInput] = useState(FREQ_PRESETS.includes(freqGhz) ? '' : String(freqGhz));
  const freqFocused = useRef(false);
  useEffect(() => {
    // Reconcile when freqGhz changes elsewhere (e.g. preset buttons), but don't
    // disturb an active edit. A preset value clears the box back to placeholder.
    if (freqFocused.current) return;
    if (FREQ_PRESETS.includes(freqGhz)) setFreqInput('');
    else if (parseFloat(freqInput) !== freqGhz) setFreqInput(String(freqGhz));
  }, [freqGhz]);

  useEffect(() => {
    setTxPower(tx.powerDbm);
    setTxAntH(tx.antennaArraySize[0]);
    setTxAntV(tx.antennaArraySize[1]);
    setBeamsteeringAz(tx.beamsteeringAzimuth);
    setBeamsteeringEl(tx.beamsteeringElevation);
    setTxHeight(tx.height);
  }, [tx.id]);

  useEffect(() => {
    setRxHeight(rx.height);
    setRxAntH(rx.antennaArraySize[0]);
    setRxAntV(rx.antennaArraySize[1]);
  }, [rx.id]);

  // Track state transfers to parent safely
  useEffect(() => {
    onTxUpdate({
      ...tx,
      powerDbm: txPower,
      antennaArraySize: [txAntH, txAntV],
      beamsteeringAzimuth: beamsteeringAz,
      beamsteeringElevation: beamsteeringEl,
      height: txHeight,
    });
  }, [txPower, txAntH, txAntV, beamsteeringAz, beamsteeringEl, txHeight]);

  useEffect(() => {
    onRxUpdate({
      ...rx,
      height: rxHeight,
      antennaArraySize: [rxAntH, rxAntV],
    });
  }, [rxHeight, rxAntH, rxAntV]);

  return (
    <div className="flex flex-col gap-4">
      {/* Studio Modes Selector Tab */}
      <div className="grid grid-cols-3 gap-1 bg-[var(--ink-850)] p-1 rounded-xl border border-[var(--line)]">
        {(['link', 'heatmap', 'playback'] as const).map((mode) => (
          <button
            key={mode}
            id={`tab-mode-${mode}`}
            onClick={() => setActiveMode(mode)}
            className={`py-2 text-[13px] font-medium leading-tight rounded-lg transition-all cursor-pointer ${
              activeMode === mode
                ? 'bg-white text-[var(--accent-deep)] shadow-[0_1px_2px_rgba(16,24,40,0.08)] ring-1 ring-[var(--line)]'
                : 'text-[var(--text-lo)] hover:text-[var(--text-hi)] hover:bg-black/[0.03]'
            }`}
          >
            {mode === 'link' && 'Link Analysis'}
            {mode === 'heatmap' && 'Radio Coverage'}
            {mode === 'playback' && 'Trajectory'}
          </button>
        ))}
      </div>

      {/* CORE RF PARAMETERS MODULATOR */}
      <div className="panel p-4 flex flex-col gap-4">
        <div className="flex items-center gap-1.5">
          <Settings className="w-4 h-4 text-[#cc785c]" />
          <h3 className="panel-title">RF Transceiver Modulator</h3>
        </div>

        {/* Carrier frequency: presets + custom input box */}
        <div className="flex flex-col gap-1.5">
          <label className="text-[12px] font-bold text-[#6b6862]">Carrier Frequency Channel</label>
          <div className="grid grid-cols-4 gap-1.5">
            {FREQ_PRESETS.map((fq) => (
              <button
                key={fq}
                id={`btn-rf-${fq}`}
                onClick={() => { setFreqGhz(fq); setFreqInput(''); }}
                className={`py-1.5 px-0.5 rounded border text-[14px] font-bold transition-all cursor-pointer ${
                  freqGhz === fq
                    ? 'bg-[#cc785c] text-white border-none shadow-md shadow-[#cc785c]/20'
                    : 'bg-[#f5f3ec] text-[#6b6862] border-[#e3e0d6] hover:bg-[#ebe7dc] hover:text-slate-900'
                }`}
              >
                {fq === 28 ? '28 GHz mmW' : `${fq} GHz`}
              </button>
            ))}
            {/* Custom frequency input (GHz) — empty placeholder until typed */}
            <div className={`flex items-center rounded border overflow-hidden ${
              !FREQ_PRESETS.includes(freqGhz)
                ? 'border-[#cc785c] bg-[#ebe7dc]'
                : 'border-dashed border-[#d6d2c4] bg-white'
            }`}>
              <input
                type="number"
                id="input-rf-custom"
                min="0.1"
                max="300"
                step="0.1"
                placeholder="0.0"
                title="Custom carrier frequency in GHz"
                className="w-full text-[14px] py-1.5 px-1.5 bg-transparent text-center focus:outline-none text-slate-900 font-bold placeholder:font-normal placeholder:text-slate-400 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                value={freqInput}
                onFocus={() => { freqFocused.current = true; }}
                onChange={(e) => {
                  setFreqInput(e.target.value);
                  const v = parseFloat(e.target.value);
                  if (!Number.isNaN(v) && v > 0) setFreqGhz(v);
                }}
                onBlur={() => {
                  freqFocused.current = false;
                  // Leave the box empty (placeholder) if cleared while a preset is
                  // active; otherwise restore the active custom number.
                  const v = parseFloat(freqInput);
                  if (Number.isNaN(v) || v <= 0) {
                    setFreqInput(FREQ_PRESETS.includes(freqGhz) ? '' : String(freqGhz));
                  }
                }}
              />
              <span className="text-[11px] text-slate-600 font-bold pr-1.5">GHz</span>
            </div>
          </div>
        </div>

        {/* Sionna RT max interaction depth (reflections / diffractions per ray) */}
        <div className="flex flex-col gap-1">
          <label className="text-[12px] text-slate-600 font-bold">
            Max Depth (Ray Bounces): {maxDepth}
          </label>
          <input
            type="range"
            id="slider-max-depth"
            min="0"
            max="8"
            step="1"
            className="accent-[#cc785c] cursor-ew-resize"
            value={maxDepth}
            onChange={(e) => setMaxDepth(parseInt(e.target.value, 10))}
          />
          <span className="text-[12px] text-slate-700 font-mono font-medium">
            0 = LOS only · higher = more reflections (slower)
          </span>
        </div>

        {/* Ray interaction types (sionna-rt-gui feature checkboxes) — applied
            to link solves, mobility AND radio maps. */}
        <div className="flex flex-col gap-1.5">
          <label className="text-[12px] font-bold text-[#6b6862]">Ray Interactions</label>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            {([
              ['los', 'Line of sight'],
              ['specularReflection', 'Specular reflection'],
              ['diffuseReflection', 'Diffuse reflection'],
              ['refraction', 'Refraction'],
              ['diffraction', 'Diffraction'],
            ] as const).map(([key, label]) => (
              <label key={key} className="flex items-center gap-1.5 text-[12px] font-semibold text-slate-700 cursor-pointer select-none">
                <input
                  type="checkbox"
                  id={`chk-${key}`}
                  className="accent-[#cc785c] cursor-pointer"
                  checked={solverOptions[key]}
                  onChange={(e) => setSolverOptions({ ...solverOptions, [key]: e.target.checked })}
                />
                {label}
              </label>
            ))}
            {solverOptions.diffraction && (
              <label className="flex items-center gap-1.5 text-[12px] font-semibold text-slate-700 cursor-pointer select-none">
                <input
                  type="checkbox"
                  id="chk-edgeDiffraction"
                  className="accent-[#cc785c] cursor-pointer"
                  checked={solverOptions.edgeDiffraction}
                  onChange={(e) => setSolverOptions({ ...solverOptions, edgeDiffraction: e.target.checked })}
                />
                Edge diffraction
              </label>
            )}
          </div>
        </div>

        {/* PathSolver sampling controls. Specular candidates use shooting and
            bouncing, so sample count and seed belong in reproducible studies. */}
        <div className="grid grid-cols-2 gap-3 bg-[#f5f3ec] border border-[#e3e0d6] rounded p-2.5">
          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-slate-600 font-bold">Path samples / source</span>
            <select
              id="select-path-samples"
              className="text-[14px] py-1.5 px-2 bg-white border border-[#e3e0d6] rounded text-slate-900 focus:outline-none focus:border-[#cc785c] cursor-pointer"
              value={solverOptions.pathSamplesPerSource}
              onChange={(event) => setSolverOptions({
                ...solverOptions,
                pathSamplesPerSource: parseInt(event.target.value, 10),
              })}
            >
              <option value={10_000}>10k · quick check</option>
              <option value={100_000}>100k · preview</option>
              <option value={500_000}>500k</option>
              <option value={1_000_000}>1M · default</option>
              <option value={2_000_000}>2M</option>
              <option value={5_000_000}>5M · high quality</option>
              <option value={10_000_000}>10M · publication</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-slate-600 font-bold">Path seed</span>
            <NumberField
              id="input-path-seed"
              integer
              min={0}
              max={2_147_483_647}
              step={1}
              value={solverOptions.pathSeed}
              onChange={(pathSeed) => setSolverOptions({ ...solverOptions, pathSeed })}
              className="text-[14px] py-1.5 px-2 bg-white border border-[#e3e0d6] rounded text-slate-900 focus:outline-none focus:border-[#cc785c]"
            />
          </div>
          <p className="col-span-2 text-[11px] text-slate-500 leading-snug">
            Applies to Link, Trajectory, CIR/CFR, and ray-traced dataset solves. Pin both values when comparing results.
          </p>
        </div>

        {/* Scene-level Tx/Rx antenna patterns and polarizations, matching
            Sionna RT's scene.tx_array / scene.rx_array model. */}
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-[12px] text-slate-600 font-bold">TX Antenna Pattern</span>
            <select
              id="select-tx-pattern"
              className="text-[14px] py-1.5 px-2 bg-[#f5f3ec] border border-[#e3e0d6] rounded text-slate-900 focus:outline-none focus:border-[#cc785c] cursor-pointer"
              value={solverOptions.txPattern}
              onChange={(e) => setSolverOptions({ ...solverOptions, txPattern: e.target.value as SolverOptions['txPattern'] })}
            >
              <option value="iso">Isotropic</option>
              <option value="dipole">Dipole</option>
              <option value="hw_dipole">Half-wave dipole</option>
              <option value="tr38901">3GPP TR 38.901</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[12px] text-slate-600 font-bold">TX Polarization</span>
            <select
              id="select-tx-polarization"
              className="text-[14px] py-1.5 px-2 bg-[#f5f3ec] border border-[#e3e0d6] rounded text-slate-900 focus:outline-none focus:border-[#cc785c] cursor-pointer"
              value={solverOptions.txPolarization}
              onChange={(e) => setSolverOptions({ ...solverOptions, txPolarization: e.target.value as SolverOptions['txPolarization'] })}
            >
              <option value="V">Vertical (V)</option>
              <option value="H">Horizontal (H)</option>
              <option value="VH">Dual (VH)</option>
              <option value="cross">Cross (±45°)</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[12px] text-slate-600 font-bold">RX Antenna Pattern</span>
            <select
              id="select-rx-pattern"
              className="text-[14px] py-1.5 px-2 bg-[#f5f3ec] border border-[#e3e0d6] rounded text-slate-900 focus:outline-none focus:border-[#cc785c] cursor-pointer"
              value={solverOptions.rxPattern}
              onChange={(e) => setSolverOptions({ ...solverOptions, rxPattern: e.target.value as SolverOptions['rxPattern'] })}
            >
              <option value="iso">Isotropic</option>
              <option value="dipole">Dipole</option>
              <option value="hw_dipole">Half-wave dipole</option>
              <option value="tr38901">3GPP TR 38.901</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[12px] text-slate-600 font-bold">RX Polarization</span>
            <select
              id="select-rx-polarization"
              className="text-[14px] py-1.5 px-2 bg-[#f5f3ec] border border-[#e3e0d6] rounded text-slate-900 focus:outline-none focus:border-[#cc785c] cursor-pointer"
              value={solverOptions.rxPolarization}
              onChange={(e) => setSolverOptions({ ...solverOptions, rxPolarization: e.target.value as SolverOptions['rxPolarization'] })}
            >
              <option value="V">Vertical (V)</option>
              <option value="H">Horizontal (H)</option>
              <option value="VH">Dual (VH)</option>
              <option value="cross">Cross (±45°)</option>
            </select>
          </div>
          <p className="col-span-2 text-[11px] text-slate-500 leading-snug">
            RX settings configure the physical <code>scene.rx_array</code> for Link, Trajectory, CIR/CFR, and ray-traced datasets. Coverage uses Sionna RadioMapSolver&apos;s ideal dual-polarized isotropic receiver.
          </p>
        </div>

        {/* Sliders for Tx Power, Heights, Antenna Beam steering */}
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-[12px] text-slate-600 font-bold">TX Power: {txPower} dBm</span>
            <input
              type="range"
              id="slider-tx-power"
              min="10"
              max="45"
              step="1"
              className="accent-[#cc785c] cursor-ew-resize"
              value={txPower}
              onChange={(e) => setTxPower(parseInt(e.target.value, 10))}
            />
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-[12px] text-slate-600 font-bold">Carrier: {freqGhz} GHz</span>
            <span className="text-[11px] text-[#5f7f5a] font-mono">
              λ = {((0.3 / (freqGhz + 1e-9)) * 100).toFixed(2)} cm wavelength
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-[12px] text-slate-600 font-bold">TX Array: {txAntH} × {txAntV}</span>
            <div className="flex gap-1.5">
              <NumberField
                id="input-ant-h"
                integer
                min={1}
                max={64}
                value={txAntH}
                onChange={setTxAntH}
                className="w-1/2 text-[14px] py-1 px-2 border border-[#e3e0d6] bg-[#f5f3ec] rounded text-center focus:outline-none focus:border-[#cc785c] text-slate-900"
              />
              <span className="text-slate-600 self-center">×</span>
              <NumberField
                id="input-ant-v"
                integer
                min={1}
                max={64}
                value={txAntV}
                onChange={setTxAntV}
                className="w-1/2 text-[14px] py-1 px-2 border border-[#e3e0d6] bg-[#f5f3ec] rounded text-center focus:outline-none focus:border-[#cc785c] text-slate-900"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-[12px] text-slate-600 font-bold">RX Array: {rxAntH} × {rxAntV}</span>
            <div className="flex gap-1.5">
              <NumberField
                id="input-rx-ant-h"
                integer
                min={1}
                max={64}
                value={rxAntH}
                onChange={setRxAntH}
                className="w-1/2 text-[14px] py-1 px-2 border border-[#e3e0d6] bg-[#f5f3ec] rounded text-center focus:outline-none focus:border-[#cc785c] text-slate-900"
              />
              <span className="text-slate-600 self-center">×</span>
              <NumberField
                id="input-rx-ant-v"
                integer
                min={1}
                max={64}
                value={rxAntV}
                onChange={setRxAntV}
                className="w-1/2 text-[14px] py-1 px-2 border border-[#e3e0d6] bg-[#f5f3ec] rounded text-center focus:outline-none focus:border-[#cc785c] text-slate-900"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-[12px] text-slate-600 font-bold">Beam Azimuth: {beamsteeringAz}°</span>
            <input
              type="range"
              id="slider-beam-az"
              min="0"
              max="360"
              step="5"
              className="accent-[#cc785c] cursor-ew-resize"
              value={beamsteeringAz}
              onChange={(e) => setBeamsteeringAz(parseInt(e.target.value, 10))}
            />
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-[12px] text-slate-600 font-bold">TX Tower Height: {txHeight}m</span>
            <input
              type="range"
              id="slider-tx-height"
              min="1"
              max="40"
              step="0.5"
              className="accent-[#cc785c] cursor-ew-resize"
              value={txHeight}
              onChange={(e) => setTxHeight(parseFloat(e.target.value))}
            />
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-[12px] text-slate-600 font-bold">RX Device Height: {rxHeight}m</span>
            <input
              type="range"
              id="slider-rx-height"
              min="1"
              max="10"
              step="0.5"
              className="accent-[#cc785c] cursor-ew-resize"
              value={rxHeight}
              onChange={(e) => setRxHeight(parseFloat(e.target.value))}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
