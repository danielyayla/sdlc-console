import { parseArgs } from "node:util";
import { auditCommand, renderAudit } from "./commands/audit.js";
import { changeList, changeNew, changeShow, summarize } from "./commands/change.js";
import { acceptCommand, parseGate, sendBackCommand } from "./commands/gate.js";
import { hookCommand } from "./commands/hook.js";
import { init } from "./commands/init.js";
import { securityCommand, securityImportCommand } from "./commands/security.js";
import { serveCommand } from "./commands/serve.js";
import { evalsGate, evalsHarvest, evalsRun, evalsTrigger, renderGate, renderRun, renderTrigger } from "./commands/evals.js";
import { proposalCommand } from "./commands/proposal.js";
import { freezeCommand, reproCommand } from "./commands/repro.js";
import { sessionCommand } from "./commands/session.js";
import { syncCommand } from "./commands/sync.js";
import { triageAcceptCommand, triageDismissCommand } from "./commands/triage.js";
import { loopCommand } from "./commands/loop.js";
import { mcpCommand } from "./commands/mcp.js";
import { runCommand } from "./commands/run.js";
import { formatDiagnostic, validateCommand } from "./commands/validate.js";
import { repoContext } from "./context.js";
import { CliError, table, type Io } from "./io.js";

export const USAGE = `sdlc — console over a git repo running an AI-native SDLC

  sdlc init [--product <name>] [--intent-home <path>]
  sdlc validate [--ref <ref>] [--working]
  sdlc change new --title <t> [--kind feature|fix] [--risk routine|high] [--origin idea|ticket:REF|…] [--intent <file|->]
  sdlc change list [--stage n]
  sdlc change show <CHG>
  sdlc accept <CHG> --gate n
  sdlc send-back <CHG> --gate n --feedback <text>
  sdlc loop <CHG> [--incident <file>]
  sdlc audit <CHG>
  sdlc serve [--port n] [--host addr] [--role po|eng]
  sdlc triage accept|dismiss <TRI> [--reason <text>] [--tune <note>]
  sdlc security patch|escalate|dismiss <SEC> [--reason <text>]
  sdlc security import <file|->
  sdlc hook plan-sync|test-freeze|verify-before-done   (harness JSON on stdin; exit 2 blocks)
  sdlc mcp                                              (agent tools over stdio)
  sdlc session start <CHG> [--kind k] [--task id] [--target t] [--mode m] [--detach]   (kinds: intent design plan build review diagnose propose)
  sdlc session list | stop <id> | downgrade <id> [--reason r]   (downgrade: AUTO → SUPERVISED, never upward)
  sdlc repro confirm <CHG> [--file t --reason r --sha s]   (fix: the reported test fails for the right reason → freeze)
  sdlc repro reject <CHG> --reason r                    (wrong failure — send back to the session)
  sdlc freeze lift <CHG> --file p --reason r            (once per file per change; logged)
  sdlc freeze dismiss <CHG> --file p --reason r         (dismiss the test-freeze auto-finding blocking the merge)
  sdlc run <CHG>                                        (per-change run: verification + intersecting evals; green opens the PR)
  sdlc serve --engine                                   (launch sessions and runs automatically on transitions)
  sdlc sync                                             (GitHub mode: open artifact PRs, record merges done on GitHub, refresh the records PR)
  sdlc evals run [--trigger manual|schedule|config-pr] [--ref r]   (run every active case; commits evals/runs/RUN-NNNN.json; raises retire/broken-check triage)
  sdlc evals gate [--run RUN-id]                        (config-change gate: exit 1 below threshold, regressed cases with before/after)
  sdlc evals harvest <CHG>                              (post-merge "Add as eval": draft case for the platform owner)
  sdlc evals trigger <skill> --prompt <text>            (trigger test: exit 0 iff the harness loaded the skill; the check a skill:<name> case uses)
  sdlc proposal accept <PRP>                            (CLAUDE.md line → branch sdlc/proposals/<PRP> and, in GitHub mode, a PR for the code owners)
  sdlc proposal dismiss <PRP> --reason <text>
  POST /api/webhooks/github                             (GitHub mode: signed deliveries under GITHUB_WEBHOOK_SECRET; polling stays on as the fallback)

Every command accepts --json. Mutating commands refuse when SDLC_ACTOR_TYPE=agent.
Exit codes: 0 ok · 1 error / blocking validation · 2 refused (role, gate, agent).`;

