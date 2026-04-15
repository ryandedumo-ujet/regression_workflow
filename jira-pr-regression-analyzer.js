/**
 * JIRA PR Regression Risk Analyzer + Risk Map Generator
 *
 * Analyzes PRs for regression risks, maps to BrowserStack test cases,
 * and generates a structured risk map with recommended test scenarios.
 *
 * Usage:
 *   PR mode (single PR):
 *     op run --env-file=.env -- npm start -- "https://github.com/UJET/ujet-server/pull/28755"
 *
 *   Filter mode (batch from Jira filter):
 *     op run --env-file=.env -- npm start -- "https://ujetcs.atlassian.net/issues?filter=30069"
 *
 *   Risk-map-only (regenerate from existing CSV):
 *     op run --env-file=.env -- npm start -- --risk-map-only
 *
 * Requirements:
 *   npm install axios dotenv
 *   Environment: JIRA_EMAIL, JIRA_API_TOKEN, GITHUB_TOKEN,
 *                BROWSERSTACK_USERNAME (optional), BROWSERSTACK_ACCESS_KEY (optional)
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
  outputDir: './regression-analysis-output',
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

/**
 * Detect input type from the CLI argument.
 * Returns: { type: 'pr' | 'filter' | 'risk-map-only', value: string }
 */
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
  // Bare owner/repo/pull format: "UJET/ujet-server/pull/28755"
  if (/^[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(arg)) {
    return { type: 'pr', value: `https://github.com/${arg}` };
  }
  // Just a PR number with org context: "28755" (assumes UJET/ujet-server)
  if (/^\d+$/.test(arg)) {
    return { type: 'pr', value: `https://github.com/UJET/ujet-server/pull/${arg}` };
  }
  // Fallback: treat as filter ID
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
      console.log(`🔍 Searching JQL: ${jql}`);

      const response = await axios.get(
        `${this.baseUrl}/rest/api/3/search/jql`,
        {
          params: {
            jql,
            maxResults: 100,
            fields: '*all,comment,customfield_11041',
          },
          headers: this.getHeaders(),
        }
      );

      if (!response.data?.issues) {
        console.log('⚠️ Unexpected Jira response. No issues found.');
        return [];
      }

      const issues = response.data.issues.map(issue => ({
        key: issue.key,
        id: issue.id,
        fields: {
          summary: issue.fields?.summary || 'N/A',
          description: typeof issue.fields?.description === 'object'
            ? JSON.stringify(issue.fields.description)
            : (issue.fields?.description || ''),
          status: { name: issue.fields?.status?.name || 'Unknown' },
          issuetype: { name: issue.fields?.issuetype?.name || 'Unknown' },
          customfield_10000: issue.fields?.customfield_10000,
          customfield_10001: issue.fields?.customfield_10001,
          regressionConcern: adfToText(issue.fields?.customfield_11041),
          comment: issue.fields?.comment,
        },
      }));

      console.log(`✅ Successfully extracted ${issues.length} CALL tickets.`);
      return issues;
    } catch (error) {
      console.error('❌ Error fetching Jira issues:', error.response?.status, error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Reverse-lookup: find Jira tickets linked to a GitHub PR URL.
   * Searches across all projects, returns the best match.
   */
  async findTicketsByPR(prUrl) {
    try {
      // Strategy 1: Search issue text/comments for the PR URL
      const jql = `text ~ "${prUrl}" ORDER BY updated DESC`;
      console.log(`🔍 Searching Jira for tickets linked to PR: ${prUrl}`);

      const response = await axios.get(
        `${this.baseUrl}/rest/api/3/search/jql`,
        {
          params: {
            jql,
            maxResults: 10,
            fields: 'summary,status,issuetype,customfield_11041,description,comment',
          },
          headers: this.getHeaders(),
        }
      );

      const issues = (response.data?.issues || []).map(issue => ({
        key: issue.key,
        id: issue.id,
        fields: {
          summary: issue.fields?.summary || 'N/A',
          description: typeof issue.fields?.description === 'object'
            ? JSON.stringify(issue.fields.description)
            : (issue.fields?.description || ''),
          status: { name: issue.fields?.status?.name || 'Unknown' },
          issuetype: { name: issue.fields?.issuetype?.name || 'Unknown' },
          regressionConcern: adfToText(issue.fields?.customfield_11041),
          comment: issue.fields?.comment,
        },
      }));

      if (issues.length > 0) {
        console.log(`   ✅ Found ${issues.length} linked Jira ticket(s): ${issues.map(i => i.key).join(', ')}`);
      }

      return issues;
    } catch (error) {
      console.log(`   ⚠️  Jira text search failed: ${error.message}`);
    }

    // Strategy 2: Extract ticket key from PR title/branch
    // (handled in the caller via PR metadata)
    return [];
  }

  /**
   * Fetch a single Jira issue by key (e.g. "AGD-3993").
   */
  async getIssue(issueKey) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/rest/api/3/issue/${issueKey}`,
        {
          params: { fields: 'summary,status,issuetype,customfield_11041,description,comment' },
          headers: this.getHeaders(),
        }
      );
      const issue = response.data;
      return {
        key: issue.key,
        id: issue.id,
        fields: {
          summary: issue.fields?.summary || 'N/A',
          description: typeof issue.fields?.description === 'object'
            ? JSON.stringify(issue.fields.description)
            : (issue.fields?.description || ''),
          status: { name: issue.fields?.status?.name || 'Unknown' },
          issuetype: { name: issue.fields?.issuetype?.name || 'Unknown' },
          regressionConcern: adfToText(issue.fields?.customfield_11041),
          comment: issue.fields?.comment,
        },
      };
    } catch (_) {
      return null;
    }
  }

  async getExternalPRLink(issueKey, issueId) {
    try {
      const remoteLinks = await axios.get(
        `${this.baseUrl}/rest/api/3/issue/${issueKey}/remotelink`,
        { headers: this.getHeaders() }
      );
      for (const link of remoteLinks.data) {
        const url = link.object?.url || '';
        if (url.includes('github.com') && url.includes('/pull/')) return url;
      }
    } catch (_) {}

    try {
      const devStatus = await axios.get(
        `${this.baseUrl}/rest/dev-status/1.0/issue/detail`,
        {
          params: { issueId, applicationType: 'github', dataType: 'pullrequest' },
          headers: this.getHeaders(),
        }
      );
      for (const detail of devStatus.data?.detail || []) {
        for (const pr of detail.pullRequests || []) {
          if (pr.url?.includes('github.com')) return pr.url;
        }
      }
    } catch (_) {}

    return null;
  }

  getHeaders() {
    return {
      'Authorization': `Basic ${this.auth}`,
      'Accept': 'application/json',
    };
  }
}

// ============================================================================
// BROWSERSTACK TEST MANAGEMENT CLIENT
// ============================================================================

class BrowserStackClient {
  constructor(username, accessKey, projectIdentifier, folderId) {
    this.auth = Buffer.from(`${username}:${accessKey}`).toString('base64');
    this.baseUrl = CONFIG.browserstack.baseUrl;
    this.projectIdentifier = projectIdentifier;
    this.folderId = folderId;
    this._cache = null;
  }

  async getAllTestCases() {
    if (this._cache) return this._cache;

    const allCases = [];
    const perPage = 100;
    let page = 1;
    let hasMore = true;

    console.log(`\n🔄 Loading BrowserStack test cases (up to ${CONFIG.browserstack.fetchLimit})...`);

    while (hasMore && allCases.length < CONFIG.browserstack.fetchLimit) {
      try {
        const response = await axios.get(
          `${this.baseUrl}/projects/${this.projectIdentifier}/test-cases`,
          {
            headers: { 'Authorization': `Basic ${this.auth}`, 'Accept': 'application/json' },
            params: {
              folder_id: this.folderId,
              per_page: perPage,
              p: page,
              minify: true,
            },
          }
        );

        const cases = response.data.test_cases || [];
        allCases.push(...cases);

        const info = response.data.info || {};
        hasMore = !!info.next && cases.length === perPage;
        page++;

        if (page % 5 === 2) console.log(`   Loaded ${allCases.length} so far...`);
      } catch (error) {
        console.log(`   ⚠️  BrowserStack fetch error on page ${page}: ${error.message}`);
        break;
      }
    }

    console.log(`   ✅ Loaded ${allCases.length} BrowserStack test cases.`);
    this._cache = allCases;
    return allCases;
  }

  search(testCases, keywords, topN = 5) {
    if (!keywords.length || !testCases.length) return [];

    const terms = [...new Set(
      keywords
        .flatMap(k => [k.toLowerCase(), ...k.toLowerCase().split(/[\s/,_-]+/)])
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

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topN)
      .map(s => ({
        identifier: s.tc.identifier,
        title: s.tc.title,
        tags: s.tc.tags || [],
        score: s.score,
        url: `https://test-management.browserstack.com/projects/${CONFIG.browserstack.projectId}/test-cases/${s.tc.identifier}`,
      }));
  }
}

