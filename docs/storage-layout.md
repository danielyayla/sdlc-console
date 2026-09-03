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
  config.yaml                   # roles, thresholds, records mapping, evals.mode, products
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
      deploy.yaml
      incident.md
      log.jsonl                 # append-only ledger; .gitattributes merge=union
      cycles/1/ …
  loop/triage/TRI-0042.md
  security/findings/SEC-0118.yaml
  proposals/PRP-0007.yaml
.gitattributes                  # sdlc/**/log.jsonl merge=union
.sdlc-state/                    # gitignored cache
```

## IDs
`CHG-NNNN`, `TRI-NNNN`, `SEC-NNNN`, `PRP-NNNN`, `INC-NNNN`, zero-padded 4 digits. Next id = max(existing on default branch + local branches) + 1. Validator blocks duplicates.

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
Event names: artifact.committed, gate.accepted, gate.sent_back, stage.entered, plan.drafted, question, plan.final, tasks.proposed, tasks.confirmed, session.started, session.stopped, round, hook.blocked, hook.allowed, verifier.result, repro.failed, repro.confirmed, freeze.lifted, evals.green, evals.red, pr.opened, pr.merged, review.finding, deploy.*, record.writeback.*, override.mode, consult.tech_lead, note.

## Stage derivation (pure)
1 until `gate.accepted{1}`; 2 until `{2}`; 3 until `{3}` (or plan PR merge when high risk); 4 until a green per-change run whose config fingerprint matches current config; 5 until `pr.merged`; 6 until `gate.accepted{6}` → cycle+1, back to 1. Inconsistent inputs → validation error, excluded from queues.
