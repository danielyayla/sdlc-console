import { useState, type KeyboardEvent } from "react";

export interface InlineReasonField {
  key: string;
  placeholder: string;
  /** Default true. */
  required?: boolean;
  /** Prefilled value (e.g. the single frozen test path). */
  initial?: string;
}

export interface InlineReasonProps {
  /** What the prompt string used to say. */
  placeholder: string;
  /** "Send back", "Lift freeze", "Dismiss proposal", … */
  submitLabel: string;
  /** Default true; false only for downgrade + tune-band. */
  required?: boolean;
  /** Multi-field form (link record: system, id, url); one input per field, stacked. */
  fields?: InlineReasonField[];
  onSubmit: (values: Record<string, string>) => void;
  onCancel: () => void;
}

/** The submit button is live once every required field is non-empty after trim. */
export function canSubmit(fields: readonly InlineReasonField[], values: Record<string, string>): boolean {
  return fields.every((f) => f.required === false || (values[f.key] ?? "").trim() !== "");
}

function trimmed(values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) out[k] = v.trim();
  return out;
}

/**
 * The inline reason form that replaced every `window.prompt()`: one textarea
 * (or one input per field), a submit button that is dim until the required
 * fields are filled, and Cancel. Enter in an input submits; Esc cancels.
 */
export function InlineReason({ placeholder, submitLabel, required = true, fields, onSubmit, onCancel }: InlineReasonProps) {
  const spec: InlineReasonField[] = fields ?? [{ key: "reason", placeholder, required }];
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(spec.map((f) => [f.key, f.initial ?? ""])));
  const ready = canSubmit(spec, values);
  const submit = () => {
    if (!ready) return;
    onSubmit(trimmed(values));
  };
  const onKey = (e: KeyboardEvent<HTMLElement>, isInput: boolean) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    } else if (e.key === "Enter" && isInput) {
      e.preventDefault();
      submit();
    }
  };
  const set = (key: string, v: string) => setValues((prev) => ({ ...prev, [key]: v }));
  return (
    <div className="inline-reason" role="form" aria-label={submitLabel}>
      {fields ? (
        fields.map((f, i) => (
          <input key={f.key} className="field" aria-label={f.key} placeholder={f.placeholder} value={values[f.key] ?? ""} autoFocus={i === 0} onChange={(e) => set(f.key, e.target.value)} onKeyDown={(e) => onKey(e, true)} />
        ))
      ) : (
        <textarea className="reason" aria-label="reason" placeholder={placeholder} value={values["reason"] ?? ""} autoFocus onChange={(e) => set("reason", e.target.value)} onKeyDown={(e) => onKey(e, false)} />
      )}
      <div className="row">
        <button type="button" className="btn" disabled={!ready} onClick={submit}>{submitLabel}</button>
        <button type="button" className="btn text" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
