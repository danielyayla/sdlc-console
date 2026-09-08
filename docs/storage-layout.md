# Storage layout (blueprint §12)

```
CLAUDE.md                       # harness working knowledge (parsed, never edited by console)
REVIEW.md                       # review policy
bands.yaml                      # control bands (Maintain)
.claude/
  settings.json                 # team hooks + permissions
  hooks/{plan-sync,test-freeze,verify-before-done,production-gate}.sh
  skills/<name>/SKILL.md
  agents/<name>.md
evals/
  cases/<CASE-ID>.json
  runs/<RUN-ID>.json
  check.sh
sdlc/
  config.yaml                   # roles, thresholds, records mapping, evals.mode, products, environments[] (3.6: name, kind preview|staging|production, deploy/rollback/healthcheck commands, gate.roles for production)
  templates/{intent,spec,plan,incident}.md
  changes/
    CHG-0042/
      change.yaml               # id, title, kind, risk, created, origin, record, cycle, repro, closed
      intent.md                 # front-matter: id, artifact, cycle, author, created, context_manifest?
      spec.md                   # + intent_sha, prompt_ref, skills[], concerns[]
      design/
      plan.md                   # + spec_sha, rev, accepted_by, accepted_at, files[], acceptance_line
      tasks.yaml
      evals/ run-1.json final-round.json screenshots/ repro.json
      pr.yaml
      deploy.yaml               # headline (env, version, at, status) + environments[] (one entry per deployment: sha, command, output verbatim, actor, authorizedBy for production) + rehearsals[] (rollback rehearsed on a non-production env at a sha) — 3.6
      incident.md
      log.jsonl                 # append-only ledger; .gitattributes merge=union
      cycles/1/ …
  loop/triage/TRI-0042.md       # `channel` items carry `channel{name, messageId, permalink, author, tags?}` (3.5, one per message id)
  loop/runbooks/RBK-0001.json   # runbook invocation record (allowlisted command, output verbatim)
  security/findings/SEC-0118.yaml   # scanner-owned fields incl. source/run/location/rule/cwe/evidence/resolved (3.5); routing status console-owned
  proposals/PRP-0007.yaml
.gitattributes                  # sdlc/**/log.jsonl merge=union
.github/workflows/sdlc-{evals,validate,detect,production-gate}.yml   # written by sdlc init (create-only)
.sdlc-state/                    # gitignored cache
  snapshots/<metric>.jsonl      # detection snapshots (last N), written by sdlc-detect
  sessions/<id>/deploys.jsonl   # a session's deploy_<env> / rehearse_rollback outcomes until the engine records them on deploy.yaml (3.6)
  sessions/<id>/output.log      # a non-Claude (`command`) harness's stdout/stderr verbatim, in place of stream.jsonl (3.8)
  sessions.db                   # sessions, job queue, metric facts, webhook deliveries (GitHub and the 3.5 intake, by `<kind>:<deliveryId>`)
```

## IDs
`CHG-NNNN`, `TRI-NNNN`, `SEC-NNNN`, `PRP-NNNN`, `INC-NNNN`, `RBK-NNNN`, zero-padded 4 digits. Next id = max(existing on default branch + local branches) + 1. Validator blocks duplicates.

## Branches
Artifact PRs: `sdlc/CHG-0042/intent|spec|plan`. Task branches / worktrees: `CHG-0042/<task-slug>`.

## Commits
Author = acting identity (human / agent / `sdlc-bot`). Message: `sdlc(CHG-0042): accept plan.md (gate 3)`. Trailers: `SDLC-Event: <ulid>`, `SDLC-Actor: <type>:<id>`. Artifact + its event in one commit.

## log.jsonl event shape
```json
{"id":"01J…","ts":"2026-09-03T10:00:00Z","seq":1,"cycle":1,
 "actor":{"type":"human|agent|system","id":"…","role":"po|eng|…","session":"…"},
 "event":"gate.accepted","data":{"gate":3,"artifactSha":"…"},"sha":"…","schema":1}
```
Event names: artifact.committed, gate.accepted, gate.sent_back, stage.entered, plan.drafted, question, plan.final, tasks.proposed, tasks.confirmed, session.started, session.stopped, round, hook.blocked, hook.allowed, verifier.result, repro.failed, repro.confirmed, freeze.lifted, evals.green, evals.red, pr.opened, pr.merged, review.finding, deploy.authorized (the production gate decision, human-only), deploy.started, deploy.finished, deploy.failed, rollback.rehearsed, record.writeback.*, override.mode, consult.tech_lead, note.

## Stage derivation (pure)
1 until `gate.accepted{1}`; 2 until `{2}`; 3 until `{3}` (or plan PR merge when high risk); 4 until a green per-change run whose config fingerprint matches current config; 5 until `pr.merged`; 6 until `gate.accepted{6}` → cycle+1, back to 1. Inconsistent inputs → validation error, excluded from queues.

The production gate (3.6) is not a stage: within stage 6 it is open while a production environment is declared, the PR is merged and the merged commit has no succeeded (or running) production entry in `deploy.yaml`; its required check `sdlc/rollback-rehearsed` passes when `rehearsals[]` holds a succeeded rehearsal in a non-production environment at the merge commit or the merged PR's head. The decision is `deploy.authorized{env, sha}` by a holder of the environment's gate roles.
