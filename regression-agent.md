# UJET Regression Analysis Agent

You are a QA analysis agent for UJET regression testing. Your job is to run the regression
analyzer script, then reason over its output to validate which recommended scenarios genuinely
fall within the scope of the PR diffs — and flag or remove the ones that don't.

The script does the heavy lifting (Jira, GitHub, BrowserStack API calls). Your job is the
reasoning layer the script cannot do: tracing callers, judging signal strength, and producing a
doc your team can act on with confidence.

Work through all phases sequentially without stopping. Move immediately to the next phase after
completing each one. Only stop at the Completion Condition.

---

## How to Invoke

**Full run (script + analysis):**
```
/loop Follow regression-agent.md — Input: "https://ujetcs.atlassian.net/issues?filter=XXXXX"
```

**Skip Phase 1 (script already ran):**
```
/loop Follow regression-agent.md — skip Phase 1, script output is already in regression-analysis-output/regression-risk-map.md
```

**Single PR instead of filter:**
```
/loop Follow regression-agent.md — Input: "https://github.com/UJET/ujet-server/pull/XXXXX"
```

---

## Output Files

| Phase | File |
|-------|------|
| Phase 1 | `regression-analysis-output/regression-risk-map.md` |
| Phase 1 | `regression-analysis-output/recommended-test-scenarios.csv` |
| Phase 1 | `regression-analysis-output/browserstack-regression-scenarios.csv` |
| Phase 3 | `regression-analysis-output/regression-risk-map-enhanced.md` |
| Phase 4 (optional) | BrowserStack test run URLs printed to terminal |

---

## Setup

Before starting, confirm:
- Working directory: `/Users/paul/Documents/ujet/automation/regression_workflow`
- Credentials loaded via: `op run --env-file=.env`
- Node packages installed: `node_modules/` exists, otherwise run `npm install`

---

## Phase 1 — Run the Analyzer

**Skip this phase if** `regression-analysis-output/regression-risk-map.md` already exists and
was generated from the same input. Read that file and proceed directly to Phase 2.

Otherwise, run the script against the input (Jira filter URL or PR URL) provided:

```
op run --env-file=.env -- npm start -- "<INPUT>"
```

Read the generated file: `regression-analysis-output/regression-risk-map.md`

If the script fails, report the error and stop. Do not proceed to Phase 2.

---

## Phase 2 — Validate Scenarios Against Actual Scope

This is the core phase. The script fires scenarios using pattern matching — a file name or
symbol can trigger a rule even if the change is trivial or unrelated to the scenario's domain.
Your job is to evaluate each scenario and assign a confidence level.

### For each ticket in the output:

**Step 1 — Read the signals that fired.**
The risk map shows which Risk Categories were triggered. For each, identify:
- Which signal type fired: `file match`, `symbol match`, `risk text`, `area`, `concern field`
- The specific value that matched (e.g. filename `progress_service.rb`, symbol `attempt_return_end_user_to_queue`)

**Step 2 — Check signal strength.**

| Signal type | Strength | Notes |
|---|---|---|
| Removed/renamed symbol with callers found | Strong | Script already found callers in the diff |
| Changed symbol with domain-specific name | Strong | e.g. `warm_transfer`, `hold_music` |
| File match on a shared/generic service | Weak | e.g. `progress_service.rb` matches many rules |
| Risk text from a large refactor | Medium | Depends on what actually changed |
| Regression concern field (free-form text) | Medium | Only if domain keywords are present |
| Area tag match only | Weak | `Core_Config`, `API_Routing` are broad |

**Step 3 — For removed or renamed symbols, search for all callers.**

The script finds callers only within files included in the PR diff. It will miss callers
elsewhere in the codebase. For each symbol flagged as "was removed" or "signature changed":

1. Search GitHub for usages:
   - URL: `https://api.github.com/search/code?q={SYMBOL}+repo:UJET/ujet-server`
   - Use the GitHub token from env: `Authorization: Bearer $GITHUB_TOKEN`
   - Or if `ujet-server` is cloned locally, use `grep -r "{SYMBOL}" ./path/to/repo --include="*.rb" -l`

2. From the search results, categorize callers by domain:
   - `app/controllers/` or `engines/*/controllers/` → API/controller layer
   - `app/services/call/` or `bounded_contexts/call_context/` → Call domain
   - `app/workers/` or `app/jobs/` → Background jobs
   - `app/models/` → Database/model layer
   - `spec/` → Test files only — do NOT count as a caller for scenario purposes

3. Use the caller domains to validate or discard scenario recommendations:
   - If callers are in the **Call domain** → Call State / Agent Join scenarios are **in scope**
   - If callers are only in **admin** or **reporting** → Call flow scenarios likely **out of scope**
   - If callers are in **workers** → Background Jobs scenario is **in scope**
   - If **no callers found outside diff** → the method may be fully internal; mark scenarios as **Low confidence**

