/**
 * UJET Regression Risk Analyzer v3.0
 *
 * Analyzes PRs for regression risks, maps to BrowserStack test cases,
 * and generates a structured risk map with recommended test scenarios.
 *
 * Usage:
 *   PR mode:          op run --env-file=.env -- npm start -- "https://github.com/UJET/ujet-server/pull/28755"
 *   Filter mode:      op run --env-file=.env -- npm start -- "https://ujetcs.atlassian.net/issues?filter=30069"
 *   Risk-map-only:    op run --env-file=.env -- npm start -- --risk-map-only
 */

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const CONFIG = {
  jira: {
    baseUrl: 'https://ujetcs.atlassian.net',
    email: process.env.JIRA_EMAIL,
    apiToken: process.env.JIRA_API_TOKEN,
    filterId: '30069',
  },
  github: {
    token: process.env.GITHUB_TOKEN,
    baseUrl: 'https://api.github.com',
  },
  browserstack: {
    username: process.env.BROWSERSTACK_USERNAME,
    accessKey: process.env.BROWSERSTACK_ACCESS_KEY,
    baseUrl: 'https://test-management.browserstack.com/api/v2',
    projectIdentifier: 'PR-25',
    projectId: '2986649',
    folderId: '30446438',
    targetFolderId: '33917692',
    folderPath: 'Release Testing-2025>UJET Core Release Testing-2025',
    fetchLimit: 2000,
  },
  e2eRepo: {
    path: '/Users/paul/Documents/ujet/repo/ujet-qa-e2e',
    testDir: 'test/specs/regression',
  },
  outputDir: './regression-analysis-output/raw',
};

// ============================================================================
// TERMINAL OUTPUT — clean, aligned, section-based
// ============================================================================

const UI = {
  DIVIDER:      '────────────────────────────────────────────────────────────────',
  DIVIDER_BOLD: '════════════════════════════════════════════════════════════════',
  INDENT:       '    ',

  header(title) {
    console.log('');
    console.log(this.DIVIDER_BOLD);
    console.log(`  ${title}`);
    console.log(this.DIVIDER_BOLD);
  },

  section(title) {
    console.log('');
    console.log(`  ${title}`);
    console.log(`  ${this.DIVIDER}`);
  },

  kv(key, value, indent = 1) {
    const pad = this.INDENT.repeat(indent);
    const keyStr = `${key}:`.padEnd(28);
    console.log(`${pad}${keyStr}${value}`);
  },

  bullet(text, indent = 1) {
    const pad = this.INDENT.repeat(indent);
    console.log(`${pad}  ▸ ${text}`);
  },

  item(text, indent = 1) {
    const pad = this.INDENT.repeat(indent);
    console.log(`${pad}${text}`);
  },

  warn(text) {
    console.log(`    ⚠  ${text}`);
  },

  ok(text) {
    console.log(`    ✓  ${text}`);
  },

  fail(text) {
    console.log(`    ✗  ${text}`);
  },

  blank() {
    console.log('');
  },

  table(headers, rows, colWidths) {
    // Simple aligned table
    const formatRow = (cells) => {
      return '    ' + cells.map((c, i) => String(c).padEnd(colWidths[i] || 20)).join('  ');
    };
    console.log(formatRow(headers));
    console.log('    ' + colWidths.map(w => '─'.repeat(w)).join('──'));
    for (const row of rows) {
      console.log(formatRow(row));
    }
  },

  riskIcon(score) {
    if (score >= 70) return '●';
    if (score >= 50) return '◉';
    if (score >= 30) return '○';
    return '·';
  },

  riskLabel(score) {
    if (score >= 70) return 'CRITICAL';
    if (score >= 50) return 'HIGH';
    if (score >= 30) return 'MEDIUM';
    return 'LOW';
  },

  progressBar(current, total, width = 30) {
    const pct = Math.round((current / total) * 100);
    const filled = Math.round((current / total) * width);
    const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
    return `${bar}  ${pct}%`;
  },
};


// ============================================================================
// UTILITIES
// ============================================================================

function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text || '';
  if (Array.isArray(node.content)) {
    return node.content.map(adfToText).join(' ').replace(/\s+/g, ' ').trim();
  }
  return '';
}

function isEmptyValue(text) {
  return /^\s*(-+|n\/a|none|null|not applicable|tbd|na)\s*$/i.test(text.trim());
}

// Combine all free-text fields from a Jira issue into one string for analysis
function extractIssueAllText(issue) {
  const parts = [];
  if (issue.fields?.regressionConcern) parts.push(issue.fields.regressionConcern);
  if (issue.fields?.description) {
    try { parts.push(adfToText(JSON.parse(issue.fields.description))); }
    catch { parts.push(String(issue.fields.description)); }
  }
  for (const c of (issue.fields?.comment?.comments || [])) {
    if (c.body) parts.push(adfToText(c.body));
  }
  return parts.filter(Boolean).join(' ');
}

// Extract all Jira issue keys (e.g. AGD-3993, CALL-123) mentioned in text
function extractMentionedIssueKeys(text, ownKey = null) {
  if (!text) return [];
  const matches = text.match(/\b([A-Z]{2,}-\d+)\b/g) || [];
  const unique = [...new Set(matches)];
  return ownKey ? unique.filter(k => k !== ownKey) : unique;
}

// Detect natural-language patterns indicating this ticket was caused by another ticket
const CAUSATION_PATTERNS = [
  /\b([A-Z]{2,}-\d+)\s+(?:caused|introduced|triggered|broke)\b/i,
  /\bappears?\s+(?:that\s+)?([A-Z]{2,}-\d+)\b/i,
  /\bregression\s+(?:from|caused\s*by|introduced\s*by|in)\s+([A-Z]{2,}-\d+)\b/i,
  /\bcaused\s*by\s+([A-Z]{2,}-\d+)\b/i,
  /\bintroduced\s+(?:by|in)\s+([A-Z]{2,}-\d+)\b/i,
  /\bbroke\s+(?:after|in|with|by)\s+([A-Z]{2,}-\d+)\b/i,
  /\b([A-Z]{2,}-\d+)\s+broke\b/i,
];

function detectRegressionCausation(text) {
  if (!text) return null;
  for (const pattern of CAUSATION_PATTERNS) {
    const m = text.match(pattern);
    if (m) {
      const key = m.slice(1).find(g => g && /^[A-Z]{2,}-\d+$/.test(g));
      return { causingKey: key || null, matchedText: m[0].trim() };
    }
  }
  return null;
}

function parseInput(arg) {
  if (!arg || arg === '--risk-map-only') {
    return { type: 'risk-map-only', value: null };
  }
  if (arg.includes('github.com') && arg.includes('/pull/')) {
    return { type: 'pr', value: arg };
  }
  if (arg.includes('filter=')) {
    const match = arg.match(/filter=(\d+)/);
    return { type: 'filter', value: match ? match[1] : CONFIG.jira.filterId };
  }
  if (/^[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(arg)) {
    return { type: 'pr', value: `https://github.com/${arg}` };
  }
  if (/^\d+$/.test(arg)) {
    return { type: 'pr', value: `https://github.com/UJET/ujet-server/pull/${arg}` };
  }
  return { type: 'filter', value: arg };
}


// ============================================================================
// JIRA CLIENT
// ============================================================================

class JiraClient {
  constructor(baseUrl, email, apiToken) {
    this.baseUrl = baseUrl;
    this.auth = Buffer.from(`${email}:${apiToken}`).toString('base64');
  }

  async getIssuesByFilter(filterId) {
    try {
      const filterResponse = await axios.get(
        `${this.baseUrl}/rest/api/3/filter/${filterId}`,
        { headers: this.getHeaders() }
      );
      const baseJql = filterResponse.data.jql.split(/ORDER\s+BY/i)[0].trim();
      const jql = `(${baseJql}) AND project = "CALL"`;

      const response = await axios.get(
        `${this.baseUrl}/rest/api/3/search/jql`,
        {
          params: { jql, maxResults: 100, fields: '*all,comment,customfield_11041' },
          headers: this.getHeaders(),
        }
      );

      if (!response.data?.issues) return [];

      const issues = response.data.issues.map(issue => JiraClient._transformIssue(issue, { includeParent: true }));

      UI.ok(`${issues.length} CALL ticket(s) extracted from filter`);
      return issues;
    } catch (error) {
      UI.fail(`Jira fetch failed: ${error.response?.status || error.message}`);
      throw error;
    }
  }

  async findTicketsByPR(prUrl) {
    try {
      const jql = `text ~ "${prUrl}" ORDER BY updated DESC`;
      const response = await axios.get(
        `${this.baseUrl}/rest/api/3/search/jql`,
        {
          params: { jql, maxResults: 10, fields: 'summary,status,issuetype,customfield_11041,description,comment' },
          headers: this.getHeaders(),
        }
      );

      const issues = (response.data?.issues || []).map(issue => JiraClient._transformIssue(issue));

      return issues;
    } catch (_) {
      return [];
    }
  }

  async getIssue(issueKey) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/rest/api/3/issue/${issueKey}`,
        {
          params: { fields: 'summary,status,issuetype,customfield_11041,description,comment,parent' },
          headers: this.getHeaders(),
        }
      );
      return JiraClient._transformIssue(response.data, { includeParent: true });
    } catch (_) { return null; }
  }

  async getExternalPRLink(issueKey, issueId) {
    try {
      const remoteLinks = await axios.get(`${this.baseUrl}/rest/api/3/issue/${issueKey}/remotelink`, { headers: this.getHeaders() });
      for (const link of remoteLinks.data) {
        const url = link.object?.url || '';
        if (url.includes('github.com') && url.includes('/pull/')) return url;
      }
    } catch (_) {}
    try {
      const devStatus = await axios.get(`${this.baseUrl}/rest/dev-status/1.0/issue/detail`, {
        params: { issueId, applicationType: 'github', dataType: 'pullrequest' },
        headers: this.getHeaders(),
      });
      for (const detail of devStatus.data?.detail || []) {
        for (const pr of detail.pullRequests || []) {
          if (pr.url?.includes('github.com')) return pr.url;
        }
      }
    } catch (_) {}
    return null;
  }

  getHeaders() {
    return { 'Authorization': `Basic ${this.auth}`, 'Accept': 'application/json' };
  }

  static _transformIssue(issue, { includeParent = false } = {}) {
    const fields = {
      summary: issue.fields?.summary || 'N/A',
      description: typeof issue.fields?.description === 'object'
        ? JSON.stringify(issue.fields.description)
        : (issue.fields?.description || ''),
      status: { name: issue.fields?.status?.name || 'Unknown' },
      issuetype: { name: issue.fields?.issuetype?.name || 'Unknown' },
      regressionConcern: adfToText(issue.fields?.customfield_11041),
      comment: issue.fields?.comment,
    };
    if (includeParent && issue.fields?.parent) {
      fields.parent = {
        key: issue.fields.parent.key,
        summary: issue.fields.parent.fields?.summary || '',
        issuetype: issue.fields.parent.fields?.issuetype?.name || 'Unknown',
      };
    }
    return { key: issue.key, id: issue.id, fields };
  }
}


// ============================================================================
// BROWSERSTACK CLIENT
// ============================================================================

class BrowserStackClient {
  constructor(username, accessKey, projectIdentifier, folderId) {
    this.auth = Buffer.from(`${username}:${accessKey}`).toString('base64');
    this.baseUrl = CONFIG.browserstack.baseUrl;
    this.projectIdentifier = projectIdentifier;
    this.folderId = folderId;
    this._cache = null;
  }

  // Root folders to recursively index: Call, CRM/Storage, Dashboard/Report, Agent Experience
  static TARGET_FOLDER_IDS = new Set([30446439, 30447276, 30447188, 30447918]);

  async _collectTargetFolderIds() {
    // Fetch ALL project folders in one paginated pass, build parent→children map,
    // then BFS from each target root. Much faster than per-folder API calls.
    const headers = { 'Authorization': `Basic ${this.auth}`, 'Accept': 'application/json' };
    const allFolders = [];
    let page = 1;
    while (true) {
      try {
        const r = await axios.get(`${this.baseUrl}/projects/${this.projectIdentifier}/folders`,
          { headers, params: { per_page: 100, p: page } });
        const batch = r.data.folders || r.data || [];
        allFolders.push(...batch);
        if (!r.data.info?.next || batch.length < 100) break;
        page++;
      } catch { break; }
    }

    // Build parent_id → [child ids] map
    const children = new Map();
    for (const f of allFolders) {
      if (!children.has(f.parent_id)) children.set(f.parent_id, []);
      children.get(f.parent_id).push(f.id);
    }

    // BFS from each target root
    const result = new Set();
    const queue = [...BrowserStackClient.TARGET_FOLDER_IDS];
    while (queue.length) {
      const id = queue.shift();
      if (result.has(id)) continue;
      result.add(id);
      for (const child of (children.get(id) || [])) queue.push(child);
    }
    return [...result];
  }

  async _fetchTCsFromFolder(folderId, allCases) {
    const perPage = 100;
    let page = 1;
    while (allCases.length < CONFIG.browserstack.fetchLimit) {
      try {
        const response = await axios.get(
          `${this.baseUrl}/projects/${this.projectIdentifier}/test-cases`,
          {
            headers: { 'Authorization': `Basic ${this.auth}`, 'Accept': 'application/json' },
            params: { folder_id: folderId, per_page: perPage, p: page, minify: true },
          }
        );
        const cases = response.data.test_cases || [];
        allCases.push(...cases);
        const info = response.data.info || {};
        if (!info.next || cases.length < perPage) break;
        page++;
      } catch { break; }
    }
  }

  async getAllTestCases() {
    if (this._cache) return this._cache;
    const allCases = [];

    UI.ok('Collecting BrowserStack folders (Call, CRM/Storage, Dashboard/Report, Agent Experience)...');
    const folderIds = await this._collectTargetFolderIds();
    UI.ok(`${folderIds.length} folders found — fetching test cases...`);
    for (const fid of folderIds) {
      await this._fetchTCsFromFolder(fid, allCases);
      if (allCases.length >= CONFIG.browserstack.fetchLimit) break;
    }

    // Deduplicate by identifier
    const seen = new Set();
    const deduped = allCases.filter(tc => {
      if (seen.has(tc.identifier)) return false;
      seen.add(tc.identifier);
      return true;
    });

    UI.ok(`${deduped.length} BrowserStack test case(s) loaded (recursive, ${BrowserStackClient.TARGET_FOLDER_IDS.length} root folders)`);
    this._cache = deduped;
    return deduped;
  }

  search(testCases, keywords, topN = 5) {
    if (!keywords.length || !testCases.length) return [];
    const terms = [...new Set(
      keywords.flatMap(k => [k.toLowerCase(), ...k.toLowerCase().split(/[\s/,_-]+/)])
        .filter(t => t.length >= 3 && !STOP_WORDS.has(t))
    )];
    const scored = testCases.map(tc => {
      const title = (tc.title || '').toLowerCase();
      const tags = (tc.tags || []).map(t => t.toLowerCase());
      const desc = (tc.description || '').replace(/<[^>]+>/g, '').toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (title.includes(term)) score += 3;
        if (tags.some(t => t.includes(term))) score += 4;
        if (desc.includes(term)) score += 1;
      }
      for (const keyword of keywords) {
        const phrase = keyword.toLowerCase();
        if (phrase.includes(' ') && title.includes(phrase)) score += 10;
      }
      return { tc, score };
    });
    return scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, topN)
      .map(s => ({
        identifier: s.tc.identifier, title: s.tc.title,
        tags: s.tc.tags || [], score: s.score,
        url: BrowserStackClient.tcUrl(s.tc.identifier),
      }));
  }

  static tcUrl(identifier) {
    return `https://test-management.browserstack.com/projects/${CONFIG.browserstack.projectId}/test-cases/${identifier}`;
  }
}

