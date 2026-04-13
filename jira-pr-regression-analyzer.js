/**
 * JIRA PR Regression Risk Analyzer
 * Extracts CALL tickets, analyzes PRs for regression risks, maps to BrowserStack test cases.
 *
 * Requirements:
 * - npm install axios dotenv
 * - Environment variables: JIRA_EMAIL, JIRA_API_TOKEN, GITHUB_TOKEN,
 *                          BROWSERSTACK_USERNAME, BROWSERSTACK_ACCESS_KEY
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
    projectIdentifier: 'PR-25',   // "Regression Suite" project
    folderId: '30446438',          // Regression Suite root folder
    fetchLimit: 2000,              // Max test cases to load into memory
  },
  outputDir: './regression-analysis-output',
};

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Recursively extracts plain text from Atlassian Document Format (ADF) JSON.
 * Returns empty string for non-ADF values.
 */
function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;

  if (node.type === 'text') return node.text || '';
  if (Array.isArray(node.content)) {
    return node.content.map(adfToText).join(' ').replace(/\s+/g, ' ').trim();
  }
  return '';
}

/**
 * Returns true if the text is a placeholder/null value (N/A, none, -, etc.)
 */
function isEmptyValue(text) {
  return /^\s*(-+|n\/a|none|null|not applicable|tbd|na)\s*$/i.test(text.trim());
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
            // Include the Regression Area/Concern custom field (customfield_11041)
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
          // Regression Area/Concern field (ADF format)
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
    this._cache = null; // All fetched test cases
  }

  /**
   * Fetches test cases from the Regression Suite folder (paginated).
   * Results are cached after the first call.
   */
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

  /**
   * Scores and returns the top N test cases that best match the given keywords.
   * Scoring:
   *   - Exact phrase match in title: +10
   *   - Single keyword match in title: +3
   *   - Keyword match in a tag: +4
   *   - Keyword match in description/preconditions: +1
   */
  search(testCases, keywords, topN = 5) {
    if (!keywords.length || !testCases.length) return [];

    // Normalise keywords: filter blanks, deduplicate, lowercase
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

      // Bonus for multi-word phrase match
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
        url: `https://test-management.browserstack.com/projects/${CONFIG.browserstack.folderId.replace('30446438', '2986649')}/test-cases/${s.tc.identifier}`,
      }));
  }
}

// Common stop words to skip during keyword matching
const STOP_WORDS = new Set([
  'the','and','for','are','was','not','but','with','that','this','from',
  'they','have','had','all','been','when','will','also','its','can','may',
  'test','case','verify','check','ensure','should','must','given','then',
  'new','add','added','updated','removed','changed','fix','fixed',
]);

// ============================================================================
// KEYWORD EXTRACTOR
// Pulls search terms from all regression signals for a ticket.
// ============================================================================

class KeywordExtractor {
  /**
   * Derives search keywords from a ticket's regression concern text,
   * affected areas, direct risks, and indirect risks.
   */
  static extract(regressionConcern, affectedAreas, directRisks, indirectRisks) {
    const keywords = new Set();

    // 1. Regression Area/Concern field (highest signal)
    if (regressionConcern && !isEmptyValue(regressionConcern)) {
      // Keep the full phrase
      keywords.add(regressionConcern.trim());
      // Also add individual meaningful words
      regressionConcern
        .split(/[\s/,;]+/)
        .map(w => w.trim())
        .filter(w => w.length >= 3 && !STOP_WORDS.has(w.toLowerCase()))
        .forEach(w => keywords.add(w));
    }

    // 2. Affected areas → domain-specific terms
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

    // 3. Extract nouns from risk descriptions (words ≥ 5 chars, CamelCase or regular)
    const allRiskText = [...(directRisks || []), ...(indirectRisks || [])].join(' ');
    allRiskText
      .replace(/\[.*?\]/g, '')          // strip severity labels like [HIGH]
      .split(/\s+/)
      .map(w => w.replace(/[^\w]/g, ''))
      .filter(w => w.length >= 5 && !STOP_WORDS.has(w.toLowerCase()))
      .forEach(w => keywords.add(w));

    return Array.from(keywords).slice(0, 20); // cap at 20 keywords per ticket
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
    // Cache symbol search results — avoids re-querying the same symbol across multiple PRs
    this._symbolCache = new Map();
  }