const STOP_WORDS = new Set([
  'the','and','for','are','was','not','but','with','that','this','from',
  'they','have','had','all','been','when','will','also','its','can','may',
  'test','case','verify','check','ensure','should','must','given','then',
  'new','add','added','updated','removed','changed','fix','fixed',
]);

// ============================================================================
// KEYWORD EXTRACTOR
// ============================================================================

class KeywordExtractor {
  static extract(regressionConcern, affectedAreas, directRisks, indirectRisks) {
    const keywords = new Set();

    if (regressionConcern && !isEmptyValue(regressionConcern)) {
      keywords.add(regressionConcern.trim());
      regressionConcern
        .split(/[\s/,;]+/)
        .map(w => w.trim())
        .filter(w => w.length >= 3 && !STOP_WORDS.has(w.toLowerCase()))
        .forEach(w => keywords.add(w));
    }

    const areaTerms = {
      Authentication:   ['login', 'auth', 'token', 'session', 'permission', 'SSO'],
      Payment_Billing:  ['payment', 'billing', 'invoice', 'subscription', 'transaction'],
      Database_Models:  ['data', 'query', 'record', 'migration', 'schema'],
      API_Routing:      ['API', 'endpoint', 'route', 'request', 'response'],
      UI_Components:    ['UI', 'layout', 'component', 'display', 'render'],
      Background_Jobs:  ['worker', 'job', 'queue', 'async', 'background'],
      Core_Config:      ['config', 'environment', 'settings', 'setup'],
    };
    for (const area of (affectedAreas || [])) {
      (areaTerms[area] || [area.replace(/_/g, ' ')]).forEach(t => keywords.add(t));
    }

    const allRiskText = [...(directRisks || []), ...(indirectRisks || [])].join(' ');
    allRiskText
      .replace(/\[.*?\]/g, '')
      .split(/\s+/)
      .map(w => w.replace(/[^\w]/g, ''))
      .filter(w => w.length >= 5 && !STOP_WORDS.has(w.toLowerCase()))
      .forEach(w => keywords.add(w));

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

    const addedLines   = patch.split('\n').filter(l => l.startsWith('+')).map(l => l.slice(1));
    const removedLines = patch.split('\n').filter(l => l.startsWith('-')).map(l => l.slice(1));

    const addedSymbols   = this._extractSymbols(addedLines,   patterns);
    const removedSymbols = this._extractSymbols(removedLines, patterns);

    return {
      changed: addedSymbols.filter(s => removedSymbols.includes(s)),
      added:   addedSymbols.filter(s => !removedSymbols.includes(s)),
      removed: removedSymbols.filter(s => !addedSymbols.includes(s)),
    };
  }

  static _extractSymbols(lines, patterns) {
    const symbols = new Set();
    for (const line of lines) {
      for (const pattern of patterns) {
        const match = line.match(pattern);
        if (match) symbols.add(match[1]);
      }
    }
    return Array.from(symbols);
  }

