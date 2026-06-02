'use client';

// ABOUTME: Small reusable field editors for the rich Profiles form — a chip/tag input (skills, tool lists)
// ABOUTME: and a key/value row editor (env, MCP headers/env). Controlled: parent owns the array; these just
// ABOUTME: render + emit the next array on change. Styling reuses the .chip* / .kv* classes in globals.css.

import { useState } from 'react';
import type { KvRow } from '@/lib/profile-form';

/** A tag input: existing values render as removable chips; typing + Enter/comma adds one. */
export function ChipInput({
  label,
  values,
  onChange,
  placeholder,
}: {
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState('');

  function commit() {
    const v = draft.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft('');
  }

  return (
    <div className="field">
      <label>{label}</label>
      <div className="chip-input">
        {values.map((v) => (
          <span key={v} className="chip">
            {v}
            <button type="button" className="chip-x" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}>
              ×
            </button>
          </span>
        ))}
        <input
          className="chip-entry"
          value={draft}
          placeholder={values.length ? '' : placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Backspace' && !draft && values.length) {
              onChange(values.slice(0, -1));
            }
          }}
          onBlur={commit}
        />
      </div>
    </div>
  );
}

/** A segmented single-select (a radiogroup of buttons) for a small mutually-exclusive choice — runtime,
 *  schedule trigger, etc. Controlled: parent owns `value`. Styling reuses the .seg / .seg-btn classes. */
export function SegToggle<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (next: T) => void;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <div className="seg" role="radiogroup" aria-label={label}>
        {options.map((opt) => (
          <button
            key={opt}
            type="button"
            role="radio"
            aria-checked={value === opt}
            className={`seg-btn${value === opt ? ' on done' : ''}`}
            onClick={() => onChange(opt)}
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Key/value rows (env vars, MCP headers). Empty trailing row is implicit — an "add" button appends one. */
export function KeyValueRows({
  label,
  rows,
  onChange,
  keyPlaceholder = 'KEY',
  valuePlaceholder = 'value or ${ENV}',
}: {
  label: string;
  rows: KvRow[];
  onChange: (next: KvRow[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}) {
  const set = (i: number, patch: Partial<KvRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="field">
      <label>{label}</label>
      <div className="kv-rows">
        {rows.map((row, i) => (
          // rows are positional + freely edited, so the array index is the stable identity here
          <div className="kv-row" key={i}>
            <input className="kv-key" value={row.key} placeholder={keyPlaceholder} onChange={(e) => set(i, { key: e.target.value })} />
            <input className="kv-val" value={row.value} placeholder={valuePlaceholder} onChange={(e) => set(i, { value: e.target.value })} />
            <button type="button" className="btn btn-sm btn-ghost" aria-label="Remove row" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
              −
            </button>
          </div>
        ))}
        <button type="button" className="btn btn-sm" onClick={() => onChange([...rows, { key: '', value: '' }])}>
          + Add
        </button>
      </div>
    </div>
  );
}