  async getPRFromLink(prLink) {
    try {
      const match = prLink.match(/github\.com\/(.+?)\/(.+?)\/pull\/(\d+)/);
      if (!match) return null;
      const [, owner, repo, prNumber] = match;
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
      await new Promise(r => setTimeout(r, 1500)); // GitHub search: 30 req/min limit
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

    // --- Step 1: Fetch base content + direct risk analysis (all files in parallel) ---
    // Skip fetching base content for test/spec files — their diffs don't need it for risk analysis
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

    // --- Step 2: Search for outside-diff references to modified/removed symbols ---
    // Symbols are searched sequentially (GitHub search rate limit), but reference
    // file contents are fetched in parallel once we have the paths.
    const indirectRisks = [];
    const symbolsToSearch = allChangedSymbols
      .filter(s => (s.kind === 'modified' || s.kind === 'removed') && s.symbol.length >= 3)
      .slice(0, 3); // cap at 3 to stay well within GitHub search rate limit

    for (const { symbol, kind, file: sourceFile } of symbolsToSearch) {
      const refPaths = await this.searchSymbolInRepo(owner, repo, symbol, changedPathSet);
      if (refPaths.length > 0) {
        console.log(`   🔎 "${symbol}" (${kind} in ${path.basename(sourceFile)}): referenced in ${refPaths.length} file(s) outside PR`);

        // Fetch all reference file contents in parallel
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

  async analyzeCALLTickets(filterId) {
    console.log(`📊 Analyzing CALL tickets from filter ${filterId}...`);
    const issues = await this.jiraClient.getIssuesByFilter(filterId);

    // Pre-load all BrowserStack test cases once (avoids repeated API calls per ticket)
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

        // Search BrowserStack for test cases matching this ticket's risks
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
// OUTPUT GENERATOR
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
        .map(tc => `https://test-management.browserstack.com/projects/2986649/test-cases/${tc.identifier}`)
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
// MAIN
// ============================================================================

async function main() {
  try {
    console.log('🚀 Starting JIRA PR Regression Analysis\n');

    const args = process.argv.slice(2);
    let filterId = CONFIG.jira.filterId;

    if (args.length > 0) {
      const match = args[0].match(/filter=(\d+)/);
      if (match) {
        filterId = match[1];
        console.log(`🔗 Extracted Filter ID: ${filterId} from provided URL.`);
      } else {
        console.log(`⚠️  Could not find 'filter=XYZ' in the URL. Using default: ${filterId}`);
      }
    } else {
      console.log(`ℹ️  No URL provided. Using default filter ID: ${filterId}`);
    }

    if (!CONFIG.jira.email || !CONFIG.jira.apiToken) throw new Error('Missing JIRA credentials.');
    if (!CONFIG.github.token) throw new Error('Missing GitHub token.');

    const bsClient = (CONFIG.browserstack.username && CONFIG.browserstack.accessKey)
      ? new BrowserStackClient(
          CONFIG.browserstack.username,
          CONFIG.browserstack.accessKey,
          CONFIG.browserstack.projectIdentifier,
          CONFIG.browserstack.folderId,
        )
      : null;

    if (!bsClient) {
      console.log('⚠️  BrowserStack credentials not set — test case matching disabled.\n');
    }

    const jiraClient        = new JiraClient(CONFIG.jira.baseUrl, CONFIG.jira.email, CONFIG.jira.apiToken);
    const prAnalyzer        = new GitHubPRAnalyzer(CONFIG.github.token);
    const regressionAnalyzer = new RegressionAnalyzer(jiraClient, prAnalyzer, bsClient);

    const analysisResults = await regressionAnalyzer.analyzeCALLTickets(filterId);
    const stats = await OutputGenerator.generate(analysisResults);

    console.log('\n📈 Analysis Summary:');
    console.log(`   Total CALL tickets analyzed: ${stats.total}`);
    console.log(`   Critical/High risk PRs (score ≥ 70): ${stats.highRisk}`);

    if (stats.highRisk > 0) {
      console.log('\n⚠️  HIGH-RISK TICKETS:');
      analysisResults
        .filter(t => t.riskScore >= 70)
        .slice(0, 5)
        .forEach(t => console.log(`   ${t.ticketKey}: ${t.ticketSummary} (Score: ${t.riskScore})`));
    }

    console.log('\n📋 All Tickets:');
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
  OutputGenerator,
  adfToText,
  isEmptyValue,
};
