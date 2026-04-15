# UJET Regression Risk Analyzer

Analyzes GitHub PRs for regression risk by inspecting diffs, tracing callers of changed symbols, matching against BrowserStack test cases, and generating a structured risk map with recommended test scenarios.

Supports two modes: **PR mode** (single PR link) and **Filter mode** (batch from a Jira filter).

---

## How it works

```
Input: PR link or Jira filter URL
      │
      ├─► PR Mode ─────────────────────────────────────────────────────────┐
      │   Fetch PR from GitHub                                             │
      │   Reverse-lookup Jira ticket (from PR title/branch or text search) │
      │                                                                    │
      ├─► Filter Mode ─────────────────────────────────────────────────────┤
      │   Fetch CALL tickets from Jira filter                              │
      │   Extract PR links from each ticket                                │
      │                                                                    │
      ▼                                                                    ▼
  GitHub PR Analysis
      │
      ├─► DiffRiskAnalyzer     — detects signature changes, removed methods,
      │                          auth/DB/job/env risks from actual diff lines
      │
      └─► DiffSymbolExtractor  — finds modified/removed symbols,
                                  searches repo for callers outside the PR
      │
      ▼
  BrowserStack Matching  ──►  loads test cases from "Regression Suite" project,
                               keyword-scores them against all risk signals
      │
      ▼
  Risk Map Generator     ──►  matches risk signals against domain-specific
                               scenario rules, generates phased test plan
      │
      ▼
  Output (4 files)
      ├── pr-risk-mapping.csv
      ├── regression-risk-map.md
      ├── recommended-test-scenarios.csv
      └── browserstack-regression-scenarios.csv
```

---

## Prerequisites

