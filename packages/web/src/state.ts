import type { Role } from "./lib/format";

export type View = "board" | "detail" | "gates" | "sessions" | "config" | "loop" | "security" | "metrics";

/** Spec §2 UIState, nothing more. */
export interface UIState {
  view: View;
  role: Role;
  sel: string | null;
  art: number | null;
  toast: { text: string; n: number } | null;
}

export type UIAction =
  | { type: "tab"; view: Exclude<View, "detail"> }
  | { type: "role"; role: Role }
  | { type: "select"; id: string }
  | { type: "back" }
  | { type: "art"; index: number | null }
  | { type: "toast"; text: string }
  | { type: "toast.clear"; n: number }
  | { type: "seed-role"; role: Role };

export function initialState(role: Role = "po"): UIState {
  return { view: "board", role, sel: null, art: null, toast: null };
}

/** Tab switch clears selection; role switch never changes view; accept resets artifact selection via `art: null`. */
export function reduce(state: UIState, action: UIAction): UIState {
  switch (action.type) {
    case "tab":
      return { ...state, view: action.view, sel: null, art: null };
    case "role":
      return { ...state, role: action.role };
    case "seed-role":
      return state.role === action.role ? state : { ...state, role: action.role };
    case "select":
      return { ...state, view: "detail", sel: action.id, art: null };
    case "back":
      return { ...state, view: "board", sel: null, art: null };
    case "art":
      return { ...state, art: action.index };
    case "toast":
      return { ...state, toast: { text: action.text, n: (state.toast?.n ?? 0) + 1 } };
    case "toast.clear":
      return state.toast?.n === action.n ? { ...state, toast: null } : state;
  }
}
