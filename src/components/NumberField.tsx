import { useEffect, useRef, useState } from 'react';

interface NumberFieldProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number | string;
  /** Round committed values to whole numbers. */
  integer?: boolean;
  id?: string;
  className?: string;
  placeholder?: string;
  title?: string;
  disabled?: boolean;
}

const clamp = (n: number, min?: number, max?: number) => {
  let out = n;
  if (min !== undefined) out = Math.max(min, out);
  if (max !== undefined) out = Math.min(max, out);
  return out;
};

/**
 * Controlled numeric input that keeps the raw keystrokes in local state.
 *
 * A plain `value={someNumber}` input cannot represent a half-typed entry: the
 * moment the box is emptied the parse yields NaN and the handler has to
 * substitute a fallback, which re-fills the box and makes it impossible to
 * clear the field or retype a value from scratch. Holding the draft string
 * here lets the box go empty (and hold "-" or "1." mid-entry) while the parent
 * keeps the last valid number. Blur normalises the draft and commits the
 * clamped result.
 */
export function NumberField({
  value,
  onChange,
  min,
  max,
  step,
  integer = false,
  id,
  className,
  placeholder,
  title,
  disabled,
}: NumberFieldProps) {
  const [draft, setDraft] = useState(() => String(value));
  const focused = useRef(false);

  // Track external updates (project import, presets, reset) unless the user is
  // mid-edit, where overwriting the draft would fight their typing.
  useEffect(() => {
    if (!focused.current) setDraft(String(value));
  }, [value]);

  const commit = (raw: string) => {
    const parsed = integer ? Number.parseInt(raw, 10) : Number.parseFloat(raw);
    if (!Number.isFinite(parsed)) return;
    const next = clamp(parsed, min, max);
    if (next !== value) onChange(next);
  };

  return (
    <input
      id={id}
      type="number"
      inputMode={integer ? 'numeric' : 'decimal'}
      min={min}
      max={max}
      step={step}
      title={title}
      placeholder={placeholder}
      disabled={disabled}
      className={className}
      value={draft}
      onFocus={() => { focused.current = true; }}
      onChange={(event) => {
        // A number input reports an empty value while its text is unparseable
        // ("-", "1e"), which is indistinguishable from a cleared box. Leaving
        // state alone keeps the DOM text so a negative can still be typed.
        if (event.target.validity.badInput) return;
        setDraft(event.target.value);
        commit(event.target.value);
      }}
      onBlur={() => {
        focused.current = false;
        const parsed = integer ? Number.parseInt(draft, 10) : Number.parseFloat(draft);
        if (!Number.isFinite(parsed)) {
          // Empty or unparseable: snap back to whatever the parent still holds.
          setDraft(String(value));
          return;
        }
        const next = clamp(parsed, min, max);
        setDraft(String(next));
        if (next !== value) onChange(next);
      }}
    />
  );
}