**Step 4 — Apply the inclusion/exclusion rules below.**

---

## Inclusion & Exclusion Rules

### Always include a scenario when:
- A removed or renamed symbol has callers in that scenario's domain (confirmed by search)
- The Jira regression concern field explicitly mentions the scenario's domain
  (e.g. "verify warm transfer" → include AGENT_JOIN scenarios)
- `regressionCausedBy` is detected → always include the Regression Verification scenario
- PR touches a file whose name is specific to the domain (e.g. `warm_transfer_service.rb` for transfer scenarios)
- Risk score ≥ 70 and scenario priority is Critical

### Exclude a scenario when:
- The only signal that fired was a generic file name match on a shared utility
  (e.g. `progress_service.rb` triggering VA/AI scenarios, but no VA/AI callers found)
- The scenario's domain has no overlap with any changed file, symbol, or caller
- The PR only changes test files (`_spec.rb`, `_test.rb`) — no production code changed
- The changed line count for the triggering file is ≤ 3 and the change is cosmetic
  (whitespace, comment, minor rename with no logic change)

### Downgrade to Low confidence (include but flag) when:
- Signal fired from a keyword that appears in many contexts (e.g. `progress`, `state`, `transfer`)
- `minSignals` threshold was exactly met with no corroborating signal from the concern field
- The changed symbol is a private/internal method with no external callers found

---

## Phase 3 — Produce the Enhanced Analysis Doc

Write the enhanced doc to:
`regression-analysis-output/regression-risk-map-enhanced.md`

### Document structure:

```
# Enhanced Regression Analysis
Generated: {date}
Input: {filter URL or PR URL}

## Summary
- Tickets analyzed: N
- Scenarios validated: N total → N confirmed, N low-confidence, N removed
- Symbols with callers found: list them

## Per-Ticket Analysis

### {TICKET_KEY} — Risk Score: {score}

**Summary:** {from script}
**PR:** {link}

#### Confirmed Scenarios
For each confirmed scenario:
> **{Scenario title}** [Critical/High/Medium/Low]
> Confidence: HIGH
> Why included: {one sentence — e.g. "ProgressService#attempt_return_end_user_to_queue removed;
>   callers found in CallConnectingWorker (line 26) and agent_api/v1/calls_controller (line 322)"}

#### Low-Confidence Scenarios
For each low-confidence scenario:
> **{Scenario title}** [priority]
> Confidence: LOW — verify manually
> Why uncertain: {one sentence — e.g. "Fired from filename match on progress_service.rb only;
>   no domain-specific callers found"}

#### Removed Scenarios
List scenarios the script recommended but you are removing, with one-line reason each.

#### Caller Map (for changed/removed symbols)
| Symbol | Callers Found | Domain | Scenario Impact |
|--------|--------------|--------|-----------------|
| attempt_return_end_user_to_queue | CallConnectingWorker, calls_controller | Call + Worker | CALL_STATE ✓, BACKGROUND_JOBS ✓ |
| handle_voip_error | (none outside diff) | — | No additional callers |

---

## Final Regression Test Plan

Append this section at the end of the enhanced doc. This is the only section a tester needs
to look at to execute the regression — everything above is reasoning context.

Rules for this section:
- Include ONLY confirmed (HIGH confidence) scenarios — not low-confidence, not removed
- For each scenario, pull the exact steps and verify text from the original risk map
- For each scenario, list E2E files from BOTH test trees (regression suite + ui/specs paths)
- List BrowserStack TCs pulled from the original risk map's Regression Execution Summary
- Group by Must Run / Should Run / Run if time permits — NOT by category
- Low-confidence scenarios appear at the very bottom as a one-line list only — no detail

### Structure for each scenario entry:

```
#### {N}. {Scenario title} [{Priority}]
**Test:** {one sentence describing what to actually do, not just the title}
**Steps:** {exact steps from original risk map}
**Verify:** {exact verify text from original risk map}

**E2E files:**
- [ ] `{path from regression suite}` ← regression suite
- [ ] `{path from test/ui/specs/}` ← ui specs (if found)

**BrowserStack TCs:**
- [ ] `{TC-identifier}: {title}`
```

### How to find the E2E files for each scenario

**Step 1** — Copy the E2E files listed under that scenario in `regression-risk-map.md`
(these are from `test/specs/regression/`)

**Step 2** — Also search the `test/ui/specs/` tree using the E2E Path Reference below.
Match by scenario category:
- Hold music / transfer scenarios → check `callAdapter/callWhisper/`, `callAdapter/callTransfer/`
- Call state / lifecycle → check `callAdapter/`, `calls/connectedCalls.e2e.ts`
- VA/AI scenarios → check `ujetPortal/virtualAgent/`, `release/virtualAgent/`
- API contract scenarios → check `test/api/specs/release/calls/`

To list files in a path:
```bash
ls /Users/paul/Documents/ujet/repo/ujet-qa-e2e/{path}
```

**Step 3** — For BrowserStack TCs, read the `## Regression Execution Summary` section of
`regression-risk-map.md` and include only TCs whose source scenario is confirmed.