  static _patternsForExt(ext) {
    const map = {
      '.rb': [
        /^\s*def\s+(self\.\w+|\w+)/,
        /^\s*class\s+(\w+)/,
        /^\s*module\s+(\w+)/,
        /^\s*scope\s+:(\w+)/,
        /^\s*has_many\s+:(\w+)/,
        /^\s*belongs_to\s+:(\w+)/,
      ],
      '.js': [
        /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
        /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/,
        /^\s*(?:export\s+)?class\s+(\w+)/,
        /^\s*(\w+)\s*\([^)]*\)\s*\{/,
      ],
      '.ts': [
        /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
        /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/,
        /^\s*(?:export\s+)?class\s+(\w+)/,
        /^\s*(?:export\s+)?interface\s+(\w+)/,
        /^\s*(?:public|private|protected|static|async)*\s*(\w+)\s*\([^)]*\)\s*(?::\s*\w+\s*)?\{/,
      ],
      '.py': [
        /^\s*(?:async\s+)?def\s+(\w+)/,
        /^\s*class\s+(\w+)/,
      ],
      '.java': [
        /^\s*(?:public|private|protected|static|final|abstract|\s)*\s+\w+\s+(\w+)\s*\(/,
        /^\s*(?:public|private|protected)?\s*(?:abstract\s+)?class\s+(\w+)/,
      ],
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
    const addedLines   = patch.split('\n').filter(l => l.startsWith('+')).map(l => l.slice(1));
    const removedLines = patch.split('\n').filter(l => l.startsWith('-')).map(l => l.slice(1));
    const addedText    = addedLines.join('\n');
    const removedText  = removedLines.join('\n');

    // 1. Method signature changes
    const sigsRemoved = this._extractSignatures(removedLines);
    const sigsAdded   = this._extractSignatures(addedLines);
    for (const [name, oldSig] of sigsRemoved) {
      const newSig = sigsAdded.get(name);
      if (newSig && oldSig !== newSig) {
        risks.push({ severity: 'high', description: `\`${name}\` signature changed: (${oldSig}) → (${newSig}) — existing callers may break` });
      } else if (!newSig) {
        risks.push({ severity: 'high', description: `\`${name}\` was removed — all callers will break` });
      }
    }

    // 2. Return value changes
    const oldRets = (removedText.match(/\breturn\b/g) || []).length;
    const newRets = (addedText.match(/\breturn\b/g) || []).length;
    if (Math.abs(oldRets - newRets) > 1) {
      risks.push({ severity: 'medium', description: `Return statement count changed (${oldRets} → ${newRets}) — callers expecting specific return shape may be affected` });
    }

    // 3. Error handling removal
    if (/rescue|\.catch\(|try\s*\{/.test(removedText) && !/rescue|\.catch\(|try\s*\{/.test(addedText)) {
      risks.push({ severity: 'high', description: 'Error handling removed — exceptions will now propagate uncaught' });
    }

    // 4. Database changes
    if (/\.where\(|\.find_by|\.update\(|\.destroy|\.delete|ActiveRecord|\.save/.test(addedText)) {
      risks.push({ severity: 'medium', description: 'Database query modified — verify no N+1 introduced and data integrity preserved' });
    }
    if (/add_column|remove_column|rename_column|drop_table|create_table|change_column/.test(addedText)) {
      risks.push({ severity: 'high', description: 'Schema migration detected — ensure migration runs before deploy and is backwards-compatible' });
    }

    // 5. Auth / permissions
    if (/before_action|authorize|authenticate|can\?|permitted_params|strong_params|permit\(/.test(addedText + removedText)) {
      risks.push({ severity: 'high', description: 'Authorization or permitted params modified — verify no privilege escalation or access bypass' });
    }

    // 6. Route / API contract changes
    if (/get\s+['"]|post\s+['"]|put\s+['"]|patch\s+['"]|delete\s+['"]|resources\s+:|resource\s+:/.test(addedText + removedText)) {
      risks.push({ severity: 'medium', description: 'Route definition changed — verify mobile/third-party clients are not broken' });
    }

    // 7. Background jobs
    if (/Worker|Job|Sidekiq|perform_async|perform_in|delay\./.test(filename + addedText)) {
      risks.push({ severity: 'medium', description: 'Background worker/job modified — check queue retry behavior and idempotency' });
    }

    // 8. Config / env vars
    if (/ENV\[|process\.env\.|Rails\.application\.config|Settings\./.test(addedText)) {
      risks.push({ severity: 'medium', description: 'Environment variable or config access changed — verify all environments have required keys' });
    }

    // 9. External HTTP calls
    if (/HTTParty|RestClient|axios\.|fetch\(|Net::HTTP|Faraday/.test(addedText)) {
      risks.push({ severity: 'medium', description: 'External HTTP call added or changed — verify payload format, timeouts, and error handling' });
    }

    // 10. Conditional logic changes
    const oldConds = (removedText.match(/\bif |\belsif |\bunless |\bcase /g) || []).length;
    const newConds = (addedText.match(/\bif |\belsif |\bunless |\bcase /g) || []).length;
    if (oldConds !== newConds) {
      risks.push({ severity: 'low', description: 'Conditional logic altered — edge cases from original flow may no longer be handled' });
    }

    return risks.map(r => ({ ...r, file: filename }));
  }

  static _extractSignatures(lines) {
    const sigs = new Map();
    const patterns = [
      /^\s*def\s+(self\.\w+|\w+)\s*\(([^)]*)\)/,
      /^\s*(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/,
      /^\s*(?:async\s+)?(\w+)\s*\(([^)]*)\)\s*\{/,
    ];
    for (const line of lines) {
      for (const pattern of patterns) {
        const match = line.match(pattern);
        if (match) { sigs.set(match[1].replace('self.', ''), match[2].replace(/\s+/g, ' ').trim()); break; }
      }
    }
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

  /**
   * Parse a PR URL and return { owner, repo, prNumber }.
   */
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
      const response = await axios.get(
        `${this.baseUrl}/repos/${owner}/${repo}/pulls/${prNumber}`,
        { headers: this.getGitHubHeaders() }
      );
      return response.data;
    } catch (error) {
      console.error('   ⚠️ Error fetching PR details:', error.message);
      return null;
    }
  }

  async getPRFiles(pr) {
    try {
      const response = await axios.get(`${pr.url}/files`, {
        headers: this.getGitHubHeaders(),
        params: { per_page: 100 },
      });
      return response.data;
    } catch (_) { return []; }
  }

  async getFileContentAtRef(owner, repo, filePath, ref) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}`,
        { headers: this.getGitHubHeaders(), params: { ref } }
      );
      if (response.data.encoding === 'base64') {
        return Buffer.from(response.data.content.replace(/\n/g, ''), 'base64').toString('utf-8');
      }
      return response.data.content || '';
    } catch (_) { return null; }
  }

  async searchSymbolInRepo(owner, repo, symbol, excludePaths) {
    const cacheKey = `${owner}/${repo}:${symbol}`;
    if (this._symbolCache.has(cacheKey)) {
      return this._symbolCache.get(cacheKey).filter(p => !excludePaths.has(p));
    }
    try {
      await new Promise(r => setTimeout(r, 1500));
      const response = await axios.get(
        `${this.baseUrl}/search/code`,
        {
          headers: this.getGitHubHeaders(),
          params: { q: `${symbol} repo:${owner}/${repo}`, per_page: 8 },
        }
      );
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

    const owner   = pr.base.repo.owner.login;
    const repo    = pr.base.repo.name;
    const baseSha = pr.base.sha;

    const files          = await this.getPRFiles(pr);
    const diffSummary    = files.map(f => `${f.filename} (+${f.additions}/-${f.deletions})`);
    const changedPathSet = new Set(files.map(f => f.filename));

    console.log(`   📂 ${files.length} file(s): ${diffSummary.slice(0, 3).join(', ')}${files.length > 3 ? '...' : ''}`);

    const isTestFile = f => /[._-](?:spec|test)\.|\/spec\/|\/test\//i.test(f.filename);

    const fileResults = await Promise.all(
      files.slice(0, 20).map(async (file) => {
        const baseContent = isTestFile(file)
          ? null
          : await this.getFileContentAtRef(owner, repo, file.filename, baseSha);
        return {
          risks:   DiffRiskAnalyzer.analyze(file.filename, file.patch, baseContent),
          symbols: DiffSymbolExtractor.extract(file.filename, file.patch),
          filename: file.filename,
        };
      })
    );

    const allDirectRisks    = fileResults.flatMap(r => r.risks);
    const allChangedSymbols = fileResults.flatMap(({ symbols, filename }) => [
      ...symbols.changed.map(s => ({ symbol: s, kind: 'modified', file: filename })),
      ...symbols.removed.map(s => ({ symbol: s, kind: 'removed',  file: filename })),
      ...symbols.added.map(s =>   ({ symbol: s, kind: 'added',    file: filename })),
    ]);

    // Search for outside-diff references to modified/removed symbols
    const indirectRisks = [];
    const symbolsToSearch = allChangedSymbols
      .filter(s => (s.kind === 'modified' || s.kind === 'removed') && s.symbol.length >= 3)
      .slice(0, 3);

    for (const { symbol, kind, file: sourceFile } of symbolsToSearch) {
      const refPaths = await this.searchSymbolInRepo(owner, repo, symbol, changedPathSet);
      if (refPaths.length > 0) {
        console.log(`   🔎 "${symbol}" (${kind} in ${path.basename(sourceFile)}): referenced in ${refPaths.length} file(s) outside PR`);

        const refContents = await Promise.all(
          refPaths.slice(0, 5).map(async refPath => ({
            refPath,
            content: await this.getFileContentAtRef(owner, repo, refPath, baseSha),
          }))
        );
        for (const { refPath, content } of refContents) {
          const impact = this._assessImpact(symbol, kind, refPath, content);
          if (impact) indirectRisks.push(impact);
        }
      }
    }

    const riskScore = this._computeRiskScore(allDirectRisks, indirectRisks, files);

    return {
      prNumber: pr.number,
      title: pr.title,
      author: pr.user.login,
      diffSummary,
      directRisks:   allDirectRisks.map(r => `[${r.severity.toUpperCase()}] ${r.file}: ${r.description}`),
      indirectRisks: indirectRisks.map(r => `[${r.severity.toUpperCase()}] ${r.referencingFile}: ${r.description}`),
      changedSymbols: allChangedSymbols,
      riskScore,
      affectedAreas: this._identifyAffectedAreas(files),
    };
  }

  _assessImpact(symbol, kind, referencingFile, content) {
    if (!content) return null;
    const lines = content.split('\n');
    const usageLines = lines
      .map((line, i) => ({ line, lineNum: i + 1 }))
      .filter(({ line }) => {
        const l = line.toLowerCase();
        return l.includes(symbol.toLowerCase()) && !l.trim().startsWith('#') && !l.trim().startsWith('//');
      });
    if (!usageLines.length) return null;

    const isTest   = /spec|test/i.test(referencingFile);
    const severity = kind === 'removed' ? 'high' : isTest ? 'low' : 'medium';
    const example  = usageLines[0].line.trim().slice(0, 80);
    const description = kind === 'removed'
      ? `Calls \`${symbol}\` which was removed — will break at runtime (line ${usageLines[0].lineNum}: \`${example}\`)`
      : `Calls \`${symbol}\` whose signature/behavior changed — verify compatibility (line ${usageLines[0].lineNum}: \`${example}\`)`;

    return { symbol, kind, referencingFile, severity, description, usageCount: usageLines.length };
  }

  _computeRiskScore(directRisks, indirectRisks, files) {
    let score = 0;
    const w = { high: 15, medium: 8, low: 3 };
    for (const r of directRisks)  score += w[r.severity] || 5;
    for (const r of indirectRisks) score += w[r.severity] || 5;
    const totalLines = files.reduce((acc, f) => acc + f.additions + f.deletions, 0);
    if (totalLines > 200) score += 10;
    if (totalLines > 500) score += 10;
    return Math.min(score, 100);
  }

  _identifyAffectedAreas(files) {
    const areas = new Set();
    const areaMap = {
      Authentication:  /auth|login|permission|security|token/i,
      Payment_Billing: /payment|billing|transaction|stripe|invoice/i,
      Database_Models: /database|db|migration|query|schema|model/i,
      API_Routing:     /api|endpoint|route|controller/i,
      UI_Components:   /component|page|layout|style|css|view/i,
      Background_Jobs: /worker|job|sidekiq|queue/i,
      Core_Config:     /config|env|setup|main|index/i,
    };
    for (const file of files) {
      for (const [area, pattern] of Object.entries(areaMap)) {
        if (pattern.test(file.filename)) areas.add(area);
      }
    }
    return Array.from(areas);
  }

  _emptyResult() {
    return { diffSummary: [], directRisks: [], indirectRisks: [], changedSymbols: [], riskScore: 0, affectedAreas: [] };
  }

  getGitHubHeaders() {
    return {
      'Authorization': `Bearer ${this.token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }
}

// ============================================================================
// REGRESSION ANALYSIS ENGINE
// ============================================================================

class RegressionAnalyzer {
  constructor(jiraClient, prAnalyzer, bsClient) {
    this.jiraClient = jiraClient;
    this.prAnalyzer = prAnalyzer;
    this.bsClient   = bsClient;
  }

  /**
   * PR MODE: Analyze a single PR link end-to-end.
   * Reverse-looks-up the Jira ticket for context (regression concern, etc.).
   */
  async analyzeSinglePR(prLink) {
    console.log(`\n🔗 PR Mode: Analyzing ${prLink}\n`);

    // 1. Fetch and analyze the PR
    const pr = await this.prAnalyzer.getPRFromLink(prLink);
    if (!pr) {
      console.error(`❌ Could not fetch PR from: ${prLink}`);
      return [];
    }

    console.log(`   📝 PR #${pr.number}: ${pr.title}`);
    console.log(`   👤 Author: ${pr.user.login}`);
    console.log(`   🎯 Base: ${pr.base.ref} ← ${pr.head.ref}`);

    const prAnalysis = await this.prAnalyzer.analyzePR(pr);

    // 2. Try to find linked Jira tickets for context
    let jiraContext = { key: null, regressionConcern: '', summary: pr.title, status: pr.state };

    // Strategy A: Extract ticket key from PR title or branch name
    const ticketKeyPattern = /([A-Z]{2,10}-\d+)/g;
    const titleKeys = [...(pr.title.match(ticketKeyPattern) || [])];
    const branchKeys = [...(pr.head.ref.match(ticketKeyPattern) || [])];
    const candidateKeys = [...new Set([...titleKeys, ...branchKeys])];

    if (candidateKeys.length > 0 && this.jiraClient) {
      console.log(`\n🔍 Found ticket key(s) in PR: ${candidateKeys.join(', ')}`);
      for (const key of candidateKeys) {
        const issue = await this.jiraClient.getIssue(key);
        if (issue) {
          jiraContext = {
            key: issue.key,
            regressionConcern: issue.fields.regressionConcern || '',
            summary: issue.fields.summary || pr.title,
            status: issue.fields.status?.name || pr.state,
            issueType: issue.fields.issuetype?.name || 'Unknown',
          };
          if (jiraContext.regressionConcern && !isEmptyValue(jiraContext.regressionConcern)) {
            console.log(`   📝 Regression Concern: "${jiraContext.regressionConcern}"`);
          }
          break; // use first valid match
        }
      }
    }

    // Strategy B: Reverse search Jira for the PR URL
    if (!jiraContext.key && this.jiraClient) {
      const linkedIssues = await this.jiraClient.findTicketsByPR(prLink);
      if (linkedIssues.length > 0) {
        const issue = linkedIssues[0];
        jiraContext = {
          key: issue.key,
          regressionConcern: issue.fields.regressionConcern || '',
          summary: issue.fields.summary || pr.title,
          status: issue.fields.status?.name || pr.state,
          issueType: issue.fields.issuetype?.name || 'Unknown',
        };
        if (jiraContext.regressionConcern && !isEmptyValue(jiraContext.regressionConcern)) {
          console.log(`   📝 Regression Concern: "${jiraContext.regressionConcern}"`);
        }
      }
    }

    if (!jiraContext.key) {
      console.log(`   ℹ️  No linked Jira ticket found — analyzing PR in isolation.`);
    }

    // 3. Match BrowserStack test cases
    let matchedTestCases = [];
    if (this.bsClient) {
      const allTestCases = await this.bsClient.getAllTestCases();
      if (allTestCases.length > 0) {
        const keywords = KeywordExtractor.extract(
          jiraContext.regressionConcern,
          prAnalysis.affectedAreas,
          prAnalysis.directRisks,
          prAnalysis.indirectRisks,
        );
        matchedTestCases = this.bsClient.search(allTestCases, keywords, 5);
        if (matchedTestCases.length > 0) {
          console.log(`   🎯 ${matchedTestCases.length} BrowserStack test case(s) matched`);
        }
      }
    }

    // 4. Build the result in the same shape as filter mode
    const result = {
      ticketKey:         jiraContext.key || `PR-${pr.number}`,
      ticketSummary:     jiraContext.summary,
      ticketType:        jiraContext.issueType || 'PR',
      status:            jiraContext.status,
      regressionConcern: jiraContext.regressionConcern,
      prLink:            prLink,
      prNumber:          prAnalysis.prNumber || pr.number,
      riskScore:         prAnalysis.riskScore || 0,
      affectedAreas:     prAnalysis.affectedAreas || [],
      changedSymbols:    prAnalysis.changedSymbols || [],
      matchedTestCases,
      prAnalysis,
    };

    return [result];
  }

  /**
   * FILTER MODE: Analyze all CALL tickets from a Jira filter (original flow).
   */
  async analyzeCALLTickets(filterId) {
    console.log(`📊 Analyzing CALL tickets from filter ${filterId}...`);
    const issues = await this.jiraClient.getIssuesByFilter(filterId);

    const allTestCases = this.bsClient ? await this.bsClient.getAllTestCases() : [];

    const results = [];

    for (const issue of issues) {
      try {
        let prLink = this.extractPRLink(issue);
        if (!prLink) {
          prLink = await this.jiraClient.getExternalPRLink(issue.key, issue.id);
          if (prLink) {
            console.log(`   🛠️  Found PR via Integration for ${issue.key}: ${prLink}`);
          } else {
            console.log(`   ⚠️  No PR link found for ${issue.key}`);
          }
        }

        let prAnalysis = this.prAnalyzer._emptyResult();
        if (prLink) {
          const pr = await this.prAnalyzer.getPRFromLink(prLink);
          prAnalysis = await this.prAnalyzer.analyzePR(pr);
        }

        const regressionConcern = issue.fields?.regressionConcern || '';
        if (regressionConcern && !isEmptyValue(regressionConcern)) {
          console.log(`   📝 Regression Concern: "${regressionConcern}"`);
        }

        let matchedTestCases = [];
        if (this.bsClient && allTestCases.length > 0) {
          const keywords = KeywordExtractor.extract(
            regressionConcern,
            prAnalysis.affectedAreas,
            prAnalysis.directRisks,
            prAnalysis.indirectRisks,
          );
          matchedTestCases = this.bsClient.search(allTestCases, keywords, 5);
          if (matchedTestCases.length > 0) {
            console.log(`   🎯 ${matchedTestCases.length} BrowserStack test case(s) matched`);
          }
        }

        results.push({
          ticketKey:         issue.key,
          ticketSummary:     issue.fields?.summary || 'N/A',
          ticketType:        issue.fields?.issuetype?.name || 'Unknown',
          status:            issue.fields?.status?.name || 'Unknown',
          regressionConcern,
          prLink:            prLink || null,
          prNumber:          prAnalysis.prNumber || null,
          riskScore:         prAnalysis.riskScore || 0,
          affectedAreas:     prAnalysis.affectedAreas || [],
          changedSymbols:    prAnalysis.changedSymbols || [],
          matchedTestCases,
          prAnalysis,
        });
      } catch (error) {
        console.log(`   ⚠️  Error analyzing ${issue?.key || 'unknown'}: ${error.message}`);
      }
    }

    return results.sort((a, b) => b.riskScore - a.riskScore);
  }

  extractPRLink(issue) {
    const str = JSON.stringify(issue.fields || {});
    const match = str.match(/https:\/\/github\.com\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/pull\/\d+/i);
    if (match) {
      console.log(`   🔗 Found PR link for ${issue.key}: ${match[0]}`);
      return match[0];
    }
    return null;
  }
}

// ============================================================================
// OUTPUT GENERATOR (CSV — original format)
// ============================================================================

class OutputGenerator {
  static async generate(analysisResults) {
    if (!fs.existsSync(CONFIG.outputDir)) {
      fs.mkdirSync(CONFIG.outputDir, { recursive: true });
    }
    this.generateCSV(analysisResults, path.join(CONFIG.outputDir, 'pr-risk-mapping.csv'));
    console.log(`\n✅ Report: ${CONFIG.outputDir}/pr-risk-mapping.csv`);
    return {
      total:    analysisResults.length,
      highRisk: analysisResults.filter(t => t.riskScore >= 70).length,
    };
  }

  static generateCSV(data, filepath) {
    const headers = [
      'Jira Ticket',
      'Status',
      'PR Link',
      'Risk Score',
      'Regression Area/Concern (Jira Field)',
      'Changed Files (Diffs)',
      'Direct Diff Risks (What Changed & Why It Breaks)',
      'Indirect Risks (Outside the Diffs — Callers & References)',
      'Modified/Removed Symbols',
      'Affected Components',
      'Matched BrowserStack Test Cases',
      'BS Test Case URLs',
    ];

    const escapeCsv = (str) => {
      if (str === null || str === undefined) return '""';
      return `"${String(str).replace(/"/g, '""')}"`;
    };

    const rows = data.map(ticket => {
      const a = ticket.prAnalysis || {};

      const symbols = (ticket.changedSymbols || [])
        .filter(s => s.kind === 'modified' || s.kind === 'removed')
        .map(s => `${s.symbol} (${s.kind})`)
        .join(', ');

      const matchedTCTitles = (ticket.matchedTestCases || [])
        .map(tc => `${tc.identifier}: ${tc.title}`)
        .join('\n');

      const matchedTCUrls = (ticket.matchedTestCases || [])
        .map(tc => `https://test-management.browserstack.com/projects/${CONFIG.browserstack.projectId}/test-cases/${tc.identifier}`)
        .join('\n');

      return [
        ticket.ticketKey,
        ticket.status,
        ticket.prLink || 'No PR Found',
        ticket.riskScore,
        ticket.regressionConcern || '',
        (a.diffSummary || []).join('\n'),
        (a.directRisks || []).join('\n') || 'No structural risks detected',
        (a.indirectRisks || []).join('\n') || 'No external references impacted',
        symbols || 'None extracted',
        (ticket.affectedAreas || []).join(', '),
        matchedTCTitles || 'No matches found',
        matchedTCUrls || '',
      ];
    });

    const csvContent = [headers, ...rows]
      .map(row => row.map(escapeCsv).join(','))
      .join('\n');

    fs.writeFileSync(filepath, csvContent);
  }
}

// ============================================================================
// RISK-TO-SCENARIO MAPPING RULES (UJET domain-specific)
// ============================================================================

const RISK_SCENARIO_RULES = [

  // ── Call State / Progress ──────────────────────────────────────────────
  {
    id: 'CALL_STATE',
    name: 'Call State Machine & Progress Events',
    matchPatterns: {
      symbols: /progress|state_machine|call_status|call_state|transition|event_handler/i,
      risks: /call.*state|progress.*service|state.*transition|status.*display/i,
      files: /progress|state_machine|call_event|call_status/i,
      areas: /Core_Config|API_Routing/,
    },
    scenarios: [
      { title: 'Call status transitions — Inbound call lifecycle', steps: 'Inbound call → Agent answers → Hold → Unhold → End call', verify: 'Verify call status updates in Agent Adapter at each transition (Ringing → Connected → On Hold → Connected → Wrap-up)', priority: 'Critical', category: 'Call State' },
      { title: 'Call status transitions — Warm transfer', steps: 'Inbound call → Agent 1 answers → Warm transfer to Agent 2 → Agent 2 picks up → Agent 1 drops → End call', verify: 'Verify both agents see correct call statuses throughout. Agent 2 adapter shows Connected after pickup.', priority: 'Critical', category: 'Call State' },
      { title: 'Call status transitions — Deflected warm transfer', steps: 'Inbound call → Agent 1 answers → Warm transfer → Transfer deflects (to queue / to agent / to IVR) → End call', verify: 'Verify Agent 1 returns to connected state, call status in adapter reflects deflection correctly', priority: 'Critical', category: 'Call State' },
      { title: 'Call status display — Agent Adapter after upgrade', steps: 'After server upgrade, make inbound call → observe Agent Adapter', verify: 'All call statuses display correctly in Agent Adapter (no blank/missing statuses)', priority: 'High', category: 'Call State' },
    ],
  },

  // ── Agent Joining / Conference ─────────────────────────────────────────
  {
    id: 'AGENT_JOIN',
    name: 'Agent Joining & Conference Logic',
    matchPatterns: {
      symbols: /join|conference|participant|agent.*call|add_agent|connect_agent/i,
      risks: /agent.*join|conference|participant|added.*all.*agents/i,
      files: /conference|participant|agent_call|warm_transfer/i,
      concerns: /agent.*join|transfer|conference/i,
    },
    scenarios: [
      { title: 'Warm transfer — Agent 2 joins correctly', steps: 'Agent 1 on call → Initiate warm transfer to Agent 2 → Agent 2 answers', verify: 'Agent 2 successfully joins conference. Both agents + consumer can hear each other. No audio gaps.', priority: 'Critical', category: 'Transfer' },
      { title: 'Warm transfer — Deflected to queue (all 3 types)', steps: 'Agent 1 on call → Warm transfer → Target agent unavailable → Call deflects to: (a) queue, (b) another agent, (c) IVR', verify: 'For each deflection type: Agent 1 returns to call, consumer hears hold music during deflection, call resumes normally', priority: 'Critical', category: 'Transfer' },
      { title: 'Cold transfer — Agent handoff', steps: 'Agent 1 on call → Cold transfer to Agent 2 → Agent 1 drops immediately', verify: 'Agent 2 receives the call, consumer is connected to Agent 2, no orphaned call legs', priority: 'High', category: 'Transfer' },
      { title: 'Multi-agent conference — 3+ participants', steps: 'Agent 1 on call → Add Agent 2 via warm transfer → Add Agent 3 → Agents leave one by one', verify: 'Each agent join/leave is handled correctly. Recording captures all participants. No call drops.', priority: 'Medium', category: 'Transfer' },
    ],
  },

  // ── Hold Music / Hold Logic ────────────────────────────────────────────
  {
    id: 'HOLD_MUSIC',
    name: 'Hold Music & Hold/Unhold Behavior',
    matchPatterns: {
      symbols: /hold|unhold|moh|music_on_hold|pause|resume/i,
      risks: /hold.*music|on.?hold|pause.*recording|hold.*recording/i,
      files: /hold|moh|music/i,
      concerns: /hold|music|pause|recording.*hold/i,
    },
    scenarios: [
      { title: 'Hold music — Mono recording (Dual Channel OFF)', steps: 'Config: Dual Channel OFF. Inbound call → Agent puts consumer on hold → Unhold → End call', verify: 'Hold music plays for consumer. Recording does NOT contain hold music. Recording has silence or gap during hold.', priority: 'Critical', category: 'Hold Music' },
      { title: 'Hold music — Dual channel recording', steps: 'Config: Dual Channel ON. Inbound call → Agent puts consumer on hold → Unhold → End call', verify: 'Hold music appears ONLY on consumer channel. Agent channel has silence during hold. Both channels resume after unhold.', priority: 'Critical', category: 'Hold Music' },
      { title: 'Hold during warm transfer — deflected', steps: 'Agent 1 on call → Put consumer on hold → Warm transfer → Transfer deflects → Unhold', verify: 'Hold music plays continuously during deflection. Music stops after unhold. No audio glitches.', priority: 'Critical', category: 'Hold Music' },
      { title: 'Hold ON vs Hold OFF during transfer', steps: 'Scenario A: Hold ON before transfer. Scenario B: Direct transfer (no hold). Both with warm transfer.', verify: 'Scenario A: consumer hears hold music during transfer. Scenario B: consumer hears ringing/silence. Both complete successfully.', priority: 'High', category: 'Hold Music' },
      { title: 'Multiple hold/unhold cycles', steps: 'Inbound call → Hold → Unhold → Hold → Unhold → Hold → Unhold → End call', verify: 'Each hold/unhold cycle works correctly. Recording segments are accurate. No accumulated audio delay.', priority: 'Medium', category: 'Hold Music' },
    ],
  },

  // ── Recording / Post-Processing ────────────────────────────────────────
  {
    id: 'RECORDING',
    name: 'Call Recording & Post-Processing',
    matchPatterns: {
      symbols: /recording|post_process|segment|dual_channel|media|storage/i,
      risks: /recording|post.*process|segment|dual.*channel|media.*upload/i,
      files: /recording|media|storage|post_process|dual_channel/i,
      concerns: /recording|segment|dual.*channel|post.*process|storage/i,
    },
    scenarios: [
      { title: 'Recording — Segment OFF + Dual Channel OFF', steps: 'Config: Segment OFF, Dual Channel OFF. Complete a call with warm transfer (2 agents).', verify: 'Single recording file generated. post_process_recordings has 1 entry. File plays back correctly.', priority: 'Critical', category: 'Recording' },
      { title: 'Recording — Segment ON + Dual Channel OFF', steps: 'Config: Segment ON, Dual Channel OFF. Complete a call with warm transfer (2 agents).', verify: 'Separate recording per agent segment. post_process_recordings entries match agent count.', priority: 'Critical', category: 'Recording' },
      { title: 'Recording — Segment OFF + Dual Channel ON', steps: 'Config: Segment OFF, Dual Channel ON. Complete a call with warm transfer.', verify: 'Single dual-channel file. Consumer channel + agent channel present. Hold music only on consumer channel.', priority: 'Critical', category: 'Recording' },
      { title: 'Recording — Segment ON + Dual Channel ON', steps: 'Config: Segment ON, Dual Channel ON. Complete a call with warm transfer.', verify: 'Per-segment dual-channel files. Each segment has consumer + agent channels. Metadata fields correct.', priority: 'Critical', category: 'Recording' },
      { title: 'Post-process metadata validation', steps: 'After any call, query session metadata via Reports > Session Data', verify: 'Verify: id, call_id, duration, started_at, recording_file_name, recording_url, agent_id, virtual_agent_id, conversation_id', priority: 'High', category: 'Recording' },
      { title: 'CRM recording link upload', steps: 'Config: Post call recording link to CRM = ON. Complete call. Wait for CRM upload.', verify: 'CRM record has recording link comment. Link is accessible and plays correct recording.', priority: 'High', category: 'Recording' },
    ],
  },

  // ── VA / AI Escalation ─────────────────────────────────────────────────
  {
    id: 'VA_AI',
    name: 'Virtual Agent & AI Escalation Flows',
    matchPatterns: {
      symbols: /virtual_agent|va_|ai_|escalat|progress_service|attempt_return|dialogflow|ccai/i,
      risks: /virtual.*agent|VA.*escalat|progress.*service|AI.*flow|attempt_return/i,
      files: /virtual_agent|va_|ai_|escalat|dialogflow|ccai/i,
      concerns: /virtual.*agent|VA|AI|escalat|CCAI/i,
    },
    scenarios: [
      { title: 'VA to Human Agent escalation — basic flow', steps: 'Consumer enters VA flow → VA escalates to human agent queue → Agent picks up', verify: 'Escalation completes. Agent receives full context. Call recording captures VA + HA segments.', priority: 'Critical', category: 'VA/AI' },
      { title: 'VA escalation — agent puts consumer on hold after escalation', steps: 'VA escalation to HA → Agent answers → Agent puts consumer on hold → Unhold → End call', verify: 'Hold music works correctly after VA escalation. Recording handles VA→HA transition + hold.', priority: 'High', category: 'VA/AI' },
      { title: 'VA escalation — warm transfer after VA handoff', steps: 'VA escalates to Agent 1 → Agent 1 warm transfers to Agent 2 → Complete call', verify: 'Transfer works after VA escalation. ProgressService handles state correctly. No method errors.', priority: 'High', category: 'VA/AI' },
      { title: 'VA return to queue — attempt_return_end_user_to_queue', steps: 'VA flow → Attempt to return end user to queue → Queue routes to agent', verify: 'No NoMethodError. Consumer is successfully returned to queue. Agent receives call.', priority: 'Critical', category: 'VA/AI' },
    ],
  },

  // ── Method Signature / Symbol Changes ──────────────────────────────────
  {
    id: 'METHOD_CHANGE',
    name: 'Method Signature & API Contract Changes',
    matchPatterns: {
      risks: /signature.*changed|was removed|callers.*break|compatibility/i,
    },
    scenarios: [
      { title: 'Verify all callers of changed methods', steps: 'For each modified/removed symbol: identify all calling code paths → execute those paths end-to-end', verify: 'No NoMethodError, ArgumentError, or unexpected behavior in any calling path', priority: 'Critical', category: 'Code Impact' },
      { title: 'Service-to-service contract validation', steps: 'If changed methods are in shared services: test all consuming services independently', verify: 'Each consuming service handles the new method signature/behavior correctly', priority: 'High', category: 'Code Impact' },
    ],
  },

  // ── Error Handling Changes ─────────────────────────────────────────────
  {
    id: 'ERROR_HANDLING',
    name: 'Error Handling & Exception Flow',
    matchPatterns: {
      risks: /error handling removed|exception.*propagat|rescue|catch/i,
    },
    scenarios: [
      { title: 'Error path testing — network failure during call', steps: 'Simulate network interruption during active call (consumer or agent side)', verify: 'Graceful degradation. No unhandled exceptions. Call terminates cleanly or reconnects.', priority: 'High', category: 'Error Handling' },
      { title: 'Error path testing — invalid input to modified methods', steps: 'Send edge case / nil / empty inputs to modified API endpoints or service methods', verify: 'Proper error responses returned. No 500 errors. No data corruption.', priority: 'Medium', category: 'Error Handling' },
    ],
  },

  // ── Background Jobs / Async ────────────────────────────────────────────
  {
    id: 'BACKGROUND_JOBS',
    name: 'Background Workers & Async Processing',
    matchPatterns: {
      symbols: /worker|sidekiq|job|async|queue|perform/i,
      risks: /worker|job|queue|async|background|retry|idempotency/i,
      files: /worker|job|sidekiq/i,
    },
    scenarios: [
      { title: 'Post-call processing job — recording upload', steps: 'Complete call → Wait for background job to process recording → Check storage', verify: 'Recording uploaded to external storage. Job completes without retry loops. File is accessible.', priority: 'High', category: 'Background Jobs' },
      { title: 'CRM metadata upload job — after call completion', steps: 'Complete call with CRM integration active → Wait for metadata upload', verify: 'CRM receives correct metadata. Job is idempotent (running twice doesn\'t duplicate data).', priority: 'Medium', category: 'Background Jobs' },
    ],
  },

  // ── Database / Migration ───────────────────────────────────────────────
  {
    id: 'DATABASE',
    name: 'Database & Schema Changes',
    matchPatterns: {
      risks: /migration|schema|column|table|database.*query|N\+1/i,
      files: /migrate|schema|db\//i,
      areas: /Database_Models/,
    },
    scenarios: [
      { title: 'Data integrity after migration', steps: 'Run migration → Query affected tables → Verify data', verify: 'Existing records are intact. New columns have correct defaults. No orphaned records.', priority: 'Critical', category: 'Database' },
      { title: 'Rollback safety', steps: 'Apply migration → Roll back → Verify application still works on old schema', verify: 'Rollback completes without data loss. Application functions correctly on prior schema version.', priority: 'High', category: 'Database' },
    ],
  },

  // ── Provider-Specific ──────────────────────────────────────────────────
  {
    id: 'VOIP_PROVIDER',
    name: 'VoIP Provider-Specific Behavior',
    matchPatterns: {
      symbols: /twilio|telnyx|nexmo|vonage|provider|telephony/i,
      risks: /provider|twilio|telnyx|nexmo|telephony/i,
      files: /twilio|telnyx|nexmo|provider|telephony/i,
      concerns: /provider|twilio|telnyx|nexmo/i,
    },
    scenarios: [
      { title: 'Cross-provider call flow — Twilio', steps: 'Use Twilio provider → Complete full call flow (inbound → hold → transfer → end)', verify: 'All call events handled correctly for Twilio. Recording files generated. Hold music works.', priority: 'High', category: 'Provider' },
      { title: 'Cross-provider call flow — Telnyx', steps: 'Use Telnyx provider → Complete full call flow (inbound → hold → transfer → end)', verify: 'All call events handled correctly for Telnyx. Recording files generated. Hold music works.', priority: 'High', category: 'Provider' },
      { title: 'Cross-provider call flow — Nexmo', steps: 'Use Nexmo provider → Complete full call flow (inbound → hold → transfer → end)', verify: 'All call events handled correctly for Nexmo. Recording files generated. Hold music works.', priority: 'Medium', category: 'Provider' },
    ],
  },

  // ── CRM Integration ────────────────────────────────────────────────────
  {
    id: 'CRM',
    name: 'CRM Integration & Metadata',
    matchPatterns: {
      symbols: /crm|zendesk|salesforce|kustomer|freshdesk|hubspot|servicenow/i,
      risks: /CRM|zendesk|salesforce|metadata.*upload/i,
      files: /crm|zendesk|salesforce|kustomer|freshdesk/i,
      concerns: /CRM|zendesk|salesforce/i,
    },
    scenarios: [
      { title: 'CRM metadata upload — Zendesk', steps: 'Complete call with Zendesk CRM active → Wait for metadata upload', verify: 'Ticket created/updated in Zendesk. Recording link posted as comment. All fields populated.', priority: 'High', category: 'CRM' },
      { title: 'CRM metadata upload — Salesforce', steps: 'Complete call with Salesforce CRM active → Wait for metadata upload', verify: 'Case/record updated in Salesforce. Recording link accessible. Custom fields mapped correctly.', priority: 'High', category: 'CRM' },
    ],
  },

  // ── Route / API Changes ────────────────────────────────────────────────
  {
    id: 'API_ROUTES',
    name: 'API Endpoint & Route Changes',
    matchPatterns: {
      risks: /route.*changed|endpoint|API.*contract|mobile.*client/i,
      files: /routes|controller|api\//i,
      areas: /API_Routing/,
    },
    scenarios: [
      { title: 'API backward compatibility — mobile clients', steps: 'Use older mobile SDK version → Make API calls to changed endpoints', verify: 'Older clients still receive valid responses. No breaking changes in response shape.', priority: 'Critical', category: 'API' },
      { title: 'API backward compatibility — Agent Adapter', steps: 'Use Agent Adapter → Exercise all changed API endpoints during normal call flow', verify: 'Adapter functions correctly. No missing data or broken UI elements.', priority: 'High', category: 'API' },
    ],
  },
];

// ============================================================================
// RISK MAP GENERATOR
// ============================================================================

class RiskMapGenerator {

  static generate(analysisResults) {
    if (!fs.existsSync(CONFIG.outputDir)) {
      fs.mkdirSync(CONFIG.outputDir, { recursive: true });
    }

    const ticketScenarios = [];

    for (const ticket of analysisResults) {
      const matched = this._matchRules(ticket);
      ticketScenarios.push({
        ticket,
        matchedRules: matched.rules,
        scenarios: matched.scenarios,
        coverageGaps: matched.gaps,
      });
    }

    const riskMapMd = this._generateRiskMapMarkdown(ticketScenarios);
    const scenarioCsv = this._generateScenarioCSV(ticketScenarios);
    const bsCsv = this._generateBrowserStackCSV(ticketScenarios);
    const summary = this._generateSummary(ticketScenarios);

    const riskMapPath = path.join(CONFIG.outputDir, 'regression-risk-map.md');
    const scenarioPath = path.join(CONFIG.outputDir, 'recommended-test-scenarios.csv');
    const bsPath = path.join(CONFIG.outputDir, 'browserstack-regression-scenarios.csv');

    fs.writeFileSync(riskMapPath, riskMapMd);
    fs.writeFileSync(scenarioPath, scenarioCsv);
    fs.writeFileSync(bsPath, bsCsv);

    console.log(`\n📊 Risk Map generated:`);
    console.log(`   📄 ${riskMapPath}`);
    console.log(`   📋 ${scenarioPath}`);
    console.log(`   🎯 ${bsPath} (BrowserStack-ready)`);
    console.log(summary);

    return { riskMapPath, scenarioPath, bsPath, ticketScenarios };
  }

  static _matchRules(ticket) {
    const pr = ticket.prAnalysis || {};
    const matchedRules = [];
    const allScenarios = [];
    const matchedRuleIds = new Set();

    const symbolText = (ticket.changedSymbols || []).map(s => s.symbol).join(' ');
    const riskText = [...(pr.directRisks || []), ...(pr.indirectRisks || [])].join(' ');
    const fileText = (pr.diffSummary || []).join(' ');
    const areaText = (ticket.affectedAreas || []).join(' ');
    const concernText = ticket.regressionConcern || '';

    for (const rule of RISK_SCENARIO_RULES) {
      const mp = rule.matchPatterns;
      let matched = false;

      if (mp.symbols && mp.symbols.test(symbolText)) matched = true;
      if (mp.risks && mp.risks.test(riskText)) matched = true;
      if (mp.files && mp.files.test(fileText)) matched = true;
      if (mp.areas && mp.areas.test(areaText)) matched = true;
      if (mp.concerns && mp.concerns.test(concernText)) matched = true;

      if (matched && !matchedRuleIds.has(rule.id)) {
        matchedRuleIds.add(rule.id);
        matchedRules.push(rule);
        for (const scenario of rule.scenarios) {
          allScenarios.push({
            ...scenario,
            sourceRule: rule.id,
            sourceRuleName: rule.name,
            sourceTicket: ticket.ticketKey,
            ticketRiskScore: ticket.riskScore,
          });
        }
      }
    }

    const gaps = [];
    if (pr.directRisks) {
      for (const risk of pr.directRisks) {
        const covered = matchedRules.some(r => {
          const mp = r.matchPatterns;
          return (mp.risks && mp.risks.test(risk));
        });
        if (!covered) {
          gaps.push({ type: 'uncovered_risk', detail: risk, ticket: ticket.ticketKey });
        }
      }
    }

    return { rules: matchedRules, scenarios: allScenarios, gaps };
  }

  static _generateRiskMapMarkdown(ticketScenarios) {
    const lines = [];
    const now = new Date().toISOString().split('T')[0];

    lines.push(`# Regression Risk Map`);
    lines.push(`Generated: ${now}\n`);

    lines.push(`## Executive Summary\n`);

    const allTickets = ticketScenarios.map(ts => ts.ticket);
    const critical = allTickets.filter(t => t.riskScore >= 70);
    const high = allTickets.filter(t => t.riskScore >= 50 && t.riskScore < 70);
    const medium = allTickets.filter(t => t.riskScore >= 30 && t.riskScore < 50);
    const low = allTickets.filter(t => t.riskScore < 30);

    lines.push(`| Risk Level | Count | Tickets |`);
    lines.push(`|------------|-------|---------|`);
    lines.push(`| 🔴 Critical (70-100) | ${critical.length} | ${critical.map(t => t.ticketKey).join(', ') || 'None'} |`);
    lines.push(`| 🟠 High (50-69) | ${high.length} | ${high.map(t => t.ticketKey).join(', ') || 'None'} |`);
    lines.push(`| 🟡 Medium (30-49) | ${medium.length} | ${medium.map(t => t.ticketKey).join(', ') || 'None'} |`);
    lines.push(`| 🟢 Low (0-29) | ${low.length} | ${low.map(t => t.ticketKey).join(', ') || 'None'} |`);
    lines.push('');

    const allScenarios = ticketScenarios.flatMap(ts => ts.scenarios);
    const uniqueScenarios = this._deduplicateScenarios(allScenarios);

    lines.push(`**Total unique test scenarios recommended:** ${uniqueScenarios.length}\n`);

    lines.push(`## Per-Ticket Risk Breakdown\n`);

    for (const ts of ticketScenarios) {
      const t = ts.ticket;
      const icon = t.riskScore >= 70 ? '🔴' : t.riskScore >= 50 ? '🟠' : t.riskScore >= 30 ? '🟡' : '🟢';
      const pr = t.prAnalysis || {};

      lines.push(`### ${icon} ${t.ticketKey} — Score: ${t.riskScore}/100\n`);
      lines.push(`**Summary:** ${t.ticketSummary || 'N/A'}`);
      lines.push(`**Status:** ${t.status}`);
      if (t.prLink) lines.push(`**PR:** ${t.prLink}`);
      if (t.regressionConcern) lines.push(`**Regression Concern:** ${t.regressionConcern}`);
      lines.push('');

      if (pr.diffSummary?.length) {
        lines.push(`**Changed Files:**`);
        for (const f of pr.diffSummary.slice(0, 10)) lines.push(`- \`${f}\``);
        lines.push('');
      }
      if (pr.directRisks?.length) {
        lines.push(`**Direct Risks:**`);
        for (const r of pr.directRisks) lines.push(`- ${r}`);
        lines.push('');
      }
      if (pr.indirectRisks?.length) {
        lines.push(`**Indirect Risks (callers outside the diff):**`);
        for (const r of pr.indirectRisks) lines.push(`- ${r}`);
        lines.push('');
      }
      if (ts.matchedRules.length) {
        lines.push(`**Risk Categories Triggered:**`);
        for (const rule of ts.matchedRules) lines.push(`- ${rule.name} (\`${rule.id}\`)`);
        lines.push('');
      }
      if (ts.scenarios.length) {
        lines.push(`**Recommended Test Scenarios:**\n`);
        lines.push(`| # | Scenario | Priority | Category |`);
        lines.push(`|---|----------|----------|----------|`);
        ts.scenarios.forEach((s, i) => lines.push(`| ${i + 1} | ${s.title} | ${s.priority} | ${s.category} |`));
        lines.push('');
      }
      if (t.matchedTestCases?.length) {
        lines.push(`**Existing BrowserStack Test Cases:**`);
        for (const tc of t.matchedTestCases) lines.push(`- ${tc.identifier}: ${tc.title} (score: ${tc.score})`);
        lines.push('');
      }
      if (ts.coverageGaps.length) {
        lines.push(`**⚠️ Uncovered Risks (no matching scenario rule):**`);
        for (const gap of ts.coverageGaps) lines.push(`- ${gap.detail}`);
        lines.push('');
      }
      lines.push('---\n');
    }

    // Consolidated list
    lines.push(`## Consolidated Test Scenario List\n`);
    lines.push(`Deduplicated across all tickets, sorted by priority.\n`);
    const priorityOrder = { Critical: 0, High: 1, Medium: 2, Low: 3 };
    uniqueScenarios.sort((a, b) => (priorityOrder[a.priority] ?? 99) - (priorityOrder[b.priority] ?? 99));
    lines.push(`| # | Scenario | Priority | Category | Source Ticket(s) |`);
    lines.push(`|---|----------|----------|----------|-----------------|`);
    uniqueScenarios.forEach((s, i) => lines.push(`| ${i + 1} | ${s.title} | ${s.priority} | ${s.category} | ${s.sourceTickets.join(', ')} |`));
    lines.push('');

    // Execution guide
    lines.push(`## Execution Priority Guide\n`);
    lines.push(`### Phase 1: Smoke (Critical scenarios only)`);
    lines.push(`Run these first to catch show-stoppers:\n`);
    uniqueScenarios.filter(s => s.priority === 'Critical').forEach((s, i) => lines.push(`${i + 1}. **${s.title}** — ${s.verify}`));
    lines.push('');
    lines.push(`### Phase 2: Core Regression (High priority)`);
    lines.push(`Run after smoke passes:\n`);
    uniqueScenarios.filter(s => s.priority === 'High').forEach((s, i) => lines.push(`${i + 1}. **${s.title}** — ${s.verify}`));
    lines.push('');
    lines.push(`### Phase 3: Extended Coverage (Medium/Low priority)`);
    lines.push(`Run if time permits:\n`);
    uniqueScenarios.filter(s => s.priority === 'Medium' || s.priority === 'Low').forEach((s, i) => lines.push(`${i + 1}. **${s.title}** — ${s.verify}`));
    lines.push('');

    return lines.join('\n');
  }

  static _generateScenarioCSV(ticketScenarios) {
    const headers = ['Source Ticket','Risk Score','Rule ID','Rule Name','Priority','Category','Scenario Title','Steps','Verification'];
    const rows = [];
    for (const ts of ticketScenarios) {
      for (const s of ts.scenarios) {
        rows.push([s.sourceTicket, s.ticketRiskScore, s.sourceRule, s.sourceRuleName, s.priority, s.category, s.title, s.steps, s.verify]);
      }
    }
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    return [headers, ...rows].map(r => r.map(esc).join(',')).join('\n');
  }

  static _generateBrowserStackCSV(ticketScenarios) {
    const headers = ['Test Case ID','Title','Folder ID','Folder Path','State','Owner','Priority','Type of Test Case','Automation Status','Description','Preconditions','Template','Steps','Expected Result','Issues','Tags'];
    const allScenarios = this._deduplicateScenarios(ticketScenarios.flatMap(ts => ts.scenarios));
    const priorityOrder = { Critical: 0, High: 1, Medium: 2, Low: 3 };
    allScenarios.sort((a, b) => (priorityOrder[a.priority] ?? 99) - (priorityOrder[b.priority] ?? 99));

    const rows = [];
    const esc = (v) => {
      const s = String(v ?? '');
      return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    for (const scenario of allScenarios) {
      const stepParts = scenario.steps.split(/→|➜|->/).map(s => s.trim()).filter(Boolean);
      const verifyParts = scenario.verify.split(/\.\s+/).map(s => s.trim()).filter(Boolean);

      rows.push([
        '', `[${scenario.category}] ${scenario.title}`,
        CONFIG.browserstack.targetFolderId, CONFIG.browserstack.folderPath,
        'Active', 'Ryan Dedumo', scenario.priority, 'Functional', 'Not Automated',
        `Auto-generated regression scenario from risk analysis. Source: ${scenario.sourceTickets.join(', ')}`,
        '', 'Steps', stepParts[0] || scenario.steps, verifyParts[0] || scenario.verify,
        scenario.sourceTickets.join(', '),
        `regression,risk-map,${scenario.category.toLowerCase().replace(/[/ ]/g, '-')}`,
      ]);

      for (let i = 1; i < stepParts.length; i++) {
        const contRow = new Array(headers.length).fill('');
        contRow[12] = stepParts[i];
        contRow[13] = verifyParts[i] || '';
        rows.push(contRow);
      }
      for (let i = stepParts.length; i < verifyParts.length; i++) {
        const contRow = new Array(headers.length).fill('');
        contRow[12] = 'Verify the result';
        contRow[13] = verifyParts[i];
        rows.push(contRow);
      }
    }

    return [headers.map(esc), ...rows.map(r => r.map(esc))].join('\n');
  }

  static _deduplicateScenarios(scenarios) {
    const map = new Map();
    for (const s of scenarios) {
      if (map.has(s.title)) {
        const existing = map.get(s.title);
        if (!existing.sourceTickets.includes(s.sourceTicket)) existing.sourceTickets.push(s.sourceTicket);
        const prio = { Critical: 0, High: 1, Medium: 2, Low: 3 };
        if ((prio[s.priority] ?? 99) < (prio[existing.priority] ?? 99)) existing.priority = s.priority;
      } else {
        map.set(s.title, { ...s, sourceTickets: [s.sourceTicket] });
      }
    }
    return Array.from(map.values());
  }

  static _generateSummary(ticketScenarios) {
    const allScenarios = this._deduplicateScenarios(ticketScenarios.flatMap(ts => ts.scenarios));
    const byPriority = { Critical: 0, High: 0, Medium: 0, Low: 0 };
    for (const s of allScenarios) byPriority[s.priority] = (byPriority[s.priority] || 0) + 1;
    const gaps = ticketScenarios.flatMap(ts => ts.coverageGaps);

    return `
📊 Risk Map Summary:
   Tickets analyzed:     ${ticketScenarios.length}
   Scenarios generated:  ${allScenarios.length}
     🔴 Critical: ${byPriority.Critical}
     🟠 High:     ${byPriority.High}
     🟡 Medium:   ${byPriority.Medium}
     🟢 Low:      ${byPriority.Low}
   Coverage gaps:        ${gaps.length}`;
  }
}

// ============================================================================
// CSV INPUT PARSER (for --risk-map-only mode)
// ============================================================================

class CSVInputParser {
  static parse(csvPath) {
    const content = fs.readFileSync(csvPath, 'utf-8');
    const rows = this._parseCSVRows(content);
    if (rows.length < 2) throw new Error('CSV file is empty or has only headers');

    const results = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row[0]) continue;
      results.push({
        ticketKey: row[0] || '',
        ticketSummary: '',
        status: row[1] || '',
        prLink: row[2] === 'No PR Found' ? null : row[2],
        riskScore: parseInt(row[3]) || 0,
        regressionConcern: row[4] || '',
        affectedAreas: (row[9] || '').split(',').map(a => a.trim()).filter(Boolean),
        changedSymbols: (row[8] || '').split(',').map(s => {
          const match = s.trim().match(/^(.+?)\s*\((\w+)\)$/);
          return match ? { symbol: match[1], kind: match[2] } : null;
        }).filter(Boolean),
        matchedTestCases: [],
        prAnalysis: {
          diffSummary: (row[5] || '').split('\n').filter(Boolean),
          directRisks: (row[6] || '').split('\n').filter(Boolean),
          indirectRisks: (row[7] || '').split('\n').filter(Boolean),
        },
      });
    }
    return results;
  }

  static _parseCSVRows(content) {
    const rows = [];
    let currentRow = [];
    let currentField = '';
    let inQuotes = false;
    let i = 0;

    while (i < content.length) {
      const char = content[i];
      if (inQuotes) {
        if (char === '"') {
          if (content[i + 1] === '"') { currentField += '"'; i += 2; }
          else { inQuotes = false; i++; }
        } else { currentField += char; i++; }
      } else {
        if (char === '"') { inQuotes = true; i++; }
        else if (char === ',') { currentRow.push(currentField); currentField = ''; i++; }
        else if (char === '\n' || (char === '\r' && content[i + 1] === '\n')) {
          currentRow.push(currentField); rows.push(currentRow); currentRow = []; currentField = '';
          i += (char === '\r' ? 2 : 1);
        } else { currentField += char; i++; }
      }
    }
    if (currentField || currentRow.length) { currentRow.push(currentField); rows.push(currentRow); }
    return rows;
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  try {
    console.log('🚀 UJET Regression Risk Analyzer v3.0\n');

    const args = process.argv.slice(2);
    const input = parseInput(args[0]);

    // ── Risk-Map-Only Mode ──
    if (input.type === 'risk-map-only') {
      console.log('📊 Risk Map Only mode — regenerating from existing CSV...\n');
      const csvPath = path.join(CONFIG.outputDir, 'pr-risk-mapping.csv');
      if (!fs.existsSync(csvPath)) {
        throw new Error(`No CSV found at ${csvPath}. Run the full analysis first.`);
      }
      const analysisResults = CSVInputParser.parse(csvPath);
      RiskMapGenerator.generate(analysisResults);
      return;
    }

    // Validate credentials
    if (!CONFIG.github.token) throw new Error('Missing GitHub token (GITHUB_TOKEN).');

    const prAnalyzer = new GitHubPRAnalyzer(CONFIG.github.token);

    const jiraClient = (CONFIG.jira.email && CONFIG.jira.apiToken)
      ? new JiraClient(CONFIG.jira.baseUrl, CONFIG.jira.email, CONFIG.jira.apiToken)
      : null;

    const bsClient = (CONFIG.browserstack.username && CONFIG.browserstack.accessKey)
      ? new BrowserStackClient(
          CONFIG.browserstack.username,
          CONFIG.browserstack.accessKey,
          CONFIG.browserstack.projectIdentifier,
          CONFIG.browserstack.folderId,
        )
      : null;

    if (!jiraClient) console.log('⚠️  Jira credentials not set — Jira context lookup disabled.');
    if (!bsClient)   console.log('⚠️  BrowserStack credentials not set — test case matching disabled.\n');

    const regressionAnalyzer = new RegressionAnalyzer(jiraClient, prAnalyzer, bsClient);

    let analysisResults;

    // ── PR Mode ──
    if (input.type === 'pr') {
      console.log(`📌 Mode: Single PR Analysis`);
      analysisResults = await regressionAnalyzer.analyzeSinglePR(input.value);

    // ── Filter Mode ──
    } else {
      if (!jiraClient) throw new Error('Missing Jira credentials (JIRA_EMAIL, JIRA_API_TOKEN) for filter mode.');
      console.log(`📌 Mode: Jira Filter Batch Analysis`);
      const filterId = input.value || CONFIG.jira.filterId;
      console.log(`🔗 Filter ID: ${filterId}`);
      analysisResults = await regressionAnalyzer.analyzeCALLTickets(filterId);
    }

    if (!analysisResults || analysisResults.length === 0) {
      console.log('\n⚠️  No results to analyze.');
      return;
    }

    // Generate CSV report (original format)
    const stats = await OutputGenerator.generate(analysisResults);

    console.log('\n📈 Analysis Summary:');
    console.log(`   Total tickets/PRs analyzed: ${stats.total}`);
    console.log(`   Critical/High risk (score ≥ 70): ${stats.highRisk}`);

    // Generate Risk Map + Scenarios
    RiskMapGenerator.generate(analysisResults);

    // Console output
    if (stats.highRisk > 0) {
      console.log('\n⚠️  HIGH-RISK ITEMS:');
      analysisResults
        .filter(t => t.riskScore >= 70)
        .slice(0, 5)
        .forEach(t => console.log(`   ${t.ticketKey}: ${t.ticketSummary} (Score: ${t.riskScore})`));
    }

    console.log('\n📋 All Results:');
    analysisResults.forEach(ticket => {
      const icon = ticket.riskScore >= 70 ? '🔴' : ticket.riskScore >= 50 ? '🟠' : ticket.riskScore >= 30 ? '🟡' : '🟢';
      console.log(`   ${icon} ${ticket.ticketKey} [Score: ${ticket.riskScore}] — ${ticket.ticketSummary}`);
      if (ticket.regressionConcern && !isEmptyValue(ticket.regressionConcern)) {
        console.log(`      📝 Concern: ${ticket.regressionConcern}`);
      }
      const a = ticket.prAnalysis;
      if (a?.directRisks?.length)   a.directRisks.slice(0, 2).forEach(r => console.log(`      ⚑ ${r}`));
      if (a?.indirectRisks?.length) a.indirectRisks.slice(0, 2).forEach(r => console.log(`      ↳ ${r}`));
      if (ticket.matchedTestCases?.length) {
        console.log(`      🎯 Test cases to run:`);
        ticket.matchedTestCases.forEach(tc => console.log(`         • ${tc.identifier}: ${tc.title}`));
      }
    });

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  JiraClient,
  BrowserStackClient,
  KeywordExtractor,
  DiffSymbolExtractor,
  DiffRiskAnalyzer,
  GitHubPRAnalyzer,
  RegressionAnalyzer,
  RiskMapGenerator,
  CSVInputParser,
  OutputGenerator,
  RISK_SCENARIO_RULES,
  adfToText,
  isEmptyValue,
  parseInput,
};