const OPTIONS = {
  json: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
  product: { type: "string" },
  "intent-home": { type: "string" },
  ref: { type: "string" },
  working: { type: "boolean", default: false },
  title: { type: "string" },
  kind: { type: "string" },
  risk: { type: "string" },
  origin: { type: "string" },
  intent: { type: "string" },
  stage: { type: "string" },
  gate: { type: "string" },
  feedback: { type: "string" },
  incident: { type: "string" },
  port: { type: "string" },
  host: { type: "string" },
  trigger: { type: "string" },
  run: { type: "string" },
  reason: { type: "string" },
  file: { type: "string" },
  sha: { type: "string" },
  output: { type: "string" },
  task: { type: "string" },
  target: { type: "string" },
  mode: { type: "string" },
  detach: { type: "boolean", default: false },
  engine: { type: "boolean", default: false },
  tune: { type: "string" },
  role: { type: "string" },
  "no-wait": { type: "boolean", default: false },
  prompt: { type: "string" },
} as const;

function emit(io: Io, json: boolean, value: unknown, human: () => string): void {
  io.stdout(json ? `${JSON.stringify(value, null, 2)}\n` : `${human()}\n`);
}

/** Entry point shared by the bin and the tests. Returns the exit code. */
export async function main(argv: string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    io.stderr(`${(e as Error).message}\n${USAGE}\n`);
    return 1;
  }
  const { values, positionals } = parsed;
  const json = values.json === true;
  const [cmd, sub, ...rest] = positionals;
  if (values.help || !cmd) {
    io.stdout(`${USAGE}\n`);
    return values.help ? 0 : 1;
  }
  try {
    switch (cmd) {
      case "init": {
        const r = await init(io, { ...(values.product ? { product: values.product } : {}), ...(values["intent-home"] ? { intentHome: values["intent-home"] } : {}) });
        emit(io, json, r, () => [...r.created.map((c) => `created  ${c}`), ...r.skipped.map((s) => `kept     ${s}`), ...(r.hooksSnippet ? ["", ".claude/settings.json exists — add these hooks to it:", r.hooksSnippet] : [])].join("\n"));
        return 0;
      }
      case "validate": {
        const ctx = await repoContext(io, json);
        const r = await validateCommand(ctx, { ...(values.ref ? { ref: values.ref } : {}), working: values.working === true });
        emit(io, json, r, () => (r.diagnostics.length === 0 ? `${r.ref}: clean` : [...r.diagnostics.map(formatDiagnostic), r.blocking ? `${r.ref}: BLOCKING` : `${r.ref}: ok with warnings`].join("\n")));
        return r.blocking ? 1 : 0;
      }
      case "change": {
        const ctx = await repoContext(io, json);
        if (sub === "new") {
          if (!values.title) throw new CliError("--title is required");
          const r = await changeNew(ctx, {
            title: values.title,
            kind: (values.kind ?? "feature") as "feature" | "fix",
            risk: (values.risk ?? "routine") as "routine" | "high",
            origin: values.origin ?? "idea",
            ...(values.intent ? { intent: values.intent } : {}),
          });
          emit(io, json, r, () => `${r.id} created at stage 1 (${r.view.status}) · ${r.commit.slice(0, 7)}`);
          return 0;
        }
        if (sub === "list") {
          const r = await changeList(ctx, { ...(values.stage ? { stage: Number(values.stage) } : {}), ...(values.ref ? { ref: values.ref } : {}) });
          emit(io, json, r, () => (r.length === 0 ? "no changes" : table(r.map(summarize), ["id", "stage", "gate", "⌁", "risk", "status"])));
          return 0;
        }
        if (sub === "show") {
          const id = rest[0];
          if (!id) throw new CliError("usage: sdlc change show <CHG>");
          const v = await changeShow(ctx, id, values.ref ?? "HEAD");
          emit(io, json, v, () =>
            [
              `${v.id}  ${v.title}`,
              `stage ${v.stage} · ${v.stageName} · cycle ${v.cycle} · ${v.kind} · ${v.risk}`,
              `status: ${v.status}`,
              v.gate ? `gate ${v.gate.s} · ${v.gate.label} · owner ${v.gate.ownerRole} · since ${v.gate.since}` : "no gate open",
              `docs: ${Object.values(v.docs).map((d) => `${d.name}=${d.state}`).join("  ")}`,
              `auto: ${v.autoEligible.value ? "eligible" : "not eligible"} — ${v.autoEligible.terms.map((t) => `${t.ok ? "✓" : "✗"} ${t.name}`).join(", ")}`,
              v.valid ? "" : `validation errors:\n${v.validationErrors.map((d) => `  ${d.rule}: ${d.message}`).join("\n")}`,
              "activity:",
              ...v.activity.slice(0, 12).map((a) => `  ${a.actor === "agent" ? "⌁" : a.actor === "human" ? "●" : "·"} ${a.ts} ${a.actorId}: ${a.text}`),
            ]
              .filter((l) => l !== "")
              .join("\n"),
          );
          return 0;
        }
        throw new CliError(`unknown subcommand: change ${sub ?? ""}\n${USAGE}`);
      }
      case "accept": {
        const ctx = await repoContext(io, json);
        if (!sub) throw new CliError("usage: sdlc accept <CHG> --gate n");
        const r = await acceptCommand(ctx, sub, parseGate(values.gate));
        emit(io, json, r, () => `${r.view.gate ? "" : ""}${r.id}: gate ${r.gate} accepted · now stage ${r.view.stage} (${r.view.status}) · ${r.commit.slice(0, 7)}`);
        return 0;
      }
      case "send-back": {
        const ctx = await repoContext(io, json);
        if (!sub) throw new CliError("usage: sdlc send-back <CHG> --gate n --feedback <text>");
        const r = await sendBackCommand(ctx, sub, parseGate(values.gate), values.feedback ?? "");
        emit(io, json, r, () => `${r.id}: gate ${r.gate} sent back · stage ${r.view.stage} (${r.view.status}) · ${r.commit.slice(0, 7)}`);
        return 0;
      }
      case "loop": {
        const ctx = await repoContext(io, json);
        if (!sub) throw new CliError("usage: sdlc loop <CHG> [--incident <file>]");
        const r = await loopCommand(ctx, sub, values.incident ? { incident: values.incident } : {});
        emit(io, json, r, () => `${r.id}: loop closed → cycle ${r.cycle}, stage ${r.view.stage} (${r.view.status}) · ${r.commits.map((c) => c.slice(0, 7)).join(", ")}`);
        return 0;
      }
      case "triage": {
        const ctx = await repoContext(io, json);
        const id = rest[0];
        if (!id || (sub !== "accept" && sub !== "dismiss")) throw new CliError("usage: sdlc triage accept|dismiss <TRI>");
        const r = sub === "accept" ? await triageAcceptCommand(ctx, id) : await triageDismissCommand(ctx, id, values.reason ?? "", values.tune);
        emit(io, json, r, () => (r.changeId ? `${r.id} accepted → ${r.changeId} at the Plan gate · ${r.commit.slice(0, 7)}` : `${r.id} dismissed · ${r.commit.slice(0, 7)}`));
        return 0;
      }
      case "security": {
        const ctx = await repoContext(io, json);
        const id = rest[0];
        if (sub === "import") {
          if (!id) throw new CliError("usage: sdlc security import <file|->");
          const r = await securityImportCommand(ctx, id);
          emit(io, json, r, () => `imported ${r.imported} finding${r.imported === 1 ? "" : "s"} · ${r.commit.slice(0, 7)}`);
          return 0;
        }
        if (!id || (sub !== "patch" && sub !== "escalate" && sub !== "dismiss")) throw new CliError("usage: sdlc security patch|escalate|dismiss <SEC>");
        const r = await securityCommand(ctx, sub, id, values.reason);
        emit(io, json, r, () => (r.changeId ? `${r.id} escalated → ${r.changeId} at the Plan gate · ${r.commit.slice(0, 7)}` : `${r.id} ${sub === "patch" ? "patch in PR gate" : "dismissed"} · ${r.commit.slice(0, 7)}`));
        return 0;
      }
      case "run": {
        if (!sub) throw new CliError("usage: sdlc run <CHG>");
        const r = await runCommand(io, sub);
        emit(io, json, r, () => `${sub}: ${r.note ?? r.state}${r.error ? ` — ${r.error}` : ""}`);
        return r.state === "failed" ? 1 : 0;
      }
      case "repro": {
        const r = await reproCommand(io, sub, rest, values as Record<string, string | boolean | undefined>, json);
        emit(io, json, r.value, () => r.text);
        return 0;
      }
      case "proposal": {
        const r = await proposalCommand(io, sub, rest, values as Record<string, string | boolean | undefined>, json);
        emit(io, json, r.value, () => r.text);
        return 0;
      }
      case "freeze": {
        const r = await freezeCommand(io, sub, rest, values as Record<string, string | boolean | undefined>, json);
        emit(io, json, r.value, () => r.text);
        return 0;
      }
      case "session": {
        const r = await sessionCommand(io, sub, rest, values as Record<string, string | boolean | undefined>, json);
        emit(io, json, r.value, () => r.text);
        return 0;
      }
      case "mcp":
        return await mcpCommand(io);
      case "hook": {
        if (!sub) throw new CliError("usage: sdlc hook <name>");
        return await hookCommand(io, sub);
      }
      case "serve": {
        const server = await serveCommand(io, { ...(values.port ? { port: Number(values.port) } : {}), ...(values.host ? { host: values.host } : {}), ...(values.role === "eng" ? { role: "eng" as const } : {}), engine: values.engine === true });
        if (values["no-wait"]) {
          await server.close();
          return 0;
        }
        await new Promise<void>((resolve) => {
          process.once("SIGINT", resolve);
          process.once("SIGTERM", resolve);
        });
        await server.close();
        return 0;
      }
      case "sync": {
        const ctx = await repoContext(io, json);
        const r = await syncCommand(ctx);
        emit(io, json, r, () => `sync: ${r.opened.length} PR(s) opened${r.opened.map((o) => ` · ${o.changeId} ${o.branch} → #${o.number}`).join("")} · ${r.merges.filter((m) => m.recorded).length} merge(s) recorded${r.merges.filter((m) => !m.recorded && m.reason !== "already recorded").map((m) => ` · ${m.changeId} PR #${m.number} by ${m.mergedBy} not recorded: ${m.reason ?? ""}`).join("")} · records ${r.records.pushed ? `PR #${r.records.number ?? "?"} (${r.records.ahead} commit(s) ahead)` : r.records.error ? `failed: ${r.records.error}` : "in sync"}${r.errors.length > 0 ? `\n${r.errors.join("\n")}` : ""}`);
        return 0;
      }
      case "evals": {
        const ctx = await repoContext(io, json);
        if (sub === "run") {
          const r = await evalsRun(ctx, { ...(values.trigger ? { trigger: values.trigger as "manual" } : {}), ...(values.ref ? { ref: values.ref } : {}) });
          emit(io, json, r, () => renderRun(r));
          return 0;
        }
        if (sub === "gate") {
          const r = await evalsGate(ctx, values.run);
          emit(io, json, r, () => renderGate(r));
          return r.ok ? 0 : 1;
        }
        if (sub === "harvest") {
          const id = positionals[2];
          if (!id) throw new CliError("usage: sdlc evals harvest <CHG>");
          const r = await evalsHarvest(ctx, id);
          emit(io, json, r, () => `${r.caseId} drafted from ${id} (${r.commit.slice(0, 7)}) — the platform owner activates it under evals/cases`);
          return 0;
        }
        if (sub === "trigger") {
          const skill = positionals[2];
          if (!skill || !values.prompt) throw new CliError("usage: sdlc evals trigger <skill> --prompt <text>");
          const r = await evalsTrigger(io, skill, values.prompt);
          emit(io, json, r, () => renderTrigger(r));
          return r.loaded ? 0 : 1;
        }
        throw new CliError("usage: sdlc evals run|gate|harvest|trigger");
      }
      case "audit": {
        const ctx = await repoContext(io, json);
        if (!sub) throw new CliError("usage: sdlc audit <CHG>");
        const r = await auditCommand(ctx, sub, values.ref ?? "HEAD");
        emit(io, json, r, () => renderAudit(r));
        return r.clean ? 0 : 1;
      }
      default:
        throw new CliError(`unknown command: ${cmd}\n${USAGE}`);
    }
  } catch (e) {
    if (e instanceof CliError) {
      if (json) io.stdout(`${JSON.stringify({ error: e.message, details: e.details ?? null }, null, 2)}\n`);
      else {
        io.stderr(`error: ${e.message}\n`);
        if (Array.isArray(e.details)) for (const d of e.details as { rule?: string; message?: string; path?: string }[]) io.stderr(`  ${d.rule ?? ""}: ${d.message ?? ""}${d.path ? ` (${d.path})` : ""}\n`);
      }
      return e.exitCode;
    }
    io.stderr(`error: ${(e as Error).message}\n`);
    return 1;
  }
}
