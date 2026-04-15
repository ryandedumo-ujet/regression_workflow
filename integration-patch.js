/**
 * INTEGRATION PATCH
 *
 * Apply this to jira-pr-regression-analyzer.js to automatically invoke
 * the Risk Map Generator after analysis completes.
 *
 * Instructions:
 * 1. Place regression-risk-map-generator.js in the same directory as
 *    jira-pr-regression-analyzer.js
 * 2. Apply the changes below to jira-pr-regression-analyzer.js
 */

// ============================================================================
// ADD THIS IMPORT at the top of jira-pr-regression-analyzer.js (after line 14):
// ============================================================================
// const { RiskMapGenerator } = require('./regression-risk-map-generator');

// ============================================================================
// REPLACE the main() function (lines 900-977) with this version:
// ============================================================================

async function main() {
  try {
    console.log('🚀 Starting JIRA PR Regression Analysis\n');

    const args = process.argv.slice(2);
    let filterId = CONFIG.jira.filterId;

    // Check for --risk-map-only flag (skips Jira/GitHub, generates from existing CSV)
    const riskMapOnly = args.includes('--risk-map-only');
    if (riskMapOnly) {
      console.log('📊 Risk Map Only mode — generating from existing CSV...\n');
      const { CSVInputParser, RiskMapGenerator } = require('./regression-risk-map-generator');
      const csvPath = path.join(CONFIG.outputDir, 'pr-risk-mapping.csv');
      if (!fs.existsSync(csvPath)) {
        throw new Error(`No CSV found at ${csvPath}. Run the full analysis first.`);
      }
      const analysisResults = CSVInputParser.parse(csvPath);
      RiskMapGenerator.generate(analysisResults);
      return;
    }

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

    const jiraClient         = new JiraClient(CONFIG.jira.baseUrl, CONFIG.jira.email, CONFIG.jira.apiToken);
    const prAnalyzer         = new GitHubPRAnalyzer(CONFIG.github.token);
    const regressionAnalyzer = new RegressionAnalyzer(jiraClient, prAnalyzer, bsClient);

    const analysisResults = await regressionAnalyzer.analyzeCALLTickets(filterId);
    const stats = await OutputGenerator.generate(analysisResults);

    console.log('\n📈 Analysis Summary:');
    console.log(`   Total CALL tickets analyzed: ${stats.total}`);
    console.log(`   Critical/High risk PRs (score ≥ 70): ${stats.highRisk}`);

    // ── NEW: Generate Risk Map ──────────────────────────────────────────
    const skipRiskMap = args.includes('--no-risk-map');
    if (!skipRiskMap) {
      try {
        const { RiskMapGenerator } = require('./regression-risk-map-generator');
        RiskMapGenerator.generate(analysisResults);
      } catch (e) {
        console.log(`\n⚠️  Risk Map Generator not available: ${e.message}`);
        console.log('   To enable, place regression-risk-map-generator.js in the same directory.');
      }
    }
    // ─────────────────────────────────────────────────────────────────────

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
