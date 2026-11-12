# Long-task reliability implementation plan

> For agentic workers: use subagent-driven-development, sequential implementation and scoped review. User approved the five bounded changes in this chat on 2026-11-11; no additional approval checkpoint is needed for these changes.

**Goal:** remove confirmed harness blockers for a roughly 40-minute software-project task, preserve genuine errors and existing authority, and deliver an inspectable installed candidate.
**Architecture:** reuse existing GUI execution inspector, Pi request journal, process checker, collaboration evidence, task projection and delivery links. No second scheduler, retry engine, context store or new global setting.
**Tech stack:** existing JS/React/Pi/Electron and agent-sync public interfaces.
**Spec:** approved chat design: environment before paid calls; strict-but-format-tolerant checker with at most one feedback correction; fulfill explicit staffing promises; truthful waiting diagnostics; discoverable partial artifacts.

## Global constraints
- No paid model calls, automatic transport replay, hidden model timeouts, automatic compaction or model substitution.
- Known completed invalid checker output may receive one specific-feedback correction under the same root/project budget. Unknown, interrupted, HTTP service-error and cancelled requests never trigger correction. Original output and new attempt remain separately inspectable.
- Keep strict source/evidence IDs and final acceptance. No invented successful checks. Preserve cancellation, frozen configuration, authority and original receipts.
- Keep execution network none, agent-sync untouched. Reuse existing public execution inspection. Tests must exercise real fault boundary; avoid mirror/source-text tests.
- Existing oversized code files must not grow; new hand-written files <=20480 bytes. Prefer existing appropriate files; production refactor only when truly needed.
- Work locally in codex/long-task-reliability. No remote publication during implementation. Root owns staging/commits/package/install.

## Task 1 — execution preflight
Files: src/gui-controller.js, src/gui-settings.js, src/gui-work.js, narrowly src/discussion.js environment terminal status, and existing GUI execution/admission test files/helpers.
Consumes inspectGuiExecution(home,{probe,runDocker,onCleanupPending}) and the controller executionInspector seam.
Deliverable: explicit file submissions refuse unavailable daemon/image before a model call while retaining draft; inferred file routes and confirmations verify environment before execution. Recovered already-accepted receipts must remain readable without Docker.
- Reproduce with existing HTTP/controller fixture and injected unavailable inspector, asserting zero model requests, preserved draft and precise error code.
- Reuse inspector/digest against frozen/current work config correctly; do not accept a stale settings diagnostic for a different image/config.
- Keep pure chat, history and unknown-receipt lookup independent of Docker. Check configuration changes and cancelled admission.
- Reuse fixed local probe where necessary to establish Node execution; do not execute model/project-supplied arbitrary commands before approval or install dependencies silently.
- Run focused admission/settings/integration checks and report exact commands, failures, final results and limits.

## Task 2 — process-check format and bounded correction
Files: src/process-check.js, existing readonly/formal checker tests, necessary request/policy/projection callers only when existing binding requires it.
- Capture baseline: valid JSON works, fenced identical JSON currently fails (work/long-task-readiness/probe.mjs).
- Accept a whole JSON value or one complete outer JSON Markdown fence; retain the full strict issues/identity/evidence validation. No arbitrary substring extraction or guessing.
- On known completed invalid report only, issue at most one new feedback correction using same frozen model/snapshot and precise validation error. Reuse existing observations/stages/journal/budget; bind provenance of both attempts. Successful correction must be coverable by current delivery checks.
- Do not retry HTTP503, unknown/in-flight, cancellation, persistence or budget failure. Final invalid correction remains blocked with original cause visible. Ordinary employee activity must not trigger unbounded correction loops.
- Verify valid/fenced/semantic correction success, second invalid failure, cancellation, unknown/no-repeat, budget exhausted, source spoof rejection and actual per-call accounting using existing local fixtures.

## Task 3 — promised collaboration completion
Files: src/discussion.js, src/project-readonly-roles.js, src/project-collaboration-evidence.js, src/project-file-confirmation.js / manager final integration as needed, existing unified tests.
- Trace actual completion boundary before closing resources. If explicit user or sealed plan requires collaboration and missing work can still be performed within current authority/budget, return one precise corrective instruction to the responsible manager in the existing session, allowing actual delegation/collect.
- Do not add task classification calls or force teams on simple/optional requests. Do not reopen a closed/unknown assignment or treat repeated collect/empty metadata as staffed work.
- One completion-correction opportunity per relevant attempt, journaled and budgeted; unsatisfied requirements remain partial/blocked with exact reason. File-plan collaboration must be corrected while the executor can still act, never by bypassing accepted versions or inventing members after completion.
- Test manager initially finishes without employees then actually delegates and collects; no correction on simple/optional requests, unknown/cancelled state or insufficient budget; failed second answer remains explicit, no loop. Preserve original file proposal confirmation.

## Task 4 — waiting and partial-delivery visibility
Files: src/gui-projection.js, src/gui-process-projection.js, existing conversation/result/process UI and corresponding tests.
- Inspect existing UI first; retain already adequate behavior. Project from durable request transport/stages/tool facts to show the current waiting model/command and elapsed wait/last received data without disclosing headers, credentials or system prompts.
- No new polling worker or hard timeout; use existing refresh/timer paths. Distinguish waiting, failed, unknown, approval needed and partial.
- Existing saved file/partial result links should remain available even if checks/placement/manager-final fails. Show last succeeded step, immediate cause and existing resume capability where actually supported; no automatic resend or fake resume.
- Show the one-feedback-correction policy in existing request/budget details (not another permanent banner or thinking-menu caption).
- Verify slow/no-response/unknown display and final-report-failure with preserved file links through existing UI fixtures; inspect screenshots.

## Task 5 — integrated acceptance and local delivery
Root owns README/DESIGN_BASELINE/CHANGELOG/VALIDATION, next patch version .8, whole-change independent review and .noindex packaging.
- Run fault scenarios and appropriate full GUI/Pi/App suites; preserve every failed run and distinguish fixture, real containers and real provider evidence.
- Restore/check local Docker and configured image, bounded fixed tool probe; do not silently change user model/network settings.
- Exercise a sustained local simulated model/software pipeline with actual managed execution and process checks. A wall-time run can test mechanics but must not be reported as 40-minute real-provider reliability.
- Build, verify resource/source hashes, backup and install as already authorized for this app; unregister candidates and confirm one formal Spotlight/search entry.
- Real paid 40-minute task still needs a concrete user task and spending authorization. Do not claim guaranteed future success; report remaining evidence gaps precisely.
