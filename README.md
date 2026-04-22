# UJET Regression Risk Analyzer

Analyzes GitHub PRs for regression risk by inspecting diffs, tracing callers of changed symbols, matching against BrowserStack test cases, and generating a structured risk map with recommended test scenarios.

Supports two modes: **PR mode** (single PR link) and **Filter mode** (batch from a Jira filter).

---

## Claude Code Command

The fastest way to run this — no need to remember the `op run` syntax:

```
/run-regression https://ujetcs.atlassian.net/issues?filter=XXXXX
```

```
/run-regression https://github.com/UJET/ujet-server/pull/XXXXX
```

This invokes `regression-agent.md` automatically and runs through all phases (script run → Phase 2 reasoning → enhanced HTML output). See `regression-agent.md` for the full phase breakdown.

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
      ├─► DiffRiskAnalyzer       — detects signature changes, removed methods,
      │                            auth/DB/job/env risks from actual diff lines
      │
      ├─► DiffSymbolExtractor    — finds modified/removed symbols,
      │                            searches repo for callers outside the PR
      │
      └─► FILENAME_EXPANSION_MAP — force-injects scenario rules based on
                                   filename patterns (e.g. cold_transfer_*.rb
                                   → AGENT_JOIN, deflect*.rb → VA_DEFLECTION)
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
  Output → regression-analysis-output/raw/
      ├── pr-risk-mapping.csv
      ├── regression-risk-map.md
      ├── regression-risk-map.html
      ├── recommended-test-scenarios.csv
      └── browserstack-regression-scenarios.csv
```

After the script run, the Claude agent performs a **Phase 2 reasoning pass** — validating scenarios, removing false positives, flagging skipped tickets with production impact, and producing:

```
  regression-analysis-output/
      ├── regression-risk-map-enhanced.html   ← final deliverable
      ├── regression-risk-map-enhanced.md     ← reasoning document
      └── raw/                                ← raw script output (above)
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

Reads the last `pr-risk-mapping.csv` from `raw/` and regenerates the risk map + scenarios without re-hitting any APIs. Useful when adding new rules.

---

## Output Files

All script-generated files are written to `regression-analysis-output/raw/`. The Phase 2 enhanced output sits one level up.

### Final output (review these)

| File | Description |
|------|-------------|
| `regression-risk-map-enhanced.html` | Interactive report — tabs for Final Test Plan, Ticket Analysis, Skipped Tickets, Removed False Positives, Systemic Issues |
| `regression-risk-map-enhanced.md` | Phase 2 reasoning document — per-ticket verdicts, false positive explanations, manual check notes |

### Raw script output (`raw/`)

| File | Description |
|------|-------------|
| `regression-risk-map.md` | Full risk map with per-ticket breakdown, scenarios, BrowserStack matches |
| `regression-risk-map.html` | Auto-generated interactive version of the risk map |
| `pr-risk-mapping.csv` | Raw data — one row per ticket, risk score, diff risks, indirect callers |
| `recommended-test-scenarios.csv` | Flat checklist of all scenarios — import to spreadsheet, mark pass/fail |
| `browserstack-regression-scenarios.csv` | Formatted for direct import into BrowserStack Test Management |

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

The risk map generator uses 13 domain-specific rule sets to map risk signals to test scenarios:

| Rule ID | Name | Triggers on |
|---------|------|-------------|
| `CALL_STATE` | Call State Machine & Progress Events | progress, state_machine, call_status, transition |
| `AGENT_JOIN` | Agent Joining & Conference Logic | join, conference, participant, add_agent, cold_transfer |
| `HOLD_MUSIC` | Hold Music & Hold/Unhold Behavior | hold, unhold, moh, pause, resume |
| `RECORDING` | Call Recording & Post-Processing | recording, post_process, segment, dual_channel |
| `VA_AI` | Virtual Agent & AI Escalation Flows | virtual_agent, escalat, progress_service, ccai |
| `VA_DEFLECTION` | Virtual Agent OC/After-Hours Deflection | deflect, after_hours, overcap, overcapacity |
| `METHOD_CHANGE` | Method Signature & API Contract Changes | signature changed, was removed, callers break |
| `ERROR_HANDLING` | Error Handling & Exception Flow | error handling removed, exception propagat |
| `BACKGROUND_JOBS` | Background Workers & Async Processing | worker, sidekiq, job, perform |
| `DATABASE` | Database & Schema Changes | migration, schema, column, table |
| `VOIP_PROVIDER` | VoIP Provider-Specific Behavior | twilio, telnyx, nexmo, provider |
| `CRM` | CRM Integration & Metadata | crm, zendesk, salesforce, kustomer |
| `API_ROUTES` | API Endpoint & Route Changes | route changed, endpoint, API contract |

### Filename Expansion

In addition to signal matching, the analyzer force-injects rules based on filename patterns in the PR diff — bypassing the normal signal threshold:

| Filename pattern | Rule injected |
|-----------------|---------------|
| `cold_transfer*.rb` | `AGENT_JOIN` |
| `transfer_service/handler/manager` | `AGENT_JOIN` |
| `deflect*.rb` | `VA_DEFLECTION` |
| `after_hours*.rb` | `VA_DEFLECTION` (after-hours hint) |
| `overcap*.rb` | `VA_DEFLECTION` (overcapacity hint) |
| `save_recording/recording_worker` | `RECORDING` |

To add a new rule: find `RISK_SCENARIO_RULES` in `jira-pr-regression-analyzer.js`. To add a filename trigger: find `FILENAME_EXPANSION_MAP`.

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
| `outputDir` | `./regression-analysis-output/raw` | Where script output files are written |

---

## Repo structure

```
├── jira-pr-regression-analyzer.js        # Main script (analysis + risk map + HTML)
├── regression-agent.md                   # Claude skill — phases for /run-regression
├── package.json
├── .env                                  # 1Password-backed credentials (not committed)
├── .gitignore
├── README.md
└── regression-analysis-output/
    ├── regression-risk-map-enhanced.html  # Final interactive report
    ├── regression-risk-map-enhanced.md   # Phase 2 reasoning document
    └── raw/                              # Raw script output (generated on each run)
        ├── pr-risk-mapping.csv
        ├── regression-risk-map.md
        ├── regression-risk-map.html
        ├── recommended-test-scenarios.csv
        └── browserstack-regression-scenarios.csv
```