const STOP_WORDS = new Set([
  'the','and','for','are','was','not','but','with','that','this','from',
  'they','have','had','all','been','when','will','also','its','can','may',
  'test','case','verify','check','ensure','should','must','given','then',
  'new','add','added','updated','removed','changed','fix','fixed',
]);

const PRIORITY_ORDER = { Critical: 0, High: 1, Medium: 2, Low: 3 };


// ============================================================================
// E2E REPO CLIENT
// ============================================================================

class E2ERepoClient {
  constructor(repoPath) {
    this.repoPath = repoPath;
    this._index = null;
  }

  buildIndex() {
    if (this._index) return this._index;
    if (!fs.existsSync(this.repoPath)) {
      UI.warn(`E2E repo not found at ${this.repoPath} — skipping`);
      return (this._index = []);
    }
    const files = this._findTestFiles(path.join(this.repoPath, CONFIG.e2eRepo.testDir));
    this._index = files.map(absPath => {
      const relativePath = absPath.replace(this.repoPath + '/', '');
      let describes = [], its = [];
      try {
        const content = fs.readFileSync(absPath, 'utf-8');
        describes = [...content.matchAll(/^\s*describe(?:\.skip|\.only)?\s*\(\s*['"`]([^'"`\n]+)['"`]/gm)].map(m => m[1]);
        its = [...content.matchAll(/^\s*it(?:\.skip|\.only)?\s*\(\s*['"`]([^'"`\n]+)['"`]/gm)].map(m => m[1]);
      } catch (_) {}
      return { relativePath, describes, its };
    });
    UI.ok(`${this._index.length} E2E test file(s) indexed`);
    return this._index;
  }

  search(keywords, topN = 5, channels = null) {
    const index = this.buildIndex();
    if (!keywords.length || !index.length) return [];

    const terms = [...new Set(
      keywords.flatMap(k => [
        k.toLowerCase(),
        ...k.toLowerCase().split(/[\s/,_-]+/),
        ...k.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/\s+/),
      ]).filter(t => t.length >= 3 && !STOP_WORDS.has(t))
    )];

    const scored = index.map(entry => {
      const pathTokens = entry.relativePath
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .split(/[/._-]+/)
        .filter(t => t.length >= 3);
      const descText = entry.describes.join(' ').toLowerCase();
      const itText = entry.its.join(' ').toLowerCase();

      let score = 0;
      for (const term of terms) {
        if (pathTokens.some(pt => pt.includes(term))) score += 4;
        if (descText.includes(term)) score += 2;
        if (itText.includes(term)) score += 2;
      }
      // bonus: exact phrase match flattened into path
      for (const kw of keywords) {
        const phrase = kw.toLowerCase().replace(/\s+/g, '');
        const flatPath = entry.relativePath.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (flatPath.includes(phrase)) score += 6;
      }
      // channel boost: if detected channels specified, boost files that match
      if (channels && channels.length > 0) {
        const fileChannel = this._detectChannel(entry.relativePath);
        if (channels.includes(fileChannel)) score += 5;
      }
      return { entry, score };
    });

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topN)
      .map(s => ({
        relativePath: s.entry.relativePath,
        describe: s.entry.describes[0] || '',
        its: s.entry.its.slice(0, 3),
        score: s.score,
        channel: this._detectChannel(s.entry.relativePath),
        runCommand: `npx wdio run wdio.conf.ts --spec ${s.entry.relativePath}`,
      }));
  }

  _detectChannel(relativePath) {
    const p = relativePath.toLowerCase();
    if (/\/mobile\/|mobilecall|mobile[_-]call|\bios\b|\bandroid\b/.test(p)) return 'Mobile';
    if (/\/web\/|webcall|web[_-]call|websdk/.test(p)) return 'WebCall';
    if (/ivrcall|ivr[_-]call|\/ivr\/|twilio|telnyx|nexmo|deltacast|multicast/.test(p)) return 'IVR';
    return 'IVR'; // ui/ folder default = IVR
  }

  _findTestFiles(dir) {
    const results = [];
    const walk = (current) => {
      let entries;
      try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_) { return; }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          walk(full);
        } else if (entry.isFile() && entry.name.endsWith('.e2e.ts')) {
          results.push(full);
        }
      }
    };
    walk(dir);
    return results;
  }
}


// ============================================================================
// KEYWORD EXTRACTOR
// ============================================================================

class KeywordExtractor {
  static extract(regressionConcern, affectedAreas, directRisks, indirectRisks) {
    const keywords = new Set();
    if (regressionConcern && !isEmptyValue(regressionConcern)) {
      keywords.add(regressionConcern.trim());
      regressionConcern.split(/[\s/,;]+/).map(w => w.trim())
        .filter(w => w.length >= 3 && !STOP_WORDS.has(w.toLowerCase())).forEach(w => keywords.add(w));
    }
    const areaTerms = {
      Authentication: ['login','auth','token','session','permission','SSO'],
      Payment_Billing: ['payment','billing','invoice','subscription','transaction'],
      Database_Models: ['data','query','record','migration','schema'],
      API_Routing: ['API','endpoint','route','request','response'],
      UI_Components: ['UI','layout','component','display','render'],
      Background_Jobs: ['worker','job','queue','async','background'],
      Core_Config: ['config','environment','settings','setup'],
    };
    for (const area of (affectedAreas || [])) {
      (areaTerms[area] || [area.replace(/_/g, ' ')]).forEach(t => keywords.add(t));
    }
    const allRiskText = [...(directRisks || []), ...(indirectRisks || [])].join(' ');
    allRiskText.replace(/\[.*?\]/g, '').split(/\s+/).map(w => w.replace(/[^\w]/g, ''))
      .filter(w => w.length >= 5 && !STOP_WORDS.has(w.toLowerCase())).forEach(w => keywords.add(w));
    return Array.from(keywords).slice(0, 20);
  }
}


// ============================================================================
// DIFF SYMBOL EXTRACTOR
// ============================================================================

