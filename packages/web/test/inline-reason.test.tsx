import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { loadRepo } from "@sdlc/core";
import { PO, seedSessions, seedTree } from "@sdlc/fixtures";
import { buildSnapshot } from "@sdlc/server";
import { App } from "../src/app";
import { InlineReason, canSubmit } from "../src/views/InlineReason";
import { formOpen, initialState, reduce } from "../src/state";

const now = new Date("2026-09-03T12:00:00Z");
const snapshot = buildSnapshot(loadRepo(seedTree()), { id: PO, name: "Priya Owens", roles: ["po", "eng"] }, seedSessions() as never, 1, now);
const render = (state = initialState("po")) => renderToString(<App snapshot={snapshot} initial={state} now={now} live={false} />).replace(/<!-- -->/g, "");

// The web package has no DOM test environment (no jsdom, no testing-library — the brief forbids new dependencies),
// so interaction is proven through the reducer that owns the open form, the pure submit gate, and server renders of each state.
describe("InlineReason (rule 3: forms replace prompts)", () => {
  it("submit is disabled while a required field is blank; a form with no required field submits with an empty reason", () => {
    const required = [{ key: "reason", placeholder: "why" }];
    expect(canSubmit(required, { reason: "" })).toBe(false);
    expect(canSubmit(required, { reason: "   " })).toBe(false);
    expect(canSubmit(required, { reason: "because" })).toBe(true);
    // downgrade: reason optional
    expect(canSubmit([{ key: "reason", placeholder: "optional", required: false }], { reason: "" })).toBe(true);
    // link record: system + id required, url optional
    const link = [{ key: "system", placeholder: "s" }, { key: "id", placeholder: "i" }, { key: "url", placeholder: "u", required: false }];
    expect(canSubmit(link, { system: "jira", id: "", url: "" })).toBe(false);
    expect(canSubmit(link, { system: "jira", id: "INV-1", url: "" })).toBe(true);
    const html = renderToString(<InlineReason placeholder="Why it goes back — required" submitLabel="Send back" onSubmit={() => undefined} onCancel={() => undefined} />);
    expect(html).toMatch(/<button type="button" class="btn" disabled="">Send back<\/button>/);
    expect(html).toContain('placeholder="Why it goes back — required"');
    expect(html).toContain(">Cancel</button>");
    const prefilled = renderToString(<InlineReason placeholder="" submitLabel="Lift freeze" fields={[{ key: "path", placeholder: "which file", initial: "test/export/zero-total.test.ts" }, { key: "reason", placeholder: "why" }]} onSubmit={() => undefined} onCancel={() => undefined} />);
    expect(prefilled).toContain('value="test/export/zero-total.test.ts"');
    expect(prefilled).toMatch(/<button type="button" class="btn" disabled="">Lift freeze<\/button>/);
  });

  it("the reducer opens one form at a time and every navigation, role switch or Esc (form.close) closes it", () => {
    const s0 = { ...initialState("eng"), view: "detail" as const, sel: "CHG-0022" };
    const opened = reduce(s0, { type: "form.open", kind: "sendback" });
    expect(opened.form).toEqual({ kind: "sendback" });
    expect(formOpen(opened.form, "sendback")).toBe(true);
    expect(formOpen(opened.form, "sendback", "x")).toBe(false);
    const scoped = reduce(opened, { type: "form.open", kind: "dismiss-finding", id: "src/a.ts" });
    expect(scoped.form).toEqual({ kind: "dismiss-finding", id: "src/a.ts" });
    expect(formOpen(scoped.form, "dismiss-finding", "src/a.ts")).toBe(true);
    expect(formOpen(scoped.form, "dismiss-finding", "src/b.ts")).toBe(false);
    expect(reduce(scoped, { type: "form.close" }).form).toBeNull();
    expect(reduce(scoped, { type: "tab", view: "sessions" }).form).toBeNull();
    expect(reduce(scoped, { type: "role", role: "po" }).form).toBeNull();
    expect(reduce(scoped, { type: "select", id: "CHG-0020" }).form).toBeNull();
    expect(reduce(scoped, { type: "back" }).form).toBeNull();
    expect(reduce(scoped, { type: "product", name: "billing" }).form).toBeNull();
    expect(reduce(scoped, { type: "session", id: "sess-0018-repro" })).toMatchObject({ session: "sess-0018-repro", form: null });
    expect(reduce({ ...scoped, session: "sess-0018-repro" }, { type: "tab", view: "sessions" }).session).toBeNull();
    // closing an already closed form is a no-op
    expect(reduce(s0, { type: "form.close" })).toBe(s0);
  });

  it("the send-back form renders under the gate only once its link is clicked, with the same onSendBack contract", () => {
    const closed = render({ ...initialState("po"), view: "detail", sel: "CHG-0022" });
    expect(closed).toContain("Send back with feedback");
    expect(closed).not.toContain('placeholder="Why it goes back — required"');
    const opened = render({ ...initialState("po"), view: "detail", sel: "CHG-0022", form: { kind: "sendback" } });
    expect(opened).toContain('placeholder="Why it goes back — required"');
    expect(opened).toMatch(/<button type="button" class="btn" disabled="">Send back<\/button>/);
    expect(opened).not.toContain("Send back with feedback");
  });

  it("session guidance and downgrade, proposal, triage and finding dismissals each open their own form beneath the row", () => {
    const guidance = render({ ...initialState("eng"), view: "sessions", form: { kind: "guidance", id: "sess-0019-plan" } });
    expect(guidance).toContain("Guidance for sess-0019-plan — goes to the session");
    expect(guidance).toContain(">Send guidance</button>");
    expect((guidance.match(/class="inline-reason"/g) ?? []).length).toBe(1);
    const proposal = render({ ...initialState("eng"), view: "config", form: { kind: "dismiss-proposal", id: "PRP-0007" } });
    expect(proposal).toContain(">Dismiss proposal</button>");
    expect((proposal.match(/class="inline-reason"/g) ?? []).length).toBe(1);
    const triage = render({ ...initialState("po"), view: "loop", form: { kind: "dismiss-triage", id: "TRI-0042" } });
    expect(triage).toContain("Why TRI-0042 is dismissed — required");
    expect(triage).toContain("Tune the band? — optional note");
    const finding = render({ ...initialState("eng"), view: "security", form: { kind: "dismiss-finding", id: "SEC-0118" } });
    expect(finding).toContain("Why SEC-0118 is dismissed — required");
    // a form scoped to another row does not open here
    expect(render({ ...initialState("eng"), view: "security", form: { kind: "dismiss-finding", id: "SEC-0999" } })).not.toContain('class="inline-reason"');
  });
});