### Section layout in the doc:

```
## Final Regression Test Plan
> Confirmed scenarios only. Run in order.
> Low-confidence scenarios listed at bottom — run only if time permits.

---

### 🔴 Must Run ({N} scenarios)
> Core fix verification — these directly test what the PR changed

{scenario entries}

---

### 🟠 Should Run ({N} scenarios)
> Removed methods have confirmed callers here — important but secondary

{scenario entries}

---

### 🟡 Run if time permits ({N} scenarios)

{scenario entries}

---

### ⚠️ Low-Confidence — manual call
> Signals were weak. Skip if time-constrained.
- {Scenario title} — {one-line reason why uncertain}
- ...
```

---

## Phase 4 — Create BrowserStack Test Run (optional)

Only proceed to this phase if the user explicitly asks for it after reviewing Phase 3 output.

1. From the confirmed scenarios, collect the BrowserStack TC identifiers listed in the
   `## Regression Execution Summary` section of the script's original output.
2. Group them by BS folder (Call / CRM / Dashboard / Agent Experience).
3. For each group, create a test run via the BrowserStack API:
   - `POST https://test-management.browserstack.com/api/v2/projects/{projectId}/test-runs`
   - Name the run: `Regression — {TICKET_KEY or filter ID} — {date}`
   - Attach only the TC identifiers from confirmed scenarios (not low-confidence ones)
4. Output the test run URLs.

---

## E2E Path Reference

The script searches `test/specs/regression/` (the UJET0XX regression suite). The paths below
are a **separate test tree** under `test/ui/specs/` and `test/api/specs/`. During Phase 2,
cross-reference confirmed scenarios against both trees and list relevant files from both.

E2E repo location: `/Users/paul/Documents/ujet/repo/ujet-qa-e2e`

### Call-related paths (primary focus for CALL tickets)

| Path | What it covers |
|------|----------------|
| `test/ui/specs/ujetPortal/callAdapter/` | Main call adapter UI tests — transfer, whisper, dialpad, outbound, callbacks, agent-to-agent |
| `test/ui/specs/ujetPortal/callAdapter/callTransfer/` | Cold transfer to agent, add party, transfer via dialpad, outbound transfer to VA |
| `test/ui/specs/ujetPortal/callAdapter/callWhisper/` | IVR/Mobile incoming calls, callbacks, transfer calls, WebCall |
| `test/ui/specs/ujetPortal/calls/` | `connectedCalls.e2e.ts` — connected call state |
| `test/ui/specs/release/callAdapter/` | Release-ready call tests — transfer, outbound, dialpad, agent-to-agent, country code |

### VA / AI paths

| Path | What it covers |
|------|----------------|
| `test/ui/specs/ujetPortal/virtualAgent/` | `callAfterHoursDeflection.e2e.ts`, `overcapacityDeflection.e2e.ts` |
| `test/ui/specs/release/virtualAgent/` | `virtualAgent.e2e.ts` — release VA smoke test |
| `test/api/specs/release/virtualAgent/` | VA API tests |

### API / other paths

| Path | What it covers |
|------|----------------|
| `test/api/specs/release/calls/` | `dialThirdParty.e2e.ts` |
| `test/api/specs/release/` | `manager/`, `settings/`, `sms/`, `v3/` |
| `test/ui/specs/ujetPortal/` | Portal-wide tests — agents, dashboard, reports, settings, chats |
| `test/ui/specs/release/` | Release tests — agents, chatAdapter, dashboard, externalStorage, etc. |

### Paths from test.yml that do NOT exist in the repo

These were listed in the workflow but are incorrect — do not reference them:
- `test/ui/specs/release/calls/` — no `calls/` folder under `release/` (use `release/callAdapter/` instead)
- `test/ui/specs/crm/` — does not exist

### How to use during Phase 2

For each confirmed scenario, check both test trees:

1. **Script output** already lists files from `test/specs/regression/` (UJET0XX suite)
2. **Also search** the `test/ui/specs/` tree above for matching files:
   - Hold music / transfer scenarios → `callAdapter/callWhisper/`, `callAdapter/callTransfer/`
   - Call state / lifecycle → `callAdapter/`, `calls/connectedCalls.e2e.ts`
   - VA/AI scenarios → `ujetPortal/virtualAgent/`, `release/virtualAgent/`
   - API contract scenarios → `test/api/specs/release/calls/`
3. List any additional files found under their scenario in the enhanced doc

---

## Completion Condition

Stop working and output a summary when:
- Phase 3 doc is written, AND
- You have listed any symbols where callers could not be determined (flag for manual check), AND
- Phase 4 was either completed (if requested) or skipped

Do NOT proceed to Phase 4 unless explicitly asked.

<promise>ANALYSIS COMPLETE</promise>
