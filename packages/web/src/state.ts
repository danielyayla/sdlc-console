import type { Role } from "./lib/format";

export type View = "board" | "detail" | "gates" | "sessions" | "config" | "loop" | "security" | "metrics";

/** The one inline reason form open on screen (rule 3: forms replace prompts); `id` scopes it to a row. */
export type FormState = { kind: string; id?: string } | null;

/** Spec §2 UIState plus the product in view (3.2: a server may hold several) and the open inline form. */
export interface UIState {
  view: View;
  role: Role;
  sel: string | null;
  art: number | null;
  toast: { text: string; n: number } | null;
  /** Product the console shows; null = the server's primary product. */
  product: string | null;
  form: FormState;
  /** The session row open on the Sessions tab (rule 3: its actions appear when selected). */
  session: string | null;
}

export type UIAction =
  | { type: "tab"; view: Exclude<View, "detail"> }
  | { type: "role"; role: Role }
  | { type: "product"; name: string | null }
  | { type: "select"; id: string }
  | { type: "back" }
  | { type: "art"; index: number | null }
  | { type: "toast"; text: string }
  | { type: "toast.clear"; n: number }
  | { type: "seed-role"; role: Role }
  | { type: "form.open"; kind: string; id?: string }
  | { type: "form.close" }
  | { type: "session"; id: string | null };

export function initialState(role: Role = "po", product: string | null = null): UIState {
  return { view: "board", role, sel: null, art: null, toast: null, product, form: null, session: null };
}

/** Is the form for this row open? */
export function formOpen(form: FormState, kind: string, id?: string): boolean {
  return form !== null && form.kind === kind && form.id === id;
}

/** Tab switch clears selection; role switch never changes view; product switch keeps the tab but drops the selection (ids belong to a product); accept resets artifact selection via `art: null`. Any navigation or role change closes the open form. */
export function reduce(state: UIState, action: UIAction): UIState {
  switch (action.type) {
    case "tab":
      return { ...state, view: action.view, sel: null, art: null, form: null, session: null };
    case "role":
      return { ...state, role: action.role, form: null };
    case "product":
      return state.product === action.name ? state : { ...state, product: action.name, view: state.view === "detail" ? "board" : state.view, sel: null, art: null, form: null, session: null };
    case "seed-role":
      return state.role === action.role ? state : { ...state, role: action.role };
    case "select":
      return { ...state, view: "detail", sel: action.id, art: null, form: null };
    case "back":
      return { ...state, view: "board", sel: null, art: null, form: null };
    case "art":
      return { ...state, art: action.index };
    case "toast":
      return { ...state, toast: { text: action.text, n: (state.toast?.n ?? 0) + 1 } };
    case "toast.clear":
      return state.toast?.n === action.n ? { ...state, toast: null } : state;
    case "form.open":
      return { ...state, form: action.id === undefined ? { kind: action.kind } : { kind: action.kind, id: action.id } };
    case "form.close":
      return state.form === null ? state : { ...state, form: null };
    case "session":
      return state.session === action.id ? state : { ...state, session: action.id, form: null };
  }
}
