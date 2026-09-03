import { describe, expect, it } from "vitest";
import { relativeTime, waitingFor } from "../src/lib/format";
import { initialState, reduce } from "../src/state";

const now = new Date("2026-09-03T12:00:00Z");

describe("relativeTime / waitingFor", () => {
  it("rounds to the nearest unit", () => {
    expect(relativeTime("2026-09-03T11:59:50Z", now)).toBe("just now");
    expect(relativeTime("2026-09-03T11:40:00Z", now)).toBe("20m ago");
    expect(relativeTime("2026-09-03T09:00:00Z", now)).toBe("3h ago");
    expect(relativeTime("2026-09-01T12:00:00Z", now)).toBe("2d ago");
    expect(relativeTime("2026-08-01T12:00:00Z", now)).toBe("5w ago");
    expect(waitingFor("2026-09-03T09:00:00Z", now)).toBe("waiting 3h");
    expect(relativeTime("nope", now)).toBe("");
  });
});

describe("UIState reducer (spec §2/§5)", () => {
  it("tab switch clears selection; role switch never changes view", () => {
    let s = reduce(initialState(), { type: "select", id: "CHG-0022" });
    expect(s).toMatchObject({ view: "detail", sel: "CHG-0022" });
    s = reduce(s, { type: "role", role: "eng" });
    expect(s).toMatchObject({ view: "detail", sel: "CHG-0022", role: "eng" });
    s = reduce(s, { type: "tab", view: "gates" });
    expect(s).toMatchObject({ view: "gates", sel: null, art: null });
  });
  it("new toast replaces the old; clearing only removes the matching one", () => {
    let s = reduce(initialState(), { type: "toast", text: "a" });
    const first = s.toast?.n ?? 0;
    s = reduce(s, { type: "toast", text: "b" });
    expect(s.toast?.text).toBe("b");
    s = reduce(s, { type: "toast.clear", n: first });
    expect(s.toast?.text).toBe("b");
    s = reduce(s, { type: "toast.clear", n: s.toast?.n ?? 0 });
    expect(s.toast).toBeNull();
  });
  it("seed-role applies once from defaultRole", () => {
    expect(reduce(initialState("po"), { type: "seed-role", role: "eng" }).role).toBe("eng");
  });
});
