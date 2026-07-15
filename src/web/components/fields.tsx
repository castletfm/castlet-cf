/**
 * Accessible controlled form fields. Every input is associated with a real
 * <label> and can surface a per-field error and hint.
 */

import { useId, type ReactNode } from "react";

interface BaseFieldProps {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
}

function FieldShell({
  id,
  label,
  hint,
  error,
  required,
  children,
}: BaseFieldProps & { id: string; children: (describedBy: string | undefined) => ReactNode }) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [hint !== undefined ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") ||
    undefined;
  return (
    <div className={`field${error ? " field-error" : ""}`}>
      <label htmlFor={id}>
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </label>
      {children(describedBy)}
      {hint !== undefined && (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="field-error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function TextField({
  value,
  onChange,
  type = "text",
  autoComplete,
  placeholder,
  ...base
}: BaseFieldProps & {
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "email" | "url";
  autoComplete?: string;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <FieldShell id={id} {...base}>
      {(describedBy) => (
        <input
          id={id}
          type={type}
          value={value}
          placeholder={placeholder}
          autoComplete={autoComplete}
          aria-describedby={describedBy}
          aria-required={base.required}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </FieldShell>
  );
}

export function TextArea({
  value,
  onChange,
  rows = 4,
  ...base
}: BaseFieldProps & {
  value: string;
  onChange: (value: string) => void;
  rows?: number;
}) {
  const id = useId();
  return (
    <FieldShell id={id} {...base}>
      {(describedBy) => (
        <textarea
          id={id}
          value={value}
          rows={rows}
          aria-describedby={describedBy}
          aria-required={base.required}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </FieldShell>
  );
}

export function SelectField({
  value,
  onChange,
  options,
  ...base
}: BaseFieldProps & {
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
}) {
  const id = useId();
  return (
    <FieldShell id={id} {...base}>
      {(describedBy) => (
        <select
          id={id}
          value={value}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
        >
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      )}
    </FieldShell>
  );
}

export function CheckboxField({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="field field-checkbox">
      <label htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={checked}
          aria-describedby={hint !== undefined ? hintId : undefined}
          onChange={(e) => onChange(e.target.checked)}
        />{" "}
        {label}
      </label>
      {hint !== undefined && (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      )}
    </div>
  );
}

export function NumberField({
  value,
  onChange,
  min,
  ...base
}: BaseFieldProps & {
  /** Empty string means "no value" (null); parsed integers otherwise. */
  value: number | null;
  onChange: (value: number | null) => void;
  min?: number;
}) {
  const id = useId();
  return (
    <FieldShell id={id} {...base}>
      {(describedBy) => (
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          value={value === null ? "" : String(value)}
          aria-describedby={describedBy}
          onChange={(e) => {
            const raw = e.target.value.trim();
            if (raw === "") {
              onChange(null);
              return;
            }
            const parsed = Number.parseInt(raw, 10);
            onChange(Number.isNaN(parsed) ? null : parsed);
          }}
        />
      )}
    </FieldShell>
  );
}