class DiffSymbolExtractor {
  static extract(filename, patch) {
    if (!patch) return { changed: [], added: [], removed: [] };
    const ext = path.extname(filename).toLowerCase();
    const patterns = this._patternsForExt(ext);
    if (!patterns.length) return { changed: [], added: [], removed: [] };
    const addedLines = patch.split('\n').filter(l => l.startsWith('+')).map(l => l.slice(1));
    const removedLines = patch.split('\n').filter(l => l.startsWith('-')).map(l => l.slice(1));
    const addedSymbols = this._extractSymbols(addedLines, patterns);
    const removedSymbols = this._extractSymbols(removedLines, patterns);
    return {
      changed: addedSymbols.filter(s => removedSymbols.includes(s)),
      added: addedSymbols.filter(s => !removedSymbols.includes(s)),
      removed: removedSymbols.filter(s => !addedSymbols.includes(s)),
    };
  }
  static _extractSymbols(lines, patterns) {
    const symbols = new Set();
    for (const line of lines) { for (const pattern of patterns) { const match = line.match(pattern); if (match) symbols.add(match[1]); } }
    return Array.from(symbols);
  }
  static _patternsForExt(ext) {
    const map = {
      '.rb': [/^\s*def\s+(self\.\w+|\w+)/, /^\s*class\s+(\w+)/, /^\s*module\s+(\w+)/, /^\s*scope\s+:(\w+)/, /^\s*has_many\s+:(\w+)/, /^\s*belongs_to\s+:(\w+)/],
      '.js': [/^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/, /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/, /^\s*(?:export\s+)?class\s+(\w+)/, /^\s*(\w+)\s*\([^)]*\)\s*\{/],
      '.ts': [/^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/, /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/, /^\s*(?:export\s+)?class\s+(\w+)/, /^\s*(?:export\s+)?interface\s+(\w+)/, /^\s*(?:public|private|protected|static|async)*\s*(\w+)\s*\([^)]*\)\s*(?::\s*\w+\s*)?\{/],
      '.py': [/^\s*(?:async\s+)?def\s+(\w+)/, /^\s*class\s+(\w+)/],
      '.java': [/^\s*(?:public|private|protected|static|final|abstract|\s)*\s+\w+\s+(\w+)\s*\(/, /^\s*(?:public|private|protected)?\s*(?:abstract\s+)?class\s+(\w+)/],
    };
    return map[ext] || [];
  }
}


// ============================================================================
// DIFF RISK ANALYZER
// ============================================================================

class DiffRiskAnalyzer {
  static analyze(filename, patch, baseContent) {
    if (!patch) return [];
    const risks = [];
    const addedLines = patch.split('\n').filter(l => l.startsWith('+')).map(l => l.slice(1));
    const removedLines = patch.split('\n').filter(l => l.startsWith('-')).map(l => l.slice(1));
    const addedText = addedLines.join('\n');
    const removedText = removedLines.join('\n');

    const sigsRemoved = this._extractSignatures(removedLines);
    const sigsAdded = this._extractSignatures(addedLines);
    for (const [name, oldSig] of sigsRemoved) {
      const newSig = sigsAdded.get(name);
      if (newSig && oldSig !== newSig) risks.push({ severity: 'high', description: `\`${name}\` signature changed: (${oldSig}) → (${newSig}) — existing callers may break` });
      else if (!newSig) risks.push({ severity: 'high', description: `\`${name}\` was removed — all callers will break` });
    }
    const oldRets = (removedText.match(/\breturn\b/g) || []).length;
    const newRets = (addedText.match(/\breturn\b/g) || []).length;
    if (Math.abs(oldRets - newRets) > 1) risks.push({ severity: 'medium', description: `Return statement count changed (${oldRets} → ${newRets})` });
    if (/rescue|\.catch\(|try\s*\{/.test(removedText) && !/rescue|\.catch\(|try\s*\{/.test(addedText)) risks.push({ severity: 'high', description: 'Error handling removed — exceptions will propagate uncaught' });
    if (/\.where\(|\.find_by|\.update\(|\.destroy|\.delete|ActiveRecord|\.save/.test(addedText)) risks.push({ severity: 'medium', description: 'Database query modified — verify no N+1 and data integrity' });
    if (/add_column|remove_column|rename_column|drop_table|create_table|change_column/.test(addedText)) risks.push({ severity: 'high', description: 'Schema migration detected — ensure backwards-compatible' });
    if (/before_action|authorize|authenticate|can\?|permitted_params|strong_params|permit\(/.test(addedText + removedText)) risks.push({ severity: 'high', description: 'Auth or permitted params modified — check privilege escalation' });
    if (/get\s+['"]|post\s+['"]|put\s+['"]|patch\s+['"]|delete\s+['"]|resources\s+:|resource\s+:/.test(addedText + removedText)) risks.push({ severity: 'medium', description: 'Route definition changed — verify client compatibility' });
    if (/Worker|Job|Sidekiq|perform_async|perform_in|delay\./.test(filename + addedText)) risks.push({ severity: 'medium', description: 'Background worker modified — check retry and idempotency' });
    if (/ENV\[|process\.env\.|Rails\.application\.config|Settings\./.test(addedText)) risks.push({ severity: 'medium', description: 'Environment variable access changed — verify all envs have keys' });
    if (/HTTParty|RestClient|axios\.|fetch\(|Net::HTTP|Faraday/.test(addedText)) risks.push({ severity: 'medium', description: 'External HTTP call changed — verify payload and timeouts' });
    const oldConds = (removedText.match(/\bif |\belsif |\bunless |\bcase /g) || []).length;
    const newConds = (addedText.match(/\bif |\belsif |\bunless |\bcase /g) || []).length;
    if (oldConds !== newConds) risks.push({ severity: 'low', description: 'Conditional logic altered — edge cases may change' });

    return risks.map(r => ({ ...r, file: filename }));
  }
  static _extractSignatures(lines) {
    const sigs = new Map();
    const patterns = [/^\s*def\s+(self\.\w+|\w+)\s*\(([^)]*)\)/, /^\s*(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/, /^\s*(?:async\s+)?(\w+)\s*\(([^)]*)\)\s*\{/];
    for (const line of lines) { for (const p of patterns) { const m = line.match(p); if (m) { sigs.set(m[1].replace('self.', ''), m[2].replace(/\s+/g, ' ').trim()); break; } } }
    return sigs;
  }
}


// ============================================================================
// GITHUB PR ANALYZER
// ============================================================================

class GitHubPRAnalyzer {
  constructor(token) {
    this.token = token;
    this.baseUrl = 'https://api.github.com';
    this._symbolCache = new Map();
  }

  static parsePRUrl(prLink) {
    const match = prLink.match(/github\.com\/(.+?)\/(.+?)\/pull\/(\d+)/);
    if (!match) return null;
    return { owner: match[1], repo: match[2], prNumber: parseInt(match[3]) };
  }

  async getPRFromLink(prLink) {
    try {
      const parsed = GitHubPRAnalyzer.parsePRUrl(prLink);
      if (!parsed) return null;
      const { owner, repo, prNumber } = parsed;
      const response = await axios.get(`${this.baseUrl}/repos/${owner}/${repo}/pulls/${prNumber}`, { headers: this.getGitHubHeaders() });
      return response.data;
    } catch (error) {
      UI.fail(`PR fetch failed: ${error.message}`);
      return null;
    }
  }

  async getPRFiles(pr) {
    try {
      const response = await axios.get(`${pr.url}/files`, { headers: this.getGitHubHeaders(), params: { per_page: 100 } });
      return response.data;
    } catch (_) { return []; }
  }

  async getFileContentAtRef(owner, repo, filePath, ref) {
    try {
      const response = await axios.get(`${this.baseUrl}/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}`, { headers: this.getGitHubHeaders(), params: { ref } });
      if (response.data.encoding === 'base64') return Buffer.from(response.data.content.replace(/\n/g, ''), 'base64').toString('utf-8');
      return response.data.content || '';
    } catch (_) { return null; }
  }

  async searchSymbolInRepo(owner, repo, symbol, excludePaths) {
    const cacheKey = `${owner}/${repo}:${symbol}`;
    if (this._symbolCache.has(cacheKey)) return this._symbolCache.get(cacheKey).filter(p => !excludePaths.has(p));
    try {
      await new Promise(r => setTimeout(r, 1500));
      const response = await axios.get(`${this.baseUrl}/search/code`, { headers: this.getGitHubHeaders(), params: { q: `${symbol} repo:${owner}/${repo}`, per_page: 8 } });
      const paths = (response.data.items || []).map(item => item.path);
      this._symbolCache.set(cacheKey, paths);
      return paths.filter(p => !excludePaths.has(p));
    } catch (_) {
      this._symbolCache.set(cacheKey, []);
      return [];
    }
  }

  async analyzePR(pr) {
    if (!pr) return this._emptyResult();
    const owner = pr.base.repo.owner.login;
    const repo = pr.base.repo.name;
    const baseSha = pr.base.sha;
    const files = await this.getPRFiles(pr);
    const diffSummary = files.map(f => `${f.filename} (+${f.additions}/-${f.deletions})`);
    const changedPathSet = new Set(files.map(f => f.filename));

    UI.kv('Files changed', `${files.length}`);
    for (const f of files.slice(0, 8)) {
      UI.bullet(`${f.filename}  (+${f.additions}/-${f.deletions})`);
    }
    if (files.length > 8) UI.bullet(`... and ${files.length - 8} more`);

    const isTestFile = f => /[._-](?:spec|test)\.|\/spec\/|\/test\//i.test(f.filename);
    const fileResults = await Promise.all(
      files.slice(0, 20).map(async (file) => {
        const baseContent = isTestFile(file) ? null : await this.getFileContentAtRef(owner, repo, file.filename, baseSha);
        return { risks: DiffRiskAnalyzer.analyze(file.filename, file.patch, baseContent), symbols: DiffSymbolExtractor.extract(file.filename, file.patch), filename: file.filename };
      })
    );

    const allDirectRisks = fileResults.flatMap(r => r.risks);
    const allChangedSymbols = fileResults.flatMap(({ symbols, filename }) => [
      ...symbols.changed.map(s => ({ symbol: s, kind: 'modified', file: filename })),
      ...symbols.removed.map(s => ({ symbol: s, kind: 'removed', file: filename })),
      ...symbols.added.map(s => ({ symbol: s, kind: 'added', file: filename })),
    ]);

    const indirectRisks = [];
    const symbolsToSearch = allChangedSymbols.filter(s => (s.kind === 'modified' || s.kind === 'removed') && s.symbol.length >= 3).slice(0, 3);

    if (symbolsToSearch.length > 0) {
      UI.blank();
      UI.kv('Symbol search', `Tracing ${symbolsToSearch.length} symbol(s) across repo`);
    }

    for (const { symbol, kind, file: sourceFile } of symbolsToSearch) {
      const refPaths = await this.searchSymbolInRepo(owner, repo, symbol, changedPathSet);
      if (refPaths.length > 0) {
        UI.bullet(`${symbol} (${kind}) → ${refPaths.length} external reference(s)`);
        const refContents = await Promise.all(
          refPaths.slice(0, 5).map(async refPath => ({ refPath, content: await this.getFileContentAtRef(owner, repo, refPath, baseSha) }))
        );
        for (const { refPath, content } of refContents) {
          const impact = this._assessImpact(symbol, kind, refPath, content);
          if (impact) indirectRisks.push(impact);
        }
      }
    }

    const riskScore = this._computeRiskScore(allDirectRisks, indirectRisks, files);
    return {
      prNumber: pr.number, title: pr.title, author: pr.user.login, diffSummary,
      directRisks: allDirectRisks.map(r => `[${r.severity.toUpperCase()}] ${r.file}: ${r.description}`),
      indirectRisks: indirectRisks.map(r => `[${r.severity.toUpperCase()}] ${r.referencingFile}: ${r.description}`),
      changedSymbols: allChangedSymbols, riskScore, affectedAreas: this._identifyAffectedAreas(files),
      callChannels: this._identifyCallChannels(files, indirectRisks),
    };
  }

  _assessImpact(symbol, kind, referencingFile, content) {
    if (!content) return null;
    const lines = content.split('\n');
    const usageLines = lines.map((line, i) => ({ line, lineNum: i + 1 }))
      .filter(({ line }) => { const l = line.toLowerCase(); return l.includes(symbol.toLowerCase()) && !l.trim().startsWith('#') && !l.trim().startsWith('//'); });
    if (!usageLines.length) return null;
    const isTest = /spec|test/i.test(referencingFile);
    const severity = kind === 'removed' ? 'high' : isTest ? 'low' : 'medium';
    const example = usageLines[0].line.trim().slice(0, 80);
    const description = kind === 'removed'
      ? `Calls \`${symbol}\` which was removed (line ${usageLines[0].lineNum}: \`${example}\`)`
      : `Calls \`${symbol}\` whose signature changed (line ${usageLines[0].lineNum}: \`${example}\`)`;
    return { symbol, kind, referencingFile, severity, description, usageCount: usageLines.length };
  }

  _computeRiskScore(directRisks, indirectRisks, files) {
    let score = 0;
    const w = { high: 15, medium: 8, low: 3 };
    for (const r of directRisks) score += w[r.severity] || 5;
    for (const r of indirectRisks) score += w[r.severity] || 5;
    const totalLines = files.reduce((acc, f) => acc + f.additions + f.deletions, 0);
    if (totalLines > 200) score += 10;
    if (totalLines > 500) score += 10;
    return Math.min(score, 100);
  }

  _identifyAffectedAreas(files) {
    const areas = new Set();
    const areaMap = {
      Authentication: /auth|login|permission|security|token/i, Payment_Billing: /payment|billing|transaction|stripe|invoice/i,
      Database_Models: /database|db|migration|query|schema|model/i, API_Routing: /api|endpoint|route|controller/i,
      UI_Components: /component|page|layout|style|css|view/i, Background_Jobs: /worker|job|sidekiq|queue/i,
      Core_Config: /config|env|setup|main|index/i,
    };
    for (const file of files) { for (const [area, pattern] of Object.entries(areaMap)) { if (pattern.test(file.filename)) areas.add(area); } }
    return Array.from(areas);
  }

  _classifyCallerChannel(filePath) {
    const p = filePath.toLowerCase();
    if (/\/ivr[_/]|ivr_call|_ivr\.|twilio|telnyx|nexmo|vonage|deltacast|multicast|telephony|sip_|phone_number/.test(p)) return 'IVR';
    if (/web_call|web_sdk|websdk|browser_call/.test(p)) return 'WebCall';
    if (/mobile_call|mobile_sdk|\/ios\/|\/android\/|ios_sdk|android_sdk/.test(p)) return 'Mobile';
    return 'All'; // shared / general code → affects all channels
  }

  _identifyCallChannels(files, indirectRisks = []) {
    const channels = new Set();
    const reasons = [];
    const fileText = files.map(f => f.filename).join(' ');
    const patchText = files.map(f => f.patch || '').join(' ');
    const allDiffText = (fileText + ' ' + patchText).toLowerCase();

    // 1. Classify changed files themselves
    const sharedFilePatterns = /progress_service|call_service|call_context|transfer_service|call_connecting|conference|hold_service|recording_service|call_manager|call_event/i;
    if (sharedFilePatterns.test(fileText)) {
      channels.add('IVR'); channels.add('WebCall'); channels.add('Mobile');
      reasons.push('Shared call service in diff → all channels');
    } else {
      if (/\bivr\b|twilio|telnyx|nexmo|vonage|deltacast|multicast|telephony|phone_number|sip\b/i.test(allDiffText)) { channels.add('IVR'); reasons.push('IVR keyword in diff'); }
      if (/web_call|webcall|web_sdk|websdk|browser_call/i.test(allDiffText)) { channels.add('WebCall'); reasons.push('WebCall keyword in diff'); }
      if (/mobile_call|mobile_sdk|\bios\b|\bandroid\b/i.test(allDiffText)) { channels.add('Mobile'); reasons.push('Mobile keyword in diff'); }
    }

    // 2. Classify caller files from outside the diff (indirect risks)
    const callersByChannel = { IVR: [], WebCall: [], Mobile: [], All: [] };
    for (const risk of indirectRisks) {
      if (!risk.referencingFile) continue;
      const ch = this._classifyCallerChannel(risk.referencingFile);
      callersByChannel[ch].push(risk.referencingFile);
    }

    if (callersByChannel.All.length > 0) {
      channels.add('IVR'); channels.add('WebCall'); channels.add('Mobile');
      const callerNames = [...new Set(callersByChannel.All)].slice(0, 2).map(p => p.split('/').pop());
      reasons.push(`Called from shared code outside diff: ${callerNames.join(', ')}`);
    }
    if (callersByChannel.IVR.length > 0) {
      channels.add('IVR');
      reasons.push(`IVR-specific callers: ${[...new Set(callersByChannel.IVR)].slice(0, 2).map(p => p.split('/').pop()).join(', ')}`);
    }
    if (callersByChannel.WebCall.length > 0) {
      channels.add('WebCall');
      reasons.push(`WebCall-specific callers: ${[...new Set(callersByChannel.WebCall)].slice(0, 2).map(p => p.split('/').pop()).join(', ')}`);
    }
    if (callersByChannel.Mobile.length > 0) {
      channels.add('Mobile');
      reasons.push(`Mobile-specific callers: ${[...new Set(callersByChannel.Mobile)].slice(0, 2).map(p => p.split('/').pop()).join(', ')}`);
    }

    if (channels.size === 0) { channels.add('IVR'); reasons.push('No specific channel detected — defaulting to IVR'); }

    const scope = channels.size >= 3 ? 'all' : channels.size === 1 ? 'single' : 'partial';
    return { channels: Array.from(channels), scope, reasons };
  }

  _emptyResult() { return { diffSummary: [], directRisks: [], indirectRisks: [], changedSymbols: [], riskScore: 0, affectedAreas: [] }; }

  getGitHubHeaders() {
    return { 'Authorization': `Bearer ${this.token}`, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  }
}


// ============================================================================
// REGRESSION ANALYSIS ENGINE
// ============================================================================

class RegressionAnalyzer {
  constructor(jiraClient, prAnalyzer, bsClient, e2eClient) {
    this.jiraClient = jiraClient;
    this.prAnalyzer = prAnalyzer;
    this.bsClient = bsClient;
    this.e2eClient = e2eClient;
  }

  async analyzeSinglePR(prLink) {
    UI.section('PR FETCH');
    const pr = await this.prAnalyzer.getPRFromLink(prLink);
    if (!pr) { UI.fail(`Could not fetch PR from: ${prLink}`); return []; }

    UI.kv('PR', `#${pr.number}: ${pr.title}`);
    UI.kv('Author', pr.user.login);
    UI.kv('Branch', `${pr.base.ref} ◀ ${pr.head.ref}`);
    UI.kv('State', pr.state);

    // Skip E2E PRs
    if (/\be2e\b/i.test(`${pr.title} ${pr.head?.ref || ''}`)) {
      UI.warn(`Skipping — PR is an E2E PR ("${pr.title}")`);
      return [];
    }

    UI.section('DIFF ANALYSIS');
    const prAnalysis = await this.prAnalyzer.analyzePR(pr);

    // Jira context lookup
    let jiraContext = { key: null, regressionConcern: '', summary: pr.title, status: pr.state };
    const ticketKeyPattern = /([A-Z]{2,10}-\d+)/g;
    const candidateKeys = [...new Set([...(pr.title.match(ticketKeyPattern) || []), ...(pr.head.ref.match(ticketKeyPattern) || [])])];

    if (candidateKeys.length > 0 && this.jiraClient) {
      UI.section('JIRA CONTEXT');
      UI.kv('Ticket key(s) found', candidateKeys.join(', '));
      for (const key of candidateKeys) {
        const issue = await this.jiraClient.getIssue(key);
        if (issue) {
          const issueText = extractIssueAllText(issue);
          jiraContext = {
            key: issue.key, regressionConcern: issue.fields.regressionConcern || '',
            summary: issue.fields.summary || pr.title, status: issue.fields.status?.name || pr.state,
            issueType: issue.fields.issuetype?.name || 'Unknown',
            mentionedIssueKeys: extractMentionedIssueKeys(issueText, issue.key),
            causation: detectRegressionCausation(issueText),
          };
          UI.kv('Linked ticket', `${issue.key} — ${issue.fields.summary}`);
          if (jiraContext.regressionConcern && !isEmptyValue(jiraContext.regressionConcern)) {
            UI.kv('Regression concern', jiraContext.regressionConcern);
          }
          if (jiraContext.causation) {
            UI.warn(`Regression causation — "${jiraContext.causation.matchedText}"`);
            if (jiraContext.causation.causingKey) UI.kv('Caused by', jiraContext.causation.causingKey, 2);
          }
          if (jiraContext.mentionedIssueKeys.length > 0) {
            UI.kv('Referenced issues', jiraContext.mentionedIssueKeys.join(', '));
          }
          break;
        }
      }
    }

    if (!jiraContext.key && this.jiraClient) {
      UI.section('JIRA CONTEXT');
      const linkedIssues = await this.jiraClient.findTicketsByPR(prLink);
      if (linkedIssues.length > 0) {
        const issue = linkedIssues[0];
        const issueText = extractIssueAllText(issue);
        jiraContext = {
          key: issue.key, regressionConcern: issue.fields.regressionConcern || '',
          summary: issue.fields.summary || pr.title, status: issue.fields.status?.name || pr.state,
          issueType: issue.fields.issuetype?.name || 'Unknown',
          mentionedIssueKeys: extractMentionedIssueKeys(issueText, issue.key),
          causation: detectRegressionCausation(issueText),
        };
        UI.kv('Linked ticket', `${issue.key} — ${issue.fields.summary}`);
        if (jiraContext.causation) {
          UI.warn(`Regression causation — "${jiraContext.causation.matchedText}"`);
          if (jiraContext.causation.causingKey) UI.kv('Caused by', jiraContext.causation.causingKey, 2);
        }
        if (jiraContext.mentionedIssueKeys.length > 0) {
          UI.kv('Referenced issues', jiraContext.mentionedIssueKeys.join(', '));
        }
      } else {
        UI.item('    No linked Jira ticket found — analyzing PR in isolation');
      }
    }

    const keywords = KeywordExtractor.extract(jiraContext.regressionConcern, prAnalysis.affectedAreas, prAnalysis.directRisks, prAnalysis.indirectRisks);

    // BrowserStack matching
    let matchedTestCases = [];
    if (this.bsClient) {
      UI.section('BROWSERSTACK MATCHING');
      const allTestCases = await this.bsClient.getAllTestCases();
      if (allTestCases.length > 0) {
        matchedTestCases = this.bsClient.search(allTestCases, keywords, 5);
        UI.kv('Matched test cases', `${matchedTestCases.length}`);
        for (const tc of matchedTestCases) UI.bullet(`${tc.identifier}: ${tc.title} (score: ${tc.score})`);
      }
    }

    // Call channel scope
    const callChannels = prAnalysis.callChannels;
    if (callChannels) {
      UI.section('CALL CHANNEL SCOPE');
      UI.kv('Channels affected', callChannels.channels.join(', '));
      for (const reason of (callChannels.reasons || [])) UI.bullet(reason);
    }

    // E2E repo matching
    let matchedE2ETests = [];
    if (this.e2eClient) {
      UI.section('E2E REPO MATCHING');
      matchedE2ETests = this.e2eClient.search(keywords, 5, callChannels?.channels);
      UI.kv('Matched E2E files', `${matchedE2ETests.length}`);
      for (const t of matchedE2ETests) UI.bullet(`[${t.channel}] ${t.relativePath} (score: ${t.score})`);
    }

    return [{
      ticketKey: jiraContext.key || `PR-${pr.number}`, ticketSummary: jiraContext.summary,
      ticketType: jiraContext.issueType || 'PR', status: jiraContext.status,
      regressionConcern: jiraContext.regressionConcern, prLink, prNumber: prAnalysis.prNumber || pr.number,
      riskScore: prAnalysis.riskScore || 0, affectedAreas: prAnalysis.affectedAreas || [],
      changedSymbols: prAnalysis.changedSymbols || [], matchedTestCases, matchedE2ETests, prAnalysis,
      mentionedIssueKeys: jiraContext.mentionedIssueKeys || [],
      regressionCausedBy: jiraContext.causation?.causingKey || null,
      regressionCausationText: jiraContext.causation?.matchedText || null,
    }];
  }

  async analyzeCALLTickets(filterId) {
    UI.section('JIRA FILTER');
    UI.kv('Filter ID', filterId);
    const issues = await this.jiraClient.getIssuesByFilter(filterId);
    const allTestCases = this.bsClient ? await this.bsClient.getAllTestCases() : [];

    // Process in batches of 3 to parallelize network I/O while respecting API rate limits
    const BATCH_SIZE = 3;
    const results = [];
    for (let i = 0; i < issues.length; i += BATCH_SIZE) {
      const batch = issues.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map((issue, j) => this._analyzeTicket(issue, allTestCases, i + j, issues.length))
      );
      results.push(...batchResults.filter(Boolean));
    }
    return results.sort((a, b) => b.riskScore - a.riskScore);
  }

  async _analyzeTicket(issue, allTestCases, index, total) {
    try {
      UI.section(`TICKET ${index + 1}/${total}: ${issue.key}`);
      UI.kv('Summary', issue.fields?.summary || 'N/A');

      const epicSkipReason = await this._checkEpicAncestry(issue);
      if (epicSkipReason) {
        UI.warn(`Skipping — ${epicSkipReason}`);
        return null;
      }

      let prLink = this.extractPRLink(issue);
      if (!prLink) {
        prLink = await this.jiraClient.getExternalPRLink(issue.key, issue.id);
        if (prLink) UI.kv('PR (via integration)', prLink);
        else UI.warn('No PR link found');
      } else {
        UI.kv('PR', prLink);
      }

      let prAnalysis = this.prAnalyzer._emptyResult();
      if (prLink) {
        const pr = await this.prAnalyzer.getPRFromLink(prLink);
        if (pr && /\be2e\b/i.test(`${pr.title} ${pr.head?.ref || ''}`)) {
          UI.warn(`Skipping — PR #${pr.number} is an E2E PR ("${pr.title}")`);
          return null;
        }
        prAnalysis = await this.prAnalyzer.analyzePR(pr);
      }

      const regressionConcern = issue.fields?.regressionConcern || '';
      const issueText = extractIssueAllText(issue);
      const mentionedIssueKeys = extractMentionedIssueKeys(issueText, issue.key);
      const causation = detectRegressionCausation(issueText);

      if (regressionConcern && !isEmptyValue(regressionConcern)) UI.kv('Regression concern', regressionConcern);
      if (causation) {
        UI.warn(`Regression causation — "${causation.matchedText}"`);
        if (causation.causingKey) UI.kv('Caused by', causation.causingKey, 2);
      }
      if (mentionedIssueKeys.length > 0) UI.kv('Referenced issues', mentionedIssueKeys.join(', '));

      const keywords = KeywordExtractor.extract(regressionConcern, prAnalysis.affectedAreas, prAnalysis.directRisks, prAnalysis.indirectRisks);

      let matchedTestCases = [];
      if (this.bsClient && allTestCases.length > 0) {
        matchedTestCases = this.bsClient.search(allTestCases, keywords, 5);
        if (matchedTestCases.length > 0) UI.kv('BS matches', `${matchedTestCases.length} test case(s)`);
      }

      let matchedE2ETests = [];
      if (this.e2eClient) {
        matchedE2ETests = this.e2eClient.search(keywords, 5, prAnalysis.callChannels?.channels);
        if (matchedE2ETests.length > 0) UI.kv('E2E matches', `${matchedE2ETests.length} file(s)`);
      }

      return {
        ticketKey: issue.key, ticketSummary: issue.fields?.summary || 'N/A',
        ticketType: issue.fields?.issuetype?.name || 'Unknown', status: issue.fields?.status?.name || 'Unknown',
        regressionConcern, prLink: prLink || null, prNumber: prAnalysis.prNumber || null,
        riskScore: prAnalysis.riskScore || 0, affectedAreas: prAnalysis.affectedAreas || [],
        changedSymbols: prAnalysis.changedSymbols || [], matchedTestCases, matchedE2ETests, prAnalysis,
        mentionedIssueKeys,
        regressionCausedBy: causation?.causingKey || null,
        regressionCausationText: causation?.matchedText || null,
      };
    } catch (error) {
      UI.fail(`Error analyzing ${issue?.key || 'unknown'}: ${error.message}`);
      return null;
    }
  }

  extractPRLink(issue) {
    const str = JSON.stringify(issue.fields || {});
    const match = str.match(/https:\/\/github\.com\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/pull\/\d+/i);
    return match ? match[0] : null;
  }

  // Returns a skip reason string if ticket is under an Epic (directly or via a parent Task/Story).
  // Returns null if it should not be skipped.
  async _checkEpicAncestry(issue) {
    const parent = issue.fields?.parent;
    if (!parent) return null;

    if (parent.issuetype === 'Epic') {
      return `child of Epic ${parent.key} — "${parent.summary}"`;
    }

    // Parent is a Task/Story — check if grandparent is an Epic
    const grandparentTypes = ['Task', 'Story', 'Sub-task', 'Sub-Task'];
    if (grandparentTypes.includes(parent.issuetype)) {
      const parentIssue = await this.jiraClient.getIssue(parent.key);
      const grandparent = parentIssue?.fields?.parent;
      if (grandparent?.issuetype === 'Epic') {
        return `child of ${parent.issuetype} ${parent.key} ("${parent.summary}") which is under Epic ${grandparent.key} — "${grandparent.summary}"`;
      }
    }

    return null;
  }
}


// ============================================================================
// OUTPUT GENERATOR (CSV)
// ============================================================================

class OutputGenerator {
  static async generate(analysisResults) {
    if (!fs.existsSync(CONFIG.outputDir)) fs.mkdirSync(CONFIG.outputDir, { recursive: true });
    this.generateCSV(analysisResults, path.join(CONFIG.outputDir, 'pr-risk-mapping.csv'));
    return { total: analysisResults.length, highRisk: analysisResults.filter(t => t.riskScore >= 70).length };
  }

  static generateCSV(data, filepath) {
    const headers = ['Jira Ticket','Status','PR Link','Risk Score','Regression Area/Concern (Jira Field)',
      'Changed Files (Diffs)','Direct Diff Risks (What Changed & Why It Breaks)',
      'Indirect Risks (Outside the Diffs — Callers & References)','Modified/Removed Symbols',
      'Affected Components','Matched BrowserStack Test Cases','BS Test Case URLs',
      'Matched E2E Tests','E2E Run Commands'];
    const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const rows = data.map(ticket => {
      const a = ticket.prAnalysis || {};
      const symbols = (ticket.changedSymbols || []).filter(s => s.kind === 'modified' || s.kind === 'removed').map(s => `${s.symbol} (${s.kind})`).join(', ');
      const tcTitles = (ticket.matchedTestCases || []).map(tc => `${tc.identifier}: ${tc.title}`).join('\n');
      const tcUrls = (ticket.matchedTestCases || []).map(tc => BrowserStackClient.tcUrl(tc.identifier)).join('\n');
      const e2eTitles = (ticket.matchedE2ETests || []).map(t => `${t.relativePath}${t.describe ? ` — ${t.describe}` : ''}`).join('\n');
      const e2eCommands = (ticket.matchedE2ETests || []).map(t => t.runCommand).join('\n');
      return [ticket.ticketKey, ticket.status, ticket.prLink || 'No PR Found', ticket.riskScore,
        ticket.regressionConcern || '', (a.diffSummary || []).join('\n'),
        (a.directRisks || []).join('\n') || 'No structural risks detected',
        (a.indirectRisks || []).join('\n') || 'No external references impacted',
        symbols || 'None extracted', (ticket.affectedAreas || []).join(', '),
        tcTitles || 'No matches found', tcUrls || '',
        e2eTitles || 'No matches found', e2eCommands || ''];
    });
    fs.writeFileSync(filepath, [headers, ...rows].map(row => row.map(esc).join(',')).join('\n'));
  }
}


// ============================================================================
// RISK SCENARIO RULES (UJET domain-specific)
// ============================================================================

const RISK_SCENARIO_RULES = [
  { id: 'CALL_STATE', name: 'Call State Machine & Progress Events', minSignals: 2,
    matchPatterns: { symbols: /progress|state_machine|call_status|call_state|transition|event_handler/i, risks: /call.*state|progress.*service|state.*transition|status.*display/i, files: /progress|state_machine|call_event|call_status/i, areas: /Core_Config|API_Routing/, concerns: /call.*state|call.*status|call.*flow|call.*transition|progress.*service|state.*machine/i },
    scenarios: [
      { title: 'Call status transitions — Inbound call lifecycle', steps: 'Inbound call → Agent answers → Hold → Unhold → End call', verify: 'Verify call status updates in Agent Adapter at each transition', priority: 'Critical', category: 'Call State' },
      { title: 'Call status transitions — Warm transfer', steps: 'Inbound call → Agent 1 answers → Warm transfer to Agent 2 → Agent 2 picks up → Agent 1 drops → End call', verify: 'Both agents see correct statuses throughout', priority: 'Critical', category: 'Call State' },
      { title: 'Call status transitions — Declined warm transfer', steps: 'Inbound call → Agent 1 answers → Warm transfer to agent/queue → Transfer declined/times out → Agent 1 resumes', verify: 'Agent 1 returns to connected state, adapter reflects correct status', priority: 'Critical', category: 'Call State' },
      { title: 'Call status display — Agent Adapter after upgrade', steps: 'After server upgrade, make inbound call → observe Agent Adapter', verify: 'All call statuses display correctly (no blank/missing)', priority: 'High', category: 'Call State' },
    ],
  },
  { id: 'AGENT_JOIN', name: 'Agent Joining & Conference Logic', minSignals: 2,
    matchPatterns: { symbols: /join|conference|participant|agent.*call|add_agent|connect_agent/i, risks: /agent.*join|conference|participant|added.*all.*agents/i, files: /conference|participant|agent_call|warm_transfer/i, concerns: /agent.*join|transfer|conference/i },
    scenarios: [
      { title: 'Warm transfer — Agent 2 joins correctly', steps: 'Agent 1 on call → Warm transfer to Agent 2 → Agent 2 answers', verify: 'Agent 2 joins conference. Both agents + consumer hear each other.', priority: 'Critical', category: 'Transfer' },
      { title: 'Warm transfer — Declined (agent and queue)', steps: 'Agent 1 on call → Warm transfer to agent → Agent 2 declines; Repeat with warm transfer to queue → No agent picks up/times out', verify: 'Agent 1 returns to call each time, consumer hears hold music during transfer attempt, call resumes normally after decline', priority: 'Critical', category: 'Transfer' },
      { title: 'Cold transfer — Agent handoff', steps: 'Agent 1 on call → Cold transfer to Agent 2 → Agent 1 drops', verify: 'Agent 2 receives call, no orphaned call legs', priority: 'High', category: 'Transfer' },
      { title: 'Multi-agent conference — 3+ participants', steps: 'Agent 1 on call → Add Agent 2 → Add Agent 3 → Leave one by one', verify: 'Each join/leave handled correctly. No call drops.', priority: 'Medium', category: 'Transfer' },
    ],
  },
  { id: 'HOLD_MUSIC', name: 'Hold Music & Hold/Unhold Behavior',
    matchPatterns: { symbols: /hold|unhold|moh|music_on_hold|pause|resume/i, risks: /hold.*music|on.?hold|pause.*recording|hold.*recording/i, files: /hold|moh|music/i, concerns: /hold|music|pause|recording.*hold/i },
    scenarios: [
      { title: 'Hold music — Mono recording (Dual Channel OFF)', steps: 'Dual Channel OFF → Inbound call → Hold → Unhold → End', verify: 'Recording does NOT contain hold music', priority: 'Critical', category: 'Hold Music' },
      { title: 'Hold music — Dual channel recording', steps: 'Dual Channel ON → Inbound call → Hold → Unhold → End', verify: 'Hold music ONLY on consumer channel. Agent channel silent.', priority: 'Critical', category: 'Hold Music' },
      { title: 'Hold during warm transfer — declined', steps: 'Hold → Warm transfer to agent → Agent 2 declines → Agent 1 resumes → Unhold', verify: 'Hold music plays during transfer attempt. Stops correctly after unhold.', priority: 'Critical', category: 'Hold Music' },
      { title: 'Hold ON vs Hold OFF during transfer', steps: 'A: Hold before transfer. B: Direct transfer. Both warm.', verify: 'Both complete successfully with correct audio behavior', priority: 'High', category: 'Hold Music' },
      { title: 'Multiple hold/unhold cycles', steps: 'Hold → Unhold → Hold → Unhold → Hold → Unhold → End', verify: 'Each cycle works. No accumulated audio delay.', priority: 'Medium', category: 'Hold Music' },
    ],
  },
  { id: 'RECORDING', name: 'Call Recording & Post-Processing',
    matchPatterns: { symbols: /recording|post_process|segment|dual_channel|media|storage/i, risks: /recording|post.*process|segment|dual.*channel|media.*upload/i, files: /recording|media|storage|post_process|dual_channel/i, concerns: /recording|segment|dual.*channel|post.*process|storage/i },
    scenarios: [
      { title: 'Recording — Seg OFF + Dual OFF', steps: 'Config C1. Complete call with warm transfer.', verify: 'Single recording. 1 entry in post_process_recordings.', priority: 'Critical', category: 'Recording' },
      { title: 'Recording — Seg ON + Dual OFF', steps: 'Config C2. Complete call with warm transfer.', verify: 'Per-agent segment recordings. Entries match agent count.', priority: 'Critical', category: 'Recording' },
      { title: 'Recording — Seg OFF + Dual ON', steps: 'Config C3. Complete call with warm transfer.', verify: 'Single dual-channel file. Hold music on consumer channel only.', priority: 'Critical', category: 'Recording' },
      { title: 'Recording — Seg ON + Dual ON', steps: 'Config C4. Complete call with warm transfer.', verify: 'Per-segment dual-channel files. Metadata fields correct.', priority: 'Critical', category: 'Recording' },
      { title: 'Post-process metadata validation', steps: 'Query session metadata via Reports > Session Data', verify: 'Verify id, call_id, duration, started_at, recording_url, agent_id', priority: 'High', category: 'Recording' },
      { title: 'CRM recording link upload', steps: 'Post call recording link to CRM = ON. Complete call.', verify: 'CRM has recording link comment. Link accessible.', priority: 'High', category: 'Recording' },
    ],
  },
  { id: 'VA_AI', name: 'Virtual Agent & AI Escalation Flows', minSignals: 2,
    matchPatterns: { symbols: /virtual_agent|va_|ai_|escalat|progress_service|attempt_return|dialogflow|ccai/i, risks: /virtual.*agent|VA.*escalat|progress.*service|AI.*flow|attempt_return/i, files: /virtual_agent|va_|ai_|escalat|dialogflow|ccai/i, concerns: /virtual.*agent|VA|AI|escalat|CCAI/i },
    scenarios: [
      { title: 'VA → Human Agent escalation', steps: 'Consumer enters VA → VA escalates to HA queue → Agent picks up', verify: 'Escalation completes. Agent gets full context. Recording captures VA+HA.', priority: 'Critical', category: 'VA/AI' },
      { title: 'VA escalation + hold', steps: 'VA escalation → Agent answers → Hold → Unhold → End', verify: 'Hold music works after VA escalation', priority: 'High', category: 'VA/AI' },
      { title: 'VA escalation + warm transfer', steps: 'VA escalates to Agent 1 → Warm transfer to Agent 2', verify: 'Transfer works. ProgressService handles state. No method errors.', priority: 'High', category: 'VA/AI' },
      { title: 'VA return to queue', steps: 'VA flow → Return end user to queue → Agent receives call', verify: 'No NoMethodError. Consumer returned to queue successfully.', priority: 'Critical', category: 'VA/AI' },
    ],
  },
  { id: 'METHOD_CHANGE', name: 'Method Signature & API Contract',
    matchPatterns: { risks: /signature.*changed|was removed|callers.*break|compatibility/i },
    scenarios: [
      { title: 'Verify all callers of changed methods', steps: 'For each modified/removed symbol: execute all calling paths', verify: 'No NoMethodError, ArgumentError, or unexpected behavior', priority: 'Critical', category: 'Code Impact' },
      { title: 'Service-to-service contract validation', steps: 'Test all consuming services of changed shared methods', verify: 'Each consumer handles new signature correctly', priority: 'High', category: 'Code Impact' },
    ],
  },
  { id: 'ERROR_HANDLING', name: 'Error Handling & Exception Flow',
    matchPatterns: { risks: /error handling removed|exception.*propagat|rescue|catch/i },
    scenarios: [
      { title: 'Error path — network failure during call', steps: 'Simulate network interruption during active call', verify: 'Graceful degradation. No unhandled exceptions.', priority: 'High', category: 'Error Handling' },
      { title: 'Error path — invalid input', steps: 'Send nil/empty inputs to modified endpoints', verify: 'Proper error responses. No 500s. No data corruption.', priority: 'Medium', category: 'Error Handling' },
    ],
  },
  { id: 'BACKGROUND_JOBS', name: 'Background Workers & Async',
    matchPatterns: { symbols: /worker|sidekiq|job|async|queue|perform/i, risks: /worker|job|queue|async|background|retry|idempotency/i, files: /worker|job|sidekiq/i, concerns: /worker|background.*job|sidekiq|\bqueue\b|async|retry/i },
    scenarios: [
      { title: 'Post-call recording upload job', steps: 'Complete call → Wait for job → Check storage', verify: 'Recording uploaded. No retry loops. File accessible.', priority: 'High', category: 'Background Jobs' },
      { title: 'CRM metadata upload job', steps: 'Complete call with CRM active → Wait for upload', verify: 'CRM receives correct metadata. Job is idempotent.', priority: 'Medium', category: 'Background Jobs' },
    ],
  },
  { id: 'DATABASE', name: 'Database & Schema Changes',
    matchPatterns: { risks: /migration|schema|column|table|database.*query|N\+1/i, files: /migrate|schema|db\//i, areas: /Database_Models/, concerns: /migration|schema|\bcolumn\b|\btable\b|database|data.*integrity/i },
    scenarios: [
      { title: 'Data integrity after migration', steps: 'Run migration → Query affected tables', verify: 'Existing records intact. New columns have defaults.', priority: 'Critical', category: 'Database' },
      { title: 'Rollback safety', steps: 'Apply migration → Roll back → Verify app works', verify: 'Rollback clean. App functions on prior schema.', priority: 'High', category: 'Database' },
    ],
  },
  { id: 'VOIP_PROVIDER', name: 'VoIP Provider-Specific', minSignals: 2,
    matchPatterns: { symbols: /twilio|telnyx|nexmo|vonage|provider|telephony/i, risks: /provider|twilio|telnyx|nexmo|telephony/i, files: /twilio|telnyx|nexmo|provider|telephony/i, concerns: /provider|twilio|telnyx|nexmo/i },
    scenarios: [
      { title: 'Cross-provider — Twilio', steps: 'Full call flow on Twilio (inbound → hold → transfer → end)', verify: 'All events handled. Recording generated. Hold music works.', priority: 'High', category: 'Provider' },
      { title: 'Cross-provider — Telnyx', steps: 'Full call flow on Telnyx', verify: 'All events handled. Recording generated. Hold music works.', priority: 'High', category: 'Provider' },
      { title: 'Cross-provider — Nexmo', steps: 'Full call flow on Nexmo', verify: 'All events handled. Recording generated. Hold music works.', priority: 'Medium', category: 'Provider' },
    ],
  },
  { id: 'CRM', name: 'CRM Integration & Metadata',
    matchPatterns: { symbols: /crm|zendesk|salesforce|kustomer|freshdesk|hubspot|servicenow/i, risks: /CRM|zendesk|salesforce|metadata.*upload/i, files: /crm|zendesk|salesforce|kustomer|freshdesk/i, concerns: /CRM|zendesk|salesforce/i },
    scenarios: [
      { title: 'CRM metadata — Zendesk', steps: 'Complete call with Zendesk → Wait for upload', verify: 'Ticket updated. Recording link posted. Fields populated.', priority: 'High', category: 'CRM' },
      { title: 'CRM metadata — Salesforce', steps: 'Complete call with Salesforce → Wait for upload', verify: 'Case updated. Recording link accessible. Fields mapped.', priority: 'High', category: 'CRM' },
    ],
  },
  { id: 'API_ROUTES', name: 'API Endpoint & Route Changes', minSignals: 2,
    matchPatterns: { risks: /route.*changed|endpoint|API.*contract|mobile.*client/i, files: /routes|controller|api\//i, areas: /API_Routing/, concerns: /\bAPI\b|endpoint|\broute\b|API.*contract|\bclient\b.*break|mobile.*client/i },
    scenarios: [
      { title: 'API backward compat — mobile clients', steps: 'Older mobile SDK → Call changed endpoints', verify: 'Older clients get valid responses. No breaking changes.', priority: 'Critical', category: 'API' },
      { title: 'API backward compat — Agent Adapter', steps: 'Agent Adapter → Exercise changed endpoints in call flow', verify: 'Adapter functions correctly. No missing data.', priority: 'High', category: 'API' },
    ],
  },

  { id: 'VA_DEFLECTION', name: 'Virtual Agent OC/After-Hours Deflection',
    matchPatterns: { symbols: /deflect|after_hours|overcap|overcapacity|oc_deflect|conditional_overcap/i, risks: /deflect|after.*hour|overcap|over.*capacity/i, files: /deflect|after_hours|overcap/i, concerns: /deflect|after.*hour|overcap|over.*capacity/i },
    scenarios: [
      { id: 'after_hours_deflection',             title: 'OC Deflection — After Hours',                steps: 'Set queue to after-hours schedule → Inbound call arrives',                                         verify: 'Call deflected to after-hours destination. Consumer receives correct message or routing.',        priority: 'Critical', category: 'VA/Deflection' },
      { id: 'overcapacity_deflection',             title: 'OC Deflection — Overcapacity',               steps: 'Fill queue to capacity → Inbound call arrives',                                                    verify: 'Overcapacity deflection triggers. Consumer routed to OC destination. Queue count unaffected.',    priority: 'Critical', category: 'VA/Deflection' },
      { id: 'conditional_overcapacity_deflection', title: 'OC Deflection — Conditional Overcapacity',   steps: 'Configure conditional OC rule → Trigger threshold → Inbound call arrives',                        verify: 'Rule evaluated correctly. Deflection triggers only when condition is met.',                        priority: 'High',     category: 'VA/Deflection' },
    ],
  },
];

// ============================================================================
// FILENAME EXPANSION MAP
// ============================================================================
// Maps filename patterns → rule IDs to force-fire regardless of signal count.
// Optional `hint` drives scenario disambiguation within the forced rule.

const FILENAME_EXPANSION_MAP = [
  { pattern: /cold_transfer/i,                                        forceRuleId: 'AGENT_JOIN' },
  { pattern: /transfer_service|transfer_handler|transfer_manager/i,   forceRuleId: 'AGENT_JOIN' },
  { pattern: /deflect/i,                                              forceRuleId: 'VA_DEFLECTION' },
  { pattern: /after_hours|afterhours/i,                               forceRuleId: 'VA_DEFLECTION', hint: 'after_hours' },
  { pattern: /overcap|over_capacity/i,                                forceRuleId: 'VA_DEFLECTION', hint: 'overcapacity' },
  { pattern: /conditional_overcap/i,                                  forceRuleId: 'VA_DEFLECTION', hint: 'conditional_overcapacity' },
  { pattern: /save_recording|recording_worker|post_process_recording/i, forceRuleId: 'RECORDING' },
];

// ============================================================================
// RISK MAP GENERATOR
// ============================================================================

class RiskMapGenerator {
  static generate(analysisResults, e2eClient = null, bsClient = null) {
    if (!fs.existsSync(CONFIG.outputDir)) fs.mkdirSync(CONFIG.outputDir, { recursive: true });

    const ticketScenarios = analysisResults.map(ticket => {
      const matched = this._matchRules(ticket);
      return { ticket, matchedRules: matched.rules, scenarios: matched.scenarios, coverageGaps: matched.gaps };
    });

    const riskMapMd = this._generateRiskMapMarkdown(ticketScenarios, e2eClient, bsClient);
    const scenarioCsv = this._generateScenarioCSV(ticketScenarios);
    const bsCsv = this._generateBrowserStackCSV(ticketScenarios);

    const riskMapHtml = this._generateHTML(ticketScenarios);

    fs.writeFileSync(path.join(CONFIG.outputDir, 'regression-risk-map.md'), riskMapMd);
    fs.writeFileSync(path.join(CONFIG.outputDir, 'regression-risk-map.html'), riskMapHtml);
    fs.writeFileSync(path.join(CONFIG.outputDir, 'recommended-test-scenarios.csv'), scenarioCsv);
    fs.writeFileSync(path.join(CONFIG.outputDir, 'browserstack-regression-scenarios.csv'), bsCsv);

    return { ticketScenarios };
  }

  static _generateHTML(ticketScenarios) {
    const now = new Date().toISOString().split('T')[0];
    const allScenarios = this._dedup(ticketScenarios.flatMap(ts => ts.scenarios));
    const critical = ticketScenarios.filter(ts => ts.ticket.riskScore >= 70);
    const high     = ticketScenarios.filter(ts => ts.ticket.riskScore >= 50 && ts.ticket.riskScore < 70);
    const medium   = ticketScenarios.filter(ts => ts.ticket.riskScore >= 30 && ts.ticket.riskScore < 50);
    const low      = ticketScenarios.filter(ts => ts.ticket.riskScore < 30);

    const PRIORITY_COLOR = { Critical: '#dc2626', High: '#ea580c', Medium: '#ca8a04', Low: '#16a34a' };
    const SCORE_COLOR = s => s >= 70 ? '#dc2626' : s >= 50 ? '#ea580c' : s >= 30 ? '#ca8a04' : '#16a34a';
    const SCORE_LABEL = s => s >= 70 ? 'CRITICAL' : s >= 50 ? 'HIGH' : s >= 30 ? 'MEDIUM' : 'LOW';

    const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

    const renderScenarios = (scenarios) => scenarios.map((s, i) => {
      const col = PRIORITY_COLOR[s.priority] || '#6b7280';
      const e2eFiles = (s.e2eMatches || []).map(f =>
        `<label class="e2e-item"><input type="checkbox" onchange="saveCheck(this)"> <code>${esc(f.relativePath)}</code> <span class="channel-tag">${esc(f.channel||'IVR')}</span></label>`
      ).join('');
      return `
        <div class="scenario-card" style="border-left:3px solid ${col}">
          <div class="scenario-header">
            <span class="priority-badge" style="background:${col}">${esc(s.priority)}</span>
            <span class="scenario-title">${esc(s.title)}</span>
            <span class="category-tag">${esc(s.category||'')}</span>
          </div>
          <div class="scenario-body">
            <div class="scenario-field"><span class="field-label">Steps</span><span>${esc(s.steps||'')}</span></div>
            <div class="scenario-field"><span class="field-label">Verify</span><span>${esc(s.verify||'')}</span></div>
            ${e2eFiles ? `<div class="scenario-field"><span class="field-label">E2E Files</span><div class="e2e-list">${e2eFiles}</div></div>` : ''}
          </div>
        </div>`;
    }).join('');

    const renderTickets = () => ticketScenarios.map((ts, i) => {
      const t = ts.ticket;
      const pr = t.prAnalysis || {};
      const col = SCORE_COLOR(t.riskScore);
      const label = SCORE_LABEL(t.riskScore);
      const files = (pr.diffSummary||[]).slice(0,8).map(f => `<li><code>${esc(f)}</code></li>`).join('');
      const risks = [...(pr.directRisks||[]).slice(0,4), ...(pr.indirectRisks||[]).slice(0,2)]
        .map(r => `<li class="risk-item">${esc(r)}</li>`).join('');
      const prLink = t.prUrl ? `<a href="${esc(t.prUrl)}" target="_blank" class="pr-link">View PR ↗</a>` : '';
      const jiraLink = `<a href="https://ujetcs.atlassian.net/browse/${esc(t.ticketKey)}" target="_blank" class="jira-link">${esc(t.ticketKey)}</a>`;
      const categories = ts.matchedRules.map(r => `<span class="rule-tag">${esc(r.name)}</span>`).join('');

      return `
        <div class="ticket-card" id="ticket-${esc(t.ticketKey)}">
          <button class="ticket-header" onclick="toggle('body-${i}', this)" style="border-left:4px solid ${col}">
            <div class="ticket-header-left">
              <span class="score-badge" style="background:${col}">${label} ${t.riskScore}</span>
              ${jiraLink}
              <span class="ticket-summary">${esc(t.ticketSummary||t.ticketKey)}</span>
            </div>
            <div class="ticket-header-right">
              <span class="scenario-count">${ts.scenarios.length} scenario${ts.scenarios.length!==1?'s':''}</span>
              <span class="chevron">▼</span>
            </div>
          </button>
          <div class="ticket-body" id="body-${i}" style="display:none">
            <div class="ticket-meta">
              ${prLink}
              ${categories}
            </div>
            ${files ? `<div class="files-section"><div class="section-label">Changed Files</div><ul class="file-list">${files}</ul></div>` : ''}
            ${risks ? `<div class="risks-section"><div class="section-label">Risk Signals</div><ul class="risk-list">${risks}</ul></div>` : ''}
            ${ts.scenarios.length ? `<div class="scenarios-section"><div class="section-label">Recommended Scenarios</div>${renderScenarios(ts.scenarios)}</div>` : '<div class="no-scenarios">No scenarios generated — below risk threshold or CI-only change.</div>'}
            ${ts.coverageGaps?.length ? `<div class="gaps-section"><div class="section-label">⚠ Uncovered Risks</div><ul class="gap-list">${ts.coverageGaps.map(g=>`<li>${esc(g.detail)}</li>`).join('')}</ul></div>` : ''}
          </div>
        </div>`;
    }).join('');

    // Build ticket lookup for PR context in the plan
    const ticketMap = new Map(ticketScenarios.map(ts => [ts.ticket.ticketKey, ts.ticket]));

    const renderPRContext = (sourceKeys) => {
      const tickets = sourceKeys.map(k => ticketMap.get(k)).filter(Boolean);
      if (!tickets.length) return '';

      const prLinks = tickets
        .filter(t => t.prUrl)
        .map(t => {
          const num = (t.prUrl||'').match(/\/pull\/(\d+)/)?.[1];
          return `<a href="${esc(t.prUrl)}" target="_blank" class="pr-chip">PR #${esc(num||'?')} ↗</a>`;
        }).join('');

      const allFiles = [...new Set(tickets.flatMap(t => (t.prAnalysis?.diffSummary||[])))];
      const allIndirect = [...new Set(tickets.flatMap(t => (t.prAnalysis?.indirectRisks||[])))];

      const fileRows = allFiles.slice(0,10).map(f => {
        const match = f.match(/^(.+?)\s*\(([^)]+)\)$/);
        const fname = match ? match[1].trim() : f;
        const diff  = match ? match[2] : '';
        const adds  = diff.match(/\+(\d+)/)?.[1];
        const dels  = diff.match(/-(\d+)/)?.[1];
        return `<div class="ctx-file"><code>${esc(fname)}</code>${adds?`<span class="add-badge">+${esc(adds)}</span>`:''}${dels?`<span class="del-badge">-${esc(dels)}</span>`:''}</div>`;
      }).join('');

      const callerRows = allIndirect.slice(0,6).map(r => {
        const sev = /\[HIGH\]/.test(r) ? 'high' : /\[MEDIUM\]/.test(r) ? 'med' : 'low';
        const clean = r.replace(/^\[(HIGH|MEDIUM|LOW)\]\s*/,'');
        return `<div class="ctx-caller caller-${sev}"><span class="sev-dot"></span>${esc(clean)}</div>`;
      }).join('');

      return `
        <details class="pr-context">
          <summary class="pr-context-summary">
            ${prLinks || '<span style="color:#94a3b8;font-size:11px">No PR linked</span>'}
            <span class="ctx-counts">${allFiles.length} file${allFiles.length!==1?'s':''} changed${allIndirect.length?` · ${allIndirect.length} indirect caller${allIndirect.length!==1?'s':''}`:''}</span>
            <span class="ctx-toggle">▸ diff</span>
          </summary>
          <div class="pr-context-body">
            ${fileRows ? `<div class="ctx-section"><div class="ctx-label">Changed Files</div>${fileRows}</div>` : ''}
            ${callerRows ? `<div class="ctx-section"><div class="ctx-label">Indirect Callers</div>${callerRows}</div>` : ''}
          </div>
        </details>`;
    };

    const renderExecutionPlan = () => {
      const byPriority = { Critical: [], High: [], Medium: [], Low: [] };
      for (const s of allScenarios) (byPriority[s.priority] || byPriority.Low).push(s);
      const section = (label, emoji, color, items) => items.length ? `
        <div class="plan-section">
          <h3 style="color:${color}">${emoji} ${label} (${items.length})</h3>
          ${items.map((s,i) => {
            const sourceKeys = s.sourceTickets || [s.sourceTicket];
            const e2eFiles = (s.e2eMatches||[]).map(f =>
              `<label class="e2e-item"><input type="checkbox" onchange="saveCheck(this)"> <code>${esc(f.relativePath)}</code> <span class="channel-tag">${esc(f.channel||'IVR')}</span></label>`
            ).join('');
            return `<div class="plan-item">
              <div class="plan-title">${esc(s.title)}
                <span class="source-tickets">${sourceKeys.map(k=>`<a href="https://ujetcs.atlassian.net/browse/${esc(k)}" target="_blank">${esc(k)}</a>`).join(', ')}</span>
              </div>
              ${renderPRContext(sourceKeys)}
              <div class="plan-steps"><strong>Steps:</strong> ${esc(s.steps||'')}</div>
              <div class="plan-verify">${esc(s.verify||'')}</div>
              ${e2eFiles ? `<div class="e2e-list">${e2eFiles}</div>` : ''}
            </div>`;
          }).join('')}
        </div>` : '';
      return section('Must Run — Critical','🔴','#dc2626',byPriority.Critical)
           + section('Should Run — High','🟠','#ea580c',byPriority.High)
           + section('Run if time permits','🟡','#ca8a04',byPriority.Medium)
           + section('Low priority','🟢','#16a34a',byPriority.Low);
    };

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Regression Risk Map — ${now}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8fafc;color:#1e293b;font-size:14px}
a{color:#3b82f6;text-decoration:none} a:hover{text-decoration:underline}
.header{background:#0f172a;color:#f1f5f9;padding:20px 32px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100}
.header h1{font-size:18px;font-weight:600;letter-spacing:-.3px}
.header-meta{font-size:12px;color:#94a3b8;margin-top:2px}
.summary-pills{display:flex;gap:12px;flex-wrap:wrap;padding:16px 32px;background:#fff;border-bottom:1px solid #e2e8f0}
.pill{display:flex;flex-direction:column;align-items:center;padding:10px 20px;border-radius:8px;min-width:80px}
.pill-num{font-size:24px;font-weight:700;line-height:1}
.pill-label{font-size:11px;color:#64748b;margin-top:3px;text-transform:uppercase;letter-spacing:.5px}
.pill.critical{background:#fef2f2;color:#dc2626}
.pill.high{background:#fff7ed;color:#ea580c}
.pill.medium{background:#fefce8;color:#ca8a04}
.pill.low{background:#f0fdf4;color:#16a34a}
.pill.neutral{background:#f1f5f9;color:#475569}
.tabs{display:flex;gap:0;padding:0 32px;background:#fff;border-bottom:1px solid #e2e8f0}
.tab{padding:12px 20px;font-size:13px;font-weight:500;cursor:pointer;border-bottom:2px solid transparent;color:#64748b;background:none;border-top:none;border-left:none;border-right:none}
.tab.active{color:#3b82f6;border-bottom-color:#3b82f6}
.tab-content{display:none;padding:24px 32px;max-width:1100px;margin:0 auto}
.tab-content.active{display:block}
.ticket-card{background:#fff;border-radius:8px;border:1px solid #e2e8f0;margin-bottom:12px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.05)}
.ticket-header{width:100%;display:flex;align-items:center;justify-content:space-between;padding:14px 16px;background:none;border:none;cursor:pointer;text-align:left;gap:12px}
.ticket-header:hover{background:#f8fafc}
.ticket-header-left{display:flex;align-items:center;gap:10px;flex:1;min-width:0}
.ticket-header-right{display:flex;align-items:center;gap:10px;flex-shrink:0}
.score-badge{font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;color:#fff;letter-spacing:.5px;flex-shrink:0}
.ticket-summary{font-size:13px;font-weight:500;color:#374151;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.scenario-count{font-size:12px;color:#94a3b8}
.chevron{font-size:11px;color:#94a3b8;transition:transform .2s}
.chevron.open{transform:rotate(180deg)}
.jira-link{font-size:12px;font-weight:600;color:#3b82f6;flex-shrink:0}
.pr-link{font-size:12px;color:#3b82f6;padding:3px 8px;border:1px solid #bfdbfe;border-radius:4px}
.ticket-body{padding:16px;border-top:1px solid #f1f5f9;background:#fafbfc}
.ticket-meta{display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap}
.rule-tag{font-size:11px;background:#eff6ff;color:#1d4ed8;padding:2px 8px;border-radius:12px}
.section-label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:#64748b;margin-bottom:8px}
.files-section,.risks-section,.scenarios-section,.gaps-section{margin-bottom:16px}
.file-list,.risk-list,.gap-list{padding-left:18px;font-size:13px;color:#475569;line-height:1.8}
.file-list code,.risk-list code{font-size:12px;background:#f1f5f9;padding:1px 5px;border-radius:3px}
.risk-item{color:#dc2626}
.scenario-card{background:#fff;border-radius:6px;border:1px solid #e5e7eb;margin-bottom:10px;overflow:hidden}
.scenario-header{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#f9fafb}
.scenario-title{font-size:13px;font-weight:600;color:#1f2937;flex:1}
.priority-badge{font-size:10px;font-weight:700;padding:2px 7px;border-radius:3px;color:#fff;flex-shrink:0}
.category-tag{font-size:11px;color:#6b7280;background:#f3f4f6;padding:2px 7px;border-radius:3px}
.scenario-body{padding:10px 12px;display:flex;flex-direction:column;gap:8px}
.scenario-field{display:flex;gap:10px;font-size:13px}
.field-label{font-size:11px;font-weight:600;text-transform:uppercase;color:#9ca3af;min-width:52px;padding-top:1px}
.e2e-list{display:flex;flex-direction:column;gap:4px;margin-top:2px}
.e2e-item{display:flex;align-items:center;gap:6px;font-size:12px;color:#374151;cursor:pointer}
.e2e-item input{cursor:pointer}
.e2e-item code{font-size:11px;background:#f1f5f9;padding:1px 5px;border-radius:3px}
.channel-tag{font-size:10px;background:#dbeafe;color:#1d4ed8;padding:1px 5px;border-radius:10px}
.no-scenarios{color:#94a3b8;font-size:13px;font-style:italic;padding:8px 0}
.plan-section{margin-bottom:28px}
.plan-section h3{font-size:14px;font-weight:700;margin-bottom:12px;padding-bottom:8px;border-bottom:2px solid #e2e8f0}
.plan-item{background:#fff;border:1px solid #e2e8f0;border-radius:6px;padding:14px;margin-bottom:10px}
.plan-title{font-size:13px;font-weight:600;color:#1f2937;margin-bottom:8px}
.plan-steps{font-size:12px;color:#475569;margin:6px 0 4px}
.plan-verify{font-size:12px;color:#6b7280;margin-bottom:8px;font-style:italic}
.source-tickets{font-weight:400;font-size:11px;color:#9ca3af;margin-left:6px}
.pr-context{border:1px solid #e2e8f0;border-radius:5px;margin:8px 0;overflow:hidden}
.pr-context-summary{display:flex;align-items:center;gap:8px;padding:7px 10px;cursor:pointer;list-style:none;background:#f8fafc;font-size:12px;user-select:none}
.pr-context-summary::-webkit-details-marker{display:none}
.pr-context-summary:hover{background:#f1f5f9}
details[open] .ctx-toggle{transform:rotate(90deg);display:inline-block}
.ctx-toggle{font-size:11px;color:#94a3b8;transition:transform .15s;margin-left:auto}
.pr-chip{font-size:11px;font-weight:600;background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;padding:2px 8px;border-radius:4px}
.ctx-counts{font-size:11px;color:#94a3b8}
.pr-context-body{padding:10px 12px;background:#fff;border-top:1px solid #f1f5f9;display:flex;flex-direction:column;gap:10px}
.ctx-section{display:flex;flex-direction:column;gap:3px}
.ctx-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#94a3b8;margin-bottom:4px}
.ctx-file{display:flex;align-items:center;gap:6px;font-size:12px;color:#374151}
.ctx-file code{color:#0f172a;font-size:11px}
.add-badge{font-size:10px;font-weight:700;color:#16a34a}
.del-badge{font-size:10px;font-weight:700;color:#dc2626}
.ctx-caller{display:flex;align-items:flex-start;gap:6px;font-size:12px;color:#475569;padding:2px 0}
.sev-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;margin-top:3px}
.caller-high .sev-dot{background:#dc2626} .caller-med .sev-dot{background:#ea580c} .caller-low .sev-dot{background:#94a3b8}
.exec-summary{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin-bottom:20px}
.exec-summary h3{font-size:13px;font-weight:600;margin-bottom:10px;color:#374151}
.exec-summary ul{padding-left:16px;font-size:13px;color:#475569;line-height:2}
.gaps-section .gap-list{color:#ea580c}
code{font-family:'SF Mono',Menlo,Monaco,Consolas,monospace}
</style>
</head>
<body>

<div class="header">
  <div>
    <h1>UJET Regression Risk Map</h1>
    <div class="header-meta">Generated ${now}</div>
  </div>
  <div style="font-size:12px;color:#64748b">regression-risk-map.html</div>
</div>

<div class="summary-pills">
  <div class="pill critical"><span class="pill-num">${critical.length}</span><span class="pill-label">Critical</span></div>
  <div class="pill high"><span class="pill-num">${high.length}</span><span class="pill-label">High</span></div>
  <div class="pill medium"><span class="pill-num">${medium.length}</span><span class="pill-label">Medium</span></div>
  <div class="pill low"><span class="pill-num">${low.length}</span><span class="pill-label">Low</span></div>
  <div class="pill neutral"><span class="pill-num">${allScenarios.length}</span><span class="pill-label">Scenarios</span></div>
  <div class="pill neutral"><span class="pill-num">${ticketScenarios.length}</span><span class="pill-label">Tickets</span></div>
</div>

<div class="tabs">
  <button class="tab active" onclick="showTab('plan',this)">Final Test Plan</button>
  <button class="tab" onclick="showTab('tickets',this)">Ticket Analysis</button>
</div>

<div id="tab-plan" class="tab-content active">
  ${allScenarios.length ? renderExecutionPlan() : '<p style="color:#94a3b8;padding:20px 0;font-style:italic">No scenarios confirmed for this filter.</p>'}
</div>

<div id="tab-tickets" class="tab-content">
  ${renderTickets()}
</div>

<script>
function toggle(id, btn) {
  const el = document.getElementById(id);
  const ch = btn.querySelector('.chevron');
  const open = el.style.display !== 'none';
  el.style.display = open ? 'none' : 'block';
  ch.classList.toggle('open', !open);
}
function showTab(name, btn) {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  btn.classList.add('active');
}
function saveCheck(el) {
  const key = 'chk-' + el.closest('label').querySelector('code').textContent;
  localStorage.setItem(key, el.checked ? '1' : '0');
}
window.addEventListener('load', () => {
  document.querySelectorAll('.e2e-item input[type=checkbox]').forEach(el => {
    const key = 'chk-' + el.closest('label').querySelector('code').textContent;
    if (localStorage.getItem(key) === '1') el.checked = true;
  });
});
</script>
</body>
</html>`;
  }

  static _matchRules(ticket) {
    const pr = ticket.prAnalysis || {};
    const matchedRules = [], allScenarios = [], matchedRuleIds = new Set();
    const symbolText = (ticket.changedSymbols || []).map(s => s.symbol).join(' ');
    const riskText = [...(pr.directRisks || []), ...(pr.indirectRisks || [])].join(' ');
    const fileText = (pr.diffSummary || []).join(' ');
    const areaText = (ticket.affectedAreas || []).join(' ');
    const concernText = ticket.regressionConcern || '';

    // Layer 1: Filename expansion — collect force-injected rule IDs and disambiguation hints
    const changedFilenames = (pr.diffSummary || []).join(' ');
    const forcedRuleIds = new Set();
    const deflectionHints = [];
    for (const exp of FILENAME_EXPANSION_MAP) {
      if (exp.pattern.test(changedFilenames)) {
        forcedRuleIds.add(exp.forceRuleId);
        if (exp.hint) deflectionHints.push(exp.hint);
      }
    }

    // Layer 2: Disambiguation — filter VA_DEFLECTION scenarios by hint + ticket text
    const _disambiguate = (rule, scenarios) => {
      if (rule.id !== 'VA_DEFLECTION' || deflectionHints.length === 0) return scenarios;
      const hintText = [concernText, ticket.summary || '', riskText].join(' ').toLowerCase();
      const filtered = scenarios.filter(s => {
        if (!s.id) return true;
        if (s.id === 'after_hours_deflection' &&
            (deflectionHints.includes('after_hours') || /after.?hour|schedule|closed/i.test(hintText))) return true;
        if (s.id === 'overcapacity_deflection' &&
            (deflectionHints.includes('overcapacity') || /overcap|capacity|threshold|queue.*full/i.test(hintText))) return true;
        if (s.id === 'conditional_overcapacity_deflection' &&
            (deflectionHints.includes('conditional_overcapacity') || /conditional/i.test(hintText))) return true;
        return false;
      });
      return filtered.length > 0 ? filtered : scenarios;
    };

    for (const rule of RISK_SCENARIO_RULES) {
      const mp = rule.matchPatterns;
      const minSignals = rule.minSignals ?? 1;
      const textByKey = { symbols: symbolText, risks: riskText, files: fileText, areas: areaText, concerns: concernText };
      const signalCount = Object.keys(textByKey).filter(k => mp[k]?.test(textByKey[k])).length;
      const forced = forcedRuleIds.has(rule.id);
      if ((signalCount >= minSignals || forced) && !matchedRuleIds.has(rule.id)) {
        matchedRuleIds.add(rule.id);
        matchedRules.push(rule);
        const scenariosToAdd = _disambiguate(rule, rule.scenarios);
        for (const s of scenariosToAdd) allScenarios.push({ ...s, sourceRule: rule.id, sourceRuleName: rule.name, sourceTicket: ticket.ticketKey, ticketRiskScore: ticket.riskScore, ...(forced && signalCount < minSignals ? { forcedByFilename: true } : {}) });
      }
    }
    // Regression causation: inject a dedicated verification scenario
    if (ticket.regressionCausedBy && !matchedRuleIds.has('REGRESSION_BUG')) {
      matchedRuleIds.add('REGRESSION_BUG');
      allScenarios.push({
        title: `Regression verification — fix from ${ticket.regressionCausedBy}`,
        steps: `1. Reproduce the scenario broken by ${ticket.regressionCausedBy}\n2. Verify ${ticket.ticketKey}'s fix resolves the reported issue\n3. Verify ${ticket.regressionCausedBy}'s original functionality still works`,
        verify: `Bug from ${ticket.regressionCausedBy} is resolved. Surrounding behavior unchanged. No new regressions introduced.`,
        priority: 'Critical',
        category: 'Regression Verification',
        sourceRule: 'REGRESSION_BUG',
        sourceRuleName: 'Regression Bug Verification',
        sourceTicket: ticket.ticketKey,
        ticketRiskScore: ticket.riskScore,
      });
    }

    const gaps = [];
    if (pr.directRisks) {
      for (const risk of pr.directRisks) {
        if (!matchedRules.some(r => r.matchPatterns.risks && r.matchPatterns.risks.test(risk))) {
          gaps.push({ type: 'uncovered_risk', detail: risk, ticket: ticket.ticketKey });
        }
      }
    }
    return { rules: matchedRules, scenarios: allScenarios, gaps };
  }

  static _dedup(scenarios) {
    const map = new Map();
    for (const s of scenarios) {
      if (map.has(s.title)) {
        const e = map.get(s.title);
        if (!e.sourceTickets.includes(s.sourceTicket)) e.sourceTickets.push(s.sourceTicket);
        const p = PRIORITY_ORDER;
        if ((p[s.priority] ?? 99) < (p[e.priority] ?? 99)) e.priority = s.priority;
      } else {
        map.set(s.title, { ...s, sourceTickets: [s.sourceTicket] });
      }
    }
    return Array.from(map.values());
  }

  static _scenarioKeywords(scenario) {
    return [
      scenario.title,
      scenario.category,
      ...scenario.title.replace(/[—–]/g, ' ').split(/\s+/).filter(w => w.length >= 4),
    ];
  }

  static _generateRiskMapMarkdown(ticketScenarios, e2eClient = null, bsClient = null) {
    const lines = [];
    const now = new Date().toISOString().split('T')[0];
    lines.push(`# Regression Risk Map`, `Generated: ${now}\n`, `## Executive Summary\n`);
    const allTickets = ticketScenarios.map(ts => ts.ticket);
    const critical = allTickets.filter(t => t.riskScore >= 70), high = allTickets.filter(t => t.riskScore >= 50 && t.riskScore < 70);
    const medium = allTickets.filter(t => t.riskScore >= 30 && t.riskScore < 50), low = allTickets.filter(t => t.riskScore < 30);
    lines.push(`| Risk Level | Count | Tickets |`, `|------------|-------|---------|`);
    lines.push(`| 🔴 Critical (70-100) | ${critical.length} | ${critical.map(t => t.ticketKey).join(', ') || 'None'} |`);
    lines.push(`| 🟠 High (50-69) | ${high.length} | ${high.map(t => t.ticketKey).join(', ') || 'None'} |`);
    lines.push(`| 🟡 Medium (30-49) | ${medium.length} | ${medium.map(t => t.ticketKey).join(', ') || 'None'} |`);
    lines.push(`| 🟢 Low (0-29) | ${low.length} | ${low.map(t => t.ticketKey).join(', ') || 'None'} |`, '');
    const uniqueScenarios = this._dedup(ticketScenarios.flatMap(ts => ts.scenarios));
    lines.push(`**Total unique test scenarios recommended:** ${uniqueScenarios.length}\n`, `## Per-Ticket Risk Breakdown\n`);
    for (const ts of ticketScenarios) {
      const t = ts.ticket, pr = t.prAnalysis || {};
      const icon = t.riskScore >= 70 ? '🔴' : t.riskScore >= 50 ? '🟠' : t.riskScore >= 30 ? '🟡' : '🟢';
      lines.push(`### ${icon} ${t.ticketKey} — Score: ${t.riskScore}/100\n`, `**Summary:** ${t.ticketSummary || 'N/A'}`, `**Status:** ${t.status}`);
      if (t.prLink) lines.push(`**PR:** ${t.prLink}`);
      if (t.regressionConcern) lines.push(`**Regression Concern:** ${t.regressionConcern}`);
      if (t.regressionCausedBy) lines.push(`**Regression Caused By:** [${t.regressionCausedBy}](https://ujetcs.atlassian.net/browse/${t.regressionCausedBy}) — _"${t.regressionCausationText}"_`);
      if (t.mentionedIssueKeys?.length > 0) lines.push(`**Referenced Issues:** ${t.mentionedIssueKeys.map(k => `[${k}](https://ujetcs.atlassian.net/browse/${k})`).join(', ')}`);
      lines.push('');
      if (t.prAnalysis?.callChannels) {
        const cc = t.prAnalysis.callChannels;
        const channelIcons = { IVR: '📞', WebCall: '🌐', Mobile: '📱' };
        const channelStr = cc.channels.map(c => `${channelIcons[c] || ''} ${c}`).join('  ');
        lines.push(`**Call Channels Affected:** ${channelStr}`);
        for (const r of (cc.reasons || [])) lines.push(`> - ${r}`);
        lines.push('');
      }
      if (pr.diffSummary?.length) { lines.push(`**Changed Files:**`); for (const f of pr.diffSummary.slice(0, 10)) lines.push(`- \`${f}\``); lines.push(''); }
      if (pr.directRisks?.length) { lines.push(`**Direct Risks:**`); for (const r of pr.directRisks) lines.push(`- ${r}`); lines.push(''); }
      if (pr.indirectRisks?.length) { lines.push(`**Indirect Risks:**`); for (const r of pr.indirectRisks) lines.push(`- ${r}`); lines.push(''); }
      if (ts.matchedRules.length) { lines.push(`**Risk Categories Triggered:**`); for (const r of ts.matchedRules) lines.push(`- ${r.name}`); lines.push(''); }
      if (ts.scenarios.length) {
        lines.push(`**Recommended Scenarios:**\n`);
        ts.scenarios.forEach((s, i) => {
          lines.push(`${i + 1}. **${s.title}** \`${s.priority}\` \`${s.category}\``);
          if (e2eClient) {
            const matches = e2eClient.search(this._scenarioKeywords(s), 2);
            for (const m of matches) lines.push(`   → [${m.channel}] \`${m.relativePath}\``);
          }
          if (bsClient?._cache?.length) {
            const bsMatches = bsClient.search(bsClient._cache, this._scenarioKeywords(s), 2);
            for (const tc of bsMatches) lines.push(`   → BS: \`${tc.identifier}: ${tc.title}\``);
          }
        });
        lines.push('');
      }
      if (t.matchedTestCases?.length) {
        lines.push(`**Matched BrowserStack Test Cases:**`);
        for (const tc of t.matchedTestCases) lines.push(`- [${tc.identifier}: ${tc.title}](${BrowserStackClient.tcUrl(tc.identifier)}) (score: ${tc.score})`);
        lines.push('');
      }
      if (ts.coverageGaps.length) { lines.push(`**⚠️ Uncovered Risks:**`); for (const g of ts.coverageGaps) lines.push(`- ${g.detail}`); lines.push(''); }
      lines.push('---\n');
    }
    uniqueScenarios.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99));

    // Union of all channels across all tickets — used for every scenario in consolidated view
    const allChannels = [...new Set(
      ticketScenarios.flatMap(ts => ts.ticket.prAnalysis?.callChannels?.channels || [])
    )];

    lines.push(`## Consolidated Test Scenario List\n`);
    if (allChannels.length) {
      const channelIcons = { IVR: '📞', WebCall: '🌐', Mobile: '📱' };
      lines.push(`> **Combined channel scope across all tickets:** ${allChannels.map(c => `${channelIcons[c] || ''} ${c}`).join('  ')}\n`);
    }

    // Track E2E files already surfaced: path → scenarioNum (1-based)
    const seenE2EFiles = new Map();
    // Accumulate unique E2E files for the execution summary
    const e2eSummary = new Map(); // path → {channel, coverage: [scenarioNum]}
    // Accumulate unique BS test cases for the execution summary
    const bsSummary = new Map(); // identifier → {title, url, coverage: [scenarioNum]}

    uniqueScenarios.forEach((s, i) => {
      lines.push(`${i + 1}. **${s.title}** \`${s.priority}\` \`${s.category}\` _(${s.sourceTickets.join(', ')})_`);

      if (e2eClient) {
        const matches = e2eClient.search(this._scenarioKeywords(s), 2, allChannels.length ? allChannels : null);
        for (const m of matches) {
          const alreadyIn = seenE2EFiles.get(m.relativePath);
          if (alreadyIn !== undefined) {
            lines.push(`   → [${m.channel}] \`${m.relativePath}\` _(covered in #${alreadyIn})_`);
          } else {
            lines.push(`   → [${m.channel}] \`${m.relativePath}\``);
            seenE2EFiles.set(m.relativePath, i + 1);
          }
          // Always accumulate into summary regardless of dedup
          if (!e2eSummary.has(m.relativePath)) {
            e2eSummary.set(m.relativePath, { channel: m.channel, coverage: [] });
          }
          e2eSummary.get(m.relativePath).coverage.push(i + 1);
        }
      }

      if (bsClient?._cache?.length) {
        const bsMatches = bsClient.search(bsClient._cache, this._scenarioKeywords(s), 3);
        for (const tc of bsMatches) {
          lines.push(`   → BS: \`${tc.identifier}: ${tc.title}\``);
          if (!bsSummary.has(tc.identifier)) {
            bsSummary.set(tc.identifier, { title: tc.title, url: BrowserStackClient.tcUrl(tc.identifier), coverage: [] });
          }
          bsSummary.get(tc.identifier).coverage.push(i + 1);
        }
      }
    });

    // ── Regression Execution Summary ──────────────────────────────────────────
    if (e2eSummary.size > 0 || bsSummary.size > 0) {
      lines.push('');
      lines.push(`## Regression Execution Summary\n`);
      lines.push(`Unique test cases to run across all ${ticketScenarios.length} ticket(s) and ${uniqueScenarios.length} scenario(s):\n`);
      const channelIcons = { IVR: '📞', WebCall: '🌐', Mobile: '📱' };

      // E2E files grouped by channel
      if (e2eSummary.size > 0) {
        lines.push(`### E2E Test Files\n`);
        const byChannel = {};
        for (const [filePath, { channel, coverage }] of e2eSummary) {
          if (!byChannel[channel]) byChannel[channel] = [];
          byChannel[channel].push({ filePath, coverage });
        }
        for (const channel of ['IVR', 'WebCall', 'Mobile']) {
          const files = byChannel[channel];
          if (!files?.length) continue;
          lines.push(`**${channelIcons[channel] || ''} ${channel}** (${files.length} file${files.length > 1 ? 's' : ''})\n`);
          for (const { filePath, coverage } of files) {
            const scenarioRefs = [...new Set(coverage)].slice(0, 5).join(', ');
            lines.push(`- [ ] \`${filePath}\``);
            lines.push(`  _Covers scenarios: #${scenarioRefs}_`);
          }
          lines.push('');
        }
      }

      // BrowserStack test cases
      if (bsSummary.size > 0) {
        lines.push(`### BrowserStack Test Cases\n`);
        for (const [id, { title, url, coverage }] of bsSummary) {
          const scenarioRefs = [...new Set(coverage)].slice(0, 5).join(', ');
          lines.push(`- [ ] [${id}: ${title}](${url})`);
          lines.push(`  _Covers scenarios: #${scenarioRefs}_`);
        }
        lines.push('');
      }
    }
    lines.push('', `## Execution Priority Guide\n`, `### Phase 1: Smoke (Critical)`, '');
    uniqueScenarios.filter(s => s.priority === 'Critical').forEach((s, i) => lines.push(`${i+1}. **${s.title}** — ${s.verify}`));
    lines.push('', `### Phase 2: Core Regression (High)`, '');
    uniqueScenarios.filter(s => s.priority === 'High').forEach((s, i) => lines.push(`${i+1}. **${s.title}** — ${s.verify}`));
    lines.push('', `### Phase 3: Extended (Medium/Low)`, '');
    uniqueScenarios.filter(s => s.priority === 'Medium' || s.priority === 'Low').forEach((s, i) => lines.push(`${i+1}. **${s.title}** — ${s.verify}`));
    return lines.join('\n');
  }

  static _generateScenarioCSV(ticketScenarios) {
    const headers = ['Source Ticket','Risk Score','Rule ID','Rule Name','Priority','Category','Scenario Title','Steps','Verification'];
    const rows = [];
    for (const ts of ticketScenarios) for (const s of ts.scenarios) rows.push([s.sourceTicket, s.ticketRiskScore, s.sourceRule, s.sourceRuleName, s.priority, s.category, s.title, s.steps, s.verify]);
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    return [headers, ...rows].map(r => r.map(esc).join(',')).join('\n');
  }

  static _generateBrowserStackCSV(ticketScenarios) {
    const headers = ['Test Case ID','Title','Folder ID','Folder Path','State','Owner','Priority','Type of Test Case','Automation Status','Description','Preconditions','Template','Steps','Expected Result','Issues','Tags'];
    const allScenarios = this._dedup(ticketScenarios.flatMap(ts => ts.scenarios));
    allScenarios.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99));
    const rows = [];
    const esc = v => { const s = String(v ?? ''); return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s.replace(/"/g, '""')}"` : s; };
    for (const sc of allScenarios) {
      const stepParts = sc.steps.split(/→|➜|->/).map(s => s.trim()).filter(Boolean);
      const verifyParts = sc.verify.split(/\.\s+/).map(s => s.trim()).filter(Boolean);
      rows.push(['', `[${sc.category}] ${sc.title}`, CONFIG.browserstack.targetFolderId, CONFIG.browserstack.folderPath, 'Active', 'Ryan Dedumo', sc.priority, 'Functional', 'Not Automated', `Auto-generated from risk analysis. Source: ${sc.sourceTickets.join(', ')}`, '', 'Steps', stepParts[0] || sc.steps, verifyParts[0] || sc.verify, sc.sourceTickets.join(', '), `regression,risk-map,${sc.category.toLowerCase().replace(/[/ ]/g, '-')}`]);
      for (let i = 1; i < stepParts.length; i++) { const r = new Array(headers.length).fill(''); r[12] = stepParts[i]; r[13] = verifyParts[i] || ''; rows.push(r); }
      for (let i = stepParts.length; i < verifyParts.length; i++) { const r = new Array(headers.length).fill(''); r[12] = 'Verify the result'; r[13] = verifyParts[i]; rows.push(r); }
    }
    return [headers.map(esc), ...rows.map(r => r.map(esc))].join('\n');
  }
}


// ============================================================================
// CSV INPUT PARSER (for --risk-map-only)
// ============================================================================

class CSVInputParser {
  static parse(csvPath) {
    const content = fs.readFileSync(csvPath, 'utf-8');
    const rows = this._parseCSVRows(content);
    if (rows.length < 2) throw new Error('CSV is empty');
    const results = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i]; if (!row[0]) continue;
      results.push({
        ticketKey: row[0], ticketSummary: '', status: row[1] || '',
        prLink: row[2] === 'No PR Found' ? null : row[2], riskScore: parseInt(row[3]) || 0,
        regressionConcern: row[4] || '', affectedAreas: (row[9] || '').split(',').map(a => a.trim()).filter(Boolean),
        changedSymbols: (row[8] || '').split(',').map(s => { const m = s.trim().match(/^(.+?)\s*\((\w+)\)$/); return m ? { symbol: m[1], kind: m[2] } : null; }).filter(Boolean),
        matchedTestCases: [], prAnalysis: { diffSummary: (row[5] || '').split('\n').filter(Boolean), directRisks: (row[6] || '').split('\n').filter(Boolean), indirectRisks: (row[7] || '').split('\n').filter(Boolean) },
      });
    }
    return results;
  }
  static _parseCSVRows(content) {
    const rows = []; let currentRow = [], currentField = '', inQuotes = false, i = 0;
    while (i < content.length) {
      const c = content[i];
      if (inQuotes) { if (c === '"') { if (content[i+1] === '"') { currentField += '"'; i += 2; } else { inQuotes = false; i++; } } else { currentField += c; i++; } }
      else { if (c === '"') { inQuotes = true; i++; } else if (c === ',') { currentRow.push(currentField); currentField = ''; i++; } else if (c === '\n' || (c === '\r' && content[i+1] === '\n')) { currentRow.push(currentField); rows.push(currentRow); currentRow = []; currentField = ''; i += (c === '\r' ? 2 : 1); } else { currentField += c; i++; } }
    }
    if (currentField || currentRow.length) { currentRow.push(currentField); rows.push(currentRow); }
    return rows;
  }
}


// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const startTime = Date.now();

  try {
    UI.header('UJET Regression Risk Analyzer v3.0');

    const args = process.argv.slice(2);
    const input = parseInput(args[0]);

    // ── Risk-Map-Only ──
    if (input.type === 'risk-map-only') {
      UI.section('MODE: RISK MAP ONLY');
      const csvPath = path.join(CONFIG.outputDir, 'pr-risk-mapping.csv');
      if (!fs.existsSync(csvPath)) throw new Error(`No CSV found at ${csvPath}`);
      const results = CSVInputParser.parse(csvPath);
      UI.ok(`Parsed ${results.length} ticket(s) from CSV`);
      const { ticketScenarios } = RiskMapGenerator.generate(results);
      printRiskMapSummary(ticketScenarios, startTime);
      return;
    }

    // Validate credentials
    if (!CONFIG.github.token) throw new Error('Missing GITHUB_TOKEN');

    UI.section('CONFIGURATION');
    UI.kv('Mode', input.type === 'pr' ? 'Single PR Analysis' : 'Jira Filter Batch');
    UI.kv('Input', input.value);
    UI.kv('GitHub', '✓ connected');
    UI.kv('Jira', CONFIG.jira.email ? '✓ connected' : '– not configured');
    UI.kv('BrowserStack', CONFIG.browserstack.username ? '✓ connected' : '– not configured');
    UI.kv('E2E Repo', fs.existsSync(CONFIG.e2eRepo.path) ? `✓ ${CONFIG.e2eRepo.path}` : '– not found');

    const prAnalyzer = new GitHubPRAnalyzer(CONFIG.github.token);
    const jiraClient = (CONFIG.jira.email && CONFIG.jira.apiToken) ? new JiraClient(CONFIG.jira.baseUrl, CONFIG.jira.email, CONFIG.jira.apiToken) : null;
    const bsClient = (CONFIG.browserstack.username && CONFIG.browserstack.accessKey) ? new BrowserStackClient(CONFIG.browserstack.username, CONFIG.browserstack.accessKey, CONFIG.browserstack.projectIdentifier, CONFIG.browserstack.folderId) : null;
    const e2eClient = new E2ERepoClient(CONFIG.e2eRepo.path);
    const analyzer = new RegressionAnalyzer(jiraClient, prAnalyzer, bsClient, e2eClient);

    let analysisResults;
    if (input.type === 'pr') {
      analysisResults = await analyzer.analyzeSinglePR(input.value);
    } else {
      if (!jiraClient) throw new Error('Missing Jira credentials for filter mode');
      analysisResults = await analyzer.analyzeCALLTickets(input.value || CONFIG.jira.filterId);
    }

    if (!analysisResults || analysisResults.length === 0) {
      UI.warn('No results to analyze');
      return;
    }

    // Generate outputs
    UI.section('RISK ANALYSIS');
    for (const ticket of analysisResults) {
      const icon = UI.riskIcon(ticket.riskScore);
      const label = UI.riskLabel(ticket.riskScore);
      const pr = ticket.prAnalysis || {};
      UI.blank();
      UI.item(`    ${icon}  ${ticket.ticketKey}  [${label}]  Score: ${ticket.riskScore}/100`);
      UI.item(`       ${ticket.ticketSummary}`);
      if (pr.directRisks?.length) {
        for (const r of pr.directRisks.slice(0, 3)) UI.item(`       ⚑  ${r}`);
      }
      if (pr.indirectRisks?.length) {
        for (const r of pr.indirectRisks.slice(0, 2)) UI.item(`       ↳  ${r}`);
      }
    }

    UI.section('OUTPUT FILES');
    await OutputGenerator.generate(analysisResults);
    UI.ok(`pr-risk-mapping.csv`);
    const { ticketScenarios } = RiskMapGenerator.generate(analysisResults, e2eClient, bsClient);
    UI.ok(`regression-risk-map.md`);
    UI.ok(`regression-risk-map.html`);
    UI.ok(`recommended-test-scenarios.csv`);
    UI.ok(`browserstack-regression-scenarios.csv`);

    printRiskMapSummary(ticketScenarios, startTime);

  } catch (error) {
    UI.blank();
    UI.fail(`Error: ${error.message}`);
    process.exit(1);
  }
}


function printRiskMapSummary(ticketScenarios, startTime) {
  const allScenarios = RiskMapGenerator._dedup(ticketScenarios.flatMap(ts => ts.scenarios));
  const byPriority = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  for (const s of allScenarios) byPriority[s.priority] = (byPriority[s.priority] || 0) + 1;
  const gaps = ticketScenarios.flatMap(ts => ts.coverageGaps);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  UI.header('EXECUTION RESULT');

  UI.kv('Tickets analyzed', `${ticketScenarios.length}`);
  UI.kv('Scenarios generated', `${allScenarios.length}`);
  UI.kv('Coverage gaps', `${gaps.length}`);
  UI.kv('Duration', `${elapsed}s`);

  UI.blank();
  UI.table(
    ['Priority', 'Count', 'Bar'],
    [
      ['● Critical', byPriority.Critical, UI.progressBar(byPriority.Critical, allScenarios.length || 1, 20)],
      ['◉ High',     byPriority.High,     UI.progressBar(byPriority.High, allScenarios.length || 1, 20)],
      ['○ Medium',   byPriority.Medium,   UI.progressBar(byPriority.Medium, allScenarios.length || 1, 20)],
      ['· Low',      byPriority.Low,      UI.progressBar(byPriority.Low, allScenarios.length || 1, 20)],
    ],
    [14, 6, 36]
  );

  UI.blank();
  UI.item(`    Output: ${path.resolve(CONFIG.outputDir)}/`);
  UI.blank();
  UI.item(UI.DIVIDER_BOLD);
  UI.blank();
}


if (require.main === module) {
  main();
}

module.exports = {
  JiraClient, BrowserStackClient, KeywordExtractor, DiffSymbolExtractor,
  DiffRiskAnalyzer, GitHubPRAnalyzer, RegressionAnalyzer, RiskMapGenerator,
  CSVInputParser, OutputGenerator, RISK_SCENARIO_RULES, adfToText, isEmptyValue, parseInput, UI,
};
