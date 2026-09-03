/** Artifact templates installed by `sdlc init` (mirror of sdlc/templates/ in this repo). */
export const TEMPLATES: Record<"intent" | "spec" | "plan" | "incident", string> = {
  intent: `---
id: CHG-0000
artifact: intent
cycle: 1
author: 
created: 
status: draft
schema: 1
---
# Intent: <title>

## Problem
<what cannot be done today, who is affected>

## Proposed outcome
<what better looks like>

## Affected users and systems

## Constraints

## Open questions
`,
  spec: `---
id: CHG-0000
artifact: spec
cycle: 1
intent_sha: 
prompt_ref: 
skills: []          # [{name, version}]
concerns: []        # [{id, policy, owner, resolved: bool, note}]
created: 
schema: 1
---
# Spec: <title>

## Requirements

## Design

## Areas of concern
<each concern flagged with the policy it touches and its owner>

## Open questions carried forward
`,
  plan: `---
id: CHG-0000
artifact: plan
cycle: 1
spec_sha: 
rev: 1
accepted_by: 
accepted_at: 
acceptance_line: ""   # quantifiable done criterion, prefills session target
schema: 1
---
# Plan: <title> (from spec.md <sha>)

## Files that change
<one path per line; new files marked (new)>

## Order of work
1.

## Risks

## Proof
<which tests, which screenshot, which endpoint>
`,
  incident: `---
id: CHG-0000
artifact: incident
cycle: 1
src: 
tier: 
created: 
schema: 1
---
# Incident: <title>

## Anomaly and evidence

## Proposed outcome

## Affected systems

## Open questions
`,
};
