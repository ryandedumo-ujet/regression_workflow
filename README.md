# CALL Regression Analyzer

Pulls CALL tickets from a Jira filter, analyzes their linked GitHub PRs for regression risk, and maps the risks to BrowserStack test cases — outputting a single CSV ready for review.

---

## How it works

```
Jira filter URL
      │
      ▼
  CALL tickets  ──►  Regression Area/Concern field (customfield_11041)
      │
      ▼
  GitHub PRs  ──►  fetch changed files + base file content from target branch
                   │
                   ├─► DiffRiskAnalyzer    — detects signature changes, removed methods,
                   │                         auth/DB/job/env risks from actual diff lines
                   │
                   └─► DiffSymbolExtractor — finds modified/removed symbols,
                                             searches repo for callers outside the PR
      │
      ▼
  BrowserStack  ──►  loads test cases from "Regression Suite" project,
                     keyword-scores them against all risk signals
      │
      ▼
  regression-analysis-output/pr-risk-mapping.csv
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

```bash
op run --env-file=.env -- npm start -- "<JIRA_FILTER_URL>"
```

**Example:**
```bash
op run --env-file=.env -- npm start -- "https://ujetcs.atlassian.net/issues?filter=30069"
```

The filter ID is extracted automatically from the URL. If no URL is passed, the default filter (`30069`) is used.

---

## Output

Results are written to `regression-analysis-output/pr-risk-mapping.csv`.

| Column | Description |
|--------|-------------|
| Jira Ticket | CALL-XXXX key |
| Status | Current Jira status |
| PR Link | Linked GitHub PR |
| Risk Score | 0–100 composite score |
| Regression Area/Concern | Free-text field from the Jira ticket (`customfield_11041`) |
| Changed Files (Diffs) | Files modified in the PR with line counts |
| Direct Diff Risks | Specific risks found in the diff (signature changes, removed methods, auth/DB/job patterns) |
| Indirect Risks | Files outside the PR that call modified/removed symbols, with line references |
| Modified/Removed Symbols | Exact function/method names that changed |
| Affected Components | Broad area categories (Authentication, Background_Jobs, etc.) |
| Matched BrowserStack Test Cases | Top-matched test case titles from the Regression Suite |
| BS Test Case URLs | Direct links to those test cases |

**Priority levels:**

| Score | Priority |
|-------|----------|
| 70–100 | 🔴 Critical |
| 50–69 | 🟠 High |
| 30–49 | 🟡 Medium |
| 0–29 | 🟢 Low |

---

## Configuration

All tunable values are at the top of `jira-pr-regression-analyzer.js` in `CONFIG`:

| Key | Default | What it controls |
|-----|---------|-----------------|
| `jira.filterId` | `30069` | Fallback filter when no URL is passed |
| `browserstack.projectIdentifier` | `PR-25` | BrowserStack project ("Regression Suite") |
| `browserstack.folderId` | `30446438` | Folder to load test cases from |
| `browserstack.fetchLimit` | `2000` | Max test cases loaded into memory |

To search across **all** test cases in the project instead of a specific folder, remove the `folder_id` param in `BrowserStackClient.getAllTestCases()`.

---

## Repo structure

```
├── jira-pr-regression-analyzer.js   # Main script
├── package.json
├── .env                             # 1Password-backed credentials (not committed)
├── .gitignore
└── README.md
```
