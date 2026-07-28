/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

// Palette-matched app wordmark: the source logo's cool navy/teal band is
// remapped onto the theme's warm range. The original file is untouched.
const LOGO_URL = new URL('../../assets/logo-app-bone.png', import.meta.url).href;

export type NavTab = '3d_scene' | 'geography' | 'analysis' | 'export';

const TABS: ReadonlyArray<readonly [string, NavTab]> = [
  ['3D scene', '3d_scene'],
  ['Geography', 'geography'],
  ['Analysis', 'analysis'],
  ['Export', 'export'],
] as const;

interface TopNavProps {
  activeTab: NavTab;
  onSelect: (tab: NavTab) => void;
  backendOnline: boolean;
  version?: string;
}

/**
 * Application chrome: wordmark, section navigation, solver status.
 *
 * The navigation carries the one piece of motion in the interface. Instead of
 * four separate highlights, a single clay rule slides between sections the way
 * a phased array steers a beam — the subject of the app, expressed in its own
 * chrome. Measured from the live DOM so it tracks font loading and resizes.
 */
export function TopNav({ activeTab, onSelect, backendOnline, version = '1.0.0' }: TopNavProps) {
  const navRef = useRef<HTMLElement | null>(null);
  const tabRefs = useRef(new Map<NavTab, HTMLButtonElement>());
  const [beam, setBeam] = useState<{ left: number; width: number } | null>(null);

  const measure = useCallback(() => {
    const nav = navRef.current;
    const tab = tabRefs.current.get(activeTab);
    if (!nav || !tab) return;
    setBeam({ left: tab.offsetLeft, width: tab.offsetWidth });
  }, [activeTab]);

  useLayoutEffect(measure, [measure]);

  useEffect(() => {
    // The serif loads after first paint and shifts tab widths, so re-measure on
    // font readiness as well as on resize.
    const nav = navRef.current;
    if (!nav) return;
    const observer = new ResizeObserver(measure);
    observer.observe(nav);
    document.fonts?.ready.then(measure).catch(() => {});
    return () => observer.disconnect();
  }, [measure]);

  return (
    <header className="sticky top-0 z-50 bg-[var(--page)]/92 backdrop-blur-md border-b border-[var(--line)]">
      <div className="px-6 flex items-center justify-between gap-6">
        {/* Wordmark. The logo already carries the name, so no type lockup
            beside it — one wordmark per header. */}
        <div className="flex items-center gap-2.5 shrink-0 py-2">
          <img
            src={LOGO_URL}
            alt="SionnaRT Studio — wireless digital twin"
            className="h-14 w-auto select-none"
            draggable={false}
          />
          <span className="hidden sm:inline readout text-[12px] text-[var(--text-lo)]">
            v{version}
          </span>
        </div>

        {/* Section navigation — the beam sweep */}
        <nav ref={navRef} className="beam-nav hidden md:flex items-stretch" aria-label="Workspace sections">
          {TABS.map(([label, target]) => (
            <button
              key={target}
              id={`nav-btn-${target}`}
              type="button"
              className="beam-nav__tab"
              aria-current={activeTab === target ? 'page' : undefined}
              onClick={() => onSelect(target)}
              ref={(node) => {
                if (node) tabRefs.current.set(target, node);
                else tabRefs.current.delete(target);
              }}
            >
              {label}
            </button>
          ))}
          {beam && (
            <span
              aria-hidden
              className="beam-nav__beam"
              style={{ width: beam.width, transform: `translateX(${beam.left}px)` }}
            />
          )}
        </nav>

        {/* Solver status. Named for what the person is waiting on, not the process. */}
        <div className="flex items-center gap-2 shrink-0 py-3 select-none">
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{ background: backendOnline ? 'var(--ok)' : 'var(--bad)' }}
          />
          <span className="readout text-[13px] text-[var(--text-mid)]">
            <span className="hidden lg:inline text-[var(--text-lo)]">Sionna RT </span>
            {backendOnline ? 'ready' : 'offline'}
          </span>
        </div>
      </div>

      {/* Compact section switcher for narrow viewports. */}
      <nav
        className="md:hidden flex overflow-x-auto border-t border-[var(--line)] px-4"
        aria-label="Workspace sections"
      >
        {TABS.map(([label, target]) => (
          <button
            key={target}
            type="button"
            onClick={() => onSelect(target)}
            aria-current={activeTab === target ? 'page' : undefined}
            className={`px-3 py-2.5 text-[14px] whitespace-nowrap border-b-2 transition-colors ${
              activeTab === target
                ? 'border-[var(--accent)] text-[var(--text-hi)] font-medium'
                : 'border-transparent text-[var(--text-mid)]'
            }`}
          >
            {label}
          </button>
        ))}
      </nav>
    </header>
  );
}