- **Node.js** 14+ — `node --version`
- **1Password CLI** — `op --version` ([install guide](https://developer.1password.com/docs/cli/get-started))
- Access to the `QA` 1Password vault (BrowserStack credentials are stored there)

---

## Setup

```bash
# 1. Install dependencies (required after first clone, or after pulling changes)
npm install

# 2. Verify .env has the correct 1Password references (already configured for the team)
cat .env
```

The `.env` is pre-configured with 1Password references for all credentials. No manual token handling required.

> **Note:** `node_modules/` is not committed. Run `npm install` after every fresh clone or pull.

---

## Usage

### PR Mode (single PR)

```bash
op run --env-file=.env -- npm start -- "https://github.com/UJET/ujet-server/pull/28755"
```

Shorthand — just the PR number (defaults to `UJET/ujet-server`):

```bash
op run --env-file=.env -- npm start -- 28755
```

Or with explicit owner/repo:

```bash
op run --env-file=.env -- npm start -- "UJET/ujet-server/pull/28755"
```

The script auto-detects that the input is a PR link. It will:

1. Fetch and analyze the PR diff from GitHub
2. Try to find the linked Jira ticket by extracting ticket keys from the PR title and branch name (e.g. `AGD-3993` from `fix/AGD-3993-hold-music`), falling back to a Jira text search for the PR URL
3. Pull the Regression Area/Concern field from the Jira ticket if found
4. Match against BrowserStack test cases
5. Generate all output files

### Filter Mode (batch from Jira filter)

```bash
op run --env-file=.env -- npm start -- "https://ujetcs.atlassian.net/issues?filter=30069"
```

The filter ID is extracted automatically from the URL. If no URL is passed, the script enters `--risk-map-only` mode instead.

### Risk Map Only (regenerate from existing CSV)

```bash
op run --env-file=.env -- npm start -- --risk-map-only
```

Reads the last `pr-risk-mapping.csv` and regenerates the risk map + scenarios without re-hitting any APIs. Useful when you want to re-run the scenario generation after adding new rules.

---

## Output Files

All files are written to `regression-analysis-output/`. After a run, review them in this order:

### 1. `regression-risk-map.md` — Start here

This is your main document. Open it and read top to bottom:

- **Executive Summary** — a table showing how many tickets landed in each risk bucket (Critical / High / Medium / Low). If everything is green, a light regression pass may be enough. If there are reds, keep reading.
- **Per-Ticket Risk Breakdown** — for each ticket/PR:
  - What files changed and the line counts
  - **Direct Risks** — what the diff analysis found (signature changes, removed error handling, DB migrations, etc.)
  - **Indirect Risks** — files *outside* the PR that call modified/removed symbols. These are the silent breakage risks that won't show up in a basic code review.
  - **Risk Categories Triggered** — which domain-specific scenario rules matched (e.g. "Hold Music & Hold/Unhold Behavior", "Virtual Agent & AI Escalation Flows")
  - **Recommended Test Scenarios** — specific scenarios with priority and category
  - **Existing BrowserStack Test Cases** — which of your current tests already cover the risk. If this says "No matches found," that's a gap.
  - **Uncovered Risks** — risk signals that didn't match any scenario rule. These need manual review.
- **Consolidated Test Scenario List** — all scenarios deduplicated across tickets, sorted by priority, with source ticket references
- **Execution Priority Guide** — your testing phases:
  - **Phase 1: Smoke** (Critical only) — run first to catch show-stoppers
  - **Phase 2: Core Regression** (High) — run after smoke passes
  - **Phase 3: Extended Coverage** (Medium/Low) — run if time permits

### 2. `pr-risk-mapping.csv` — Raw data

Open in a spreadsheet. Sort by **Risk Score** descending. Focus on anything 50+.

| Column | Description |
|--------|-------------|
| Jira Ticket | CALL-XXXX key (or PR-XXXX if no Jira ticket found) |
| Status | Current Jira status or PR state |
| PR Link | GitHub PR URL |
| Risk Score | 0–100 composite score |
| Regression Area/Concern | Free-text field from Jira (`customfield_11041`) |
| Changed Files (Diffs) | Files modified with line counts |
| Direct Diff Risks | Risks found in the diff (signature changes, removed methods, etc.) |
| Indirect Risks | Files outside the PR that call modified symbols, with line references |
| Modified/Removed Symbols | Exact function/method names that changed |
| Affected Components | Area categories (Authentication, Background_Jobs, etc.) |
| Matched BrowserStack Test Cases | Top-matched test case titles |
| BS Test Case URLs | Direct links to those test cases |

### 3. `recommended-test-scenarios.csv` — Test tracker

A flat list of every recommended scenario. Use as a checklist — import into a spreadsheet and mark pass/fail as you execute. Filter by **Priority** column to focus on Critical first.

| Column | Description |
|--------|-------------|
| Source Ticket | Which ticket triggered this scenario |
| Risk Score | The ticket's risk score |
| Rule ID | Which scenario rule matched (e.g. `HOLD_MUSIC`, `VA_AI`) |
| Priority | Critical / High / Medium / Low |
| Category | Scenario category (Call State, Transfer, Recording, etc.) |
| Scenario Title | What to test |
| Steps | Step-by-step execution |
| Verification | What to verify after execution |

### 4. `browserstack-regression-scenarios.csv` — Upload to BrowserStack

This CSV is formatted for direct import into BrowserStack Test Management. It uses the multi-row format matching your existing Regression Suite test cases (metadata on the first row, continuation rows for additional steps).

To upload: BrowserStack > Project > Target folder > Import test cases > Select this CSV.

The target folder ID is pre-set to `33917692`. After uploading, the generated scenarios become real BrowserStack test cases you can assign and execute.

---

## Risk Score

| Score | Level | What it means |
|-------|-------|---------------|
| 70–100 | 🔴 Critical | High-severity diff risks + external callers impacted. Test immediately. |
| 50–69 | 🟠 High | Multiple medium-severity risks or significant code surface change. |
| 30–49 | 🟡 Medium | Some risks detected but limited blast radius. |
| 0–29 | 🟢 Low | Minimal risk signals. Standard regression may be sufficient. |

The score is computed from: severity-weighted direct risks (HIGH: 15, MEDIUM: 8, LOW: 3 points each), indirect risks (same weights), plus bonus for large diffs (+10 over 200 lines, +10 over 500 lines). Capped at 100.

---

## Scenario Rules

The risk map generator uses 11 domain-specific rule sets to map risk signals to test scenarios:

| Rule ID | Name | Triggers on |
|---------|------|-------------|
| `CALL_STATE` | Call State Machine & Progress Events | progress, state_machine, call_status, transition |
| `AGENT_JOIN` | Agent Joining & Conference Logic | join, conference, participant, add_agent |
| `HOLD_MUSIC` | Hold Music & Hold/Unhold Behavior | hold, unhold, moh, pause, resume |
| `RECORDING` | Call Recording & Post-Processing | recording, post_process, segment, dual_channel |
| `VA_AI` | Virtual Agent & AI Escalation Flows | virtual_agent, escalat, progress_service, ccai |
| `METHOD_CHANGE` | Method Signature & API Contract Changes | signature changed, was removed, callers break |
| `ERROR_HANDLING` | Error Handling & Exception Flow | error handling removed, exception propagat |
| `BACKGROUND_JOBS` | Background Workers & Async Processing | worker, sidekiq, job, perform |
| `DATABASE` | Database & Schema Changes | migration, schema, column, table |
| `VOIP_PROVIDER` | VoIP Provider-Specific Behavior | twilio, telnyx, nexmo, provider |
| `CRM` | CRM Integration & Metadata | crm, zendesk, salesforce, kustomer |
| `API_ROUTES` | API Endpoint & Route Changes | route changed, endpoint, API contract |

Rules match against changed symbols, risk descriptions, file paths, affected areas, and the Jira Regression Area/Concern field. When a rule matches, all of its scenarios are included in the output.

To add a new rule: find the `RISK_SCENARIO_RULES` array in `jira-pr-regression-analyzer.js` and add a new entry following the existing pattern.

---

## Configuration

All tunable values are at the top of `jira-pr-regression-analyzer.js` in `CONFIG`:

| Key | Default | What it controls |
|-----|---------|-----------------|
| `jira.filterId` | `30069` | Fallback filter when no URL is passed |
| `browserstack.projectIdentifier` | `PR-25` | BrowserStack project ("Regression Suite") |
| `browserstack.folderId` | `30446438` | Source folder for test case matching |
| `browserstack.targetFolderId` | `33917692` | Target folder ID for generated BrowserStack CSV |
| `browserstack.fetchLimit` | `2000` | Max test cases loaded into memory |

---

## Repo structure

```
├── jira-pr-regression-analyzer.js   # Main script (analysis + risk map + scenarios)
├── package.json
├── .env                             # 1Password-backed credentials (not committed)
├── .gitignore
├── README.md
└── regression-analysis-output/      # Generated after first run
    ├── pr-risk-mapping.csv
    ├── regression-risk-map.md
    ├── recommended-test-scenarios.csv
    └── browserstack-regression-scenarios.csv
```
