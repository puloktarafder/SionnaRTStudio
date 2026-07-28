/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

interface DeviceRowProps {
  label: string;
  list: { id: string; name: string }[];
  activeId: string;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
  dotClass: string;
}

// One row of device chips (click = make active, × = remove, + Add = new).
// Shared by the Link device manager and the Trajectory transmitter list.
export function DeviceRow({ label, list, activeId, onSelect, onRemove, onAdd, dotClass }: DeviceRowProps) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-[11px] font-bold text-slate-600 w-5">{label}</span>
      {list.map((d) => {
        const active = d.id === activeId;
        return (
          <span
            key={d.id}
            onClick={() => onSelect(d.id)}
            className={`group flex items-center gap-1 text-[12px] font-bold rounded px-2 py-1 cursor-pointer border transition ${
              active
                ? 'bg-[#ebe7dc] border-[#cc785c] text-slate-900'
                : 'bg-[#ffffff] border-[#e3e0d6] text-slate-600 hover:text-slate-900'
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />
            {d.name}
            {list.length > 1 && (
              <button
                onClick={(e) => { e.stopPropagation(); onRemove(d.id); }}
                className="ml-0.5 text-slate-600 hover:text-red-400 bg-transparent border-0 cursor-pointer leading-none"
                title={`Remove ${d.name}`}
              >
                ×
              </button>
            )}
          </span>
        );
      })}
      <button
        onClick={onAdd}
        className="text-[12px] font-bold rounded px-2 py-1 cursor-pointer border border-dashed border-[#e3e0d6] text-slate-600 hover:text-[#cc785c] hover:border-[#cc785c] bg-transparent transition"
        title={`Add ${label}`}
      >
        + Add
      </button>
    </div>
  );
}
