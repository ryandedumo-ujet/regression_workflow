/**
 * Regression Risk Map Generator
 *
 * Consumes output from jira-pr-regression-analyzer.js and generates:
 *   1. A structured regression risk map (Markdown)
 *   2. Recommended test scenarios with priorities (CSV — BrowserStack-compatible)
 *   3. A coverage gap report
 *
 * Can run standalone (from CSV) or be called programmatically from the analyzer pipeline.
 *
 * Usage:
 *   Standalone:  node regression-risk-map-generator.js ./regression-analysis-output/pr-risk-mapping.csv
 *   Pipeline:    const generator = require('./regression-risk-map-generator');
 *                generator.generate(analysisResults);
 */

const fs = require('fs');
const path = require('path');

const CONFIG = {
  outputDir: './regression-analysis-output',
  browserstack: {
    projectId: '2986649',
    targetFolderId: '33917692',
    folderPath: 'Release Testing-2025>UJET Core Release Testing-2025',
  },
};

// ============================================================================
// DOMAIN: UJET RISK-TO-SCENARIO MAPPING RULES
// ============================================================================
// Each rule matches risk signals (from the analyzer) to concrete test scenarios.
// Rules are ordered by priority — first match wins for dedup, but all matches
// contribute scenarios.

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
      {
        title: 'Call status transitions — Inbound call lifecycle',
        steps: 'Inbound call → Agent answers → Hold → Unhold → End call',
        verify: 'Verify call status updates in Agent Adapter at each transition (Ringing → Connected → On Hold → Connected → Wrap-up)',
        priority: 'Critical',
        category: 'Call State',
      },
      {
        title: 'Call status transitions — Warm transfer',
        steps: 'Inbound call → Agent 1 answers → Warm transfer to Agent 2 → Agent 2 picks up → Agent 1 drops → End call',
        verify: 'Verify both agents see correct call statuses throughout. Agent 2 adapter shows Connected after pickup.',
        priority: 'Critical',
        category: 'Call State',
      },
      {
        title: 'Call status transitions — Deflected warm transfer',
        steps: 'Inbound call → Agent 1 answers → Warm transfer → Transfer deflects (to queue / to agent / to IVR) → End call',
        verify: 'Verify Agent 1 returns to connected state, call status in adapter reflects deflection correctly',
        priority: 'Critical',
        category: 'Call State',
      },
      {
        title: 'Call status display — Agent Adapter after upgrade',
        steps: 'After server upgrade, make inbound call → observe Agent Adapter',
        verify: 'All call statuses display correctly in Agent Adapter (no blank/missing statuses)',
        priority: 'High',
        category: 'Call State',
      },
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
      {
        title: 'Warm transfer — Agent 2 joins correctly',
        steps: 'Agent 1 on call → Initiate warm transfer to Agent 2 → Agent 2 answers',
        verify: 'Agent 2 successfully joins conference. Both agents + consumer can hear each other. No audio gaps.',
        priority: 'Critical',
        category: 'Transfer',
      },
      {
        title: 'Warm transfer — Deflected to queue (all 3 types)',
        steps: 'Agent 1 on call → Warm transfer → Target agent unavailable → Call deflects to: (a) queue, (b) another agent, (c) IVR',
        verify: 'For each deflection type: Agent 1 returns to call, consumer hears hold music during deflection, call resumes normally',
        priority: 'Critical',
        category: 'Transfer',
      },
      {
        title: 'Cold transfer — Agent handoff',
        steps: 'Agent 1 on call → Cold transfer to Agent 2 → Agent 1 drops immediately',
        verify: 'Agent 2 receives the call, consumer is connected to Agent 2, no orphaned call legs',
        priority: 'High',
        category: 'Transfer',
      },
      {
        title: 'Multi-agent conference — 3+ participants',
        steps: 'Agent 1 on call → Add Agent 2 via warm transfer → Add Agent 3 → Agents leave one by one',
        verify: 'Each agent join/leave is handled correctly. Recording captures all participants. No call drops.',
        priority: 'Medium',
        category: 'Transfer',
      },
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
      {
        title: 'Hold music — Mono recording (Dual Channel OFF)',
        steps: 'Config: Dual Channel OFF. Inbound call → Agent puts consumer on hold → Unhold → End call',
        verify: 'Hold music plays for consumer. Recording does NOT contain hold music. Recording has silence or gap during hold.',
        priority: 'Critical',
        category: 'Hold Music',
      },
      {
        title: 'Hold music — Dual channel recording',
        steps: 'Config: Dual Channel ON. Inbound call → Agent puts consumer on hold → Unhold → End call',
        verify: 'Hold music appears ONLY on consumer channel. Agent channel has silence during hold. Both channels resume after unhold.',
        priority: 'Critical',
        category: 'Hold Music',
      },
      {
        title: 'Hold during warm transfer — deflected',
        steps: 'Agent 1 on call → Put consumer on hold → Warm transfer → Transfer deflects → Unhold',
        verify: 'Hold music plays continuously during deflection. Music stops after unhold. No audio glitches.',
        priority: 'Critical',
        category: 'Hold Music',
      },
      {
        title: 'Hold ON vs Hold OFF during transfer',
        steps: 'Scenario A: Hold ON before transfer. Scenario B: Direct transfer (no hold). Both with warm transfer.',
        verify: 'Scenario A: consumer hears hold music during transfer. Scenario B: consumer hears ringing/silence. Both complete successfully.',
        priority: 'High',
        category: 'Hold Music',
      },
      {
        title: 'Multiple hold/unhold cycles',
        steps: 'Inbound call → Hold → Unhold → Hold → Unhold → Hold → Unhold → End call',
        verify: 'Each hold/unhold cycle works correctly. Recording segments are accurate. No accumulated audio delay.',
        priority: 'Medium',
        category: 'Hold Music',
      },
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
      {
        title: 'Recording — Segment OFF + Dual Channel OFF',
        steps: 'Config: Segment OFF, Dual Channel OFF. Complete a call with warm transfer (2 agents).',
        verify: 'Single recording file generated. post_process_recordings has 1 entry. File plays back correctly.',
        priority: 'Critical',
        category: 'Recording',
      },
      {
        title: 'Recording — Segment ON + Dual Channel OFF',
        steps: 'Config: Segment ON, Dual Channel OFF. Complete a call with warm transfer (2 agents).',
        verify: 'Separate recording per agent segment. post_process_recordings entries match agent count.',
        priority: 'Critical',
        category: 'Recording',
      },
      {
        title: 'Recording — Segment OFF + Dual Channel ON',
        steps: 'Config: Segment OFF, Dual Channel ON. Complete a call with warm transfer.',
        verify: 'Single dual-channel file. Consumer channel + agent channel present. Hold music only on consumer channel.',
        priority: 'Critical',
        category: 'Recording',
      },
      {
        title: 'Recording — Segment ON + Dual Channel ON',
        steps: 'Config: Segment ON, Dual Channel ON. Complete a call with warm transfer.',
        verify: 'Per-segment dual-channel files. Each segment has consumer + agent channels. Metadata fields correct.',
        priority: 'Critical',
        category: 'Recording',
      },
      {
        title: 'Post-process metadata validation',
        steps: 'After any call, query session metadata via Reports > Session Data',
        verify: 'Verify: id, call_id, duration, started_at, recording_file_name, recording_url, agent_id, virtual_agent_id, conversation_id',
        priority: 'High',
        category: 'Recording',
      },
      {
        title: 'CRM recording link upload',
        steps: 'Config: Post call recording link to CRM = ON. Complete call. Wait for CRM upload.',
        verify: 'CRM record has recording link comment. Link is accessible and plays correct recording.',
        priority: 'High',
        category: 'Recording',
      },
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
      {
        title: 'VA to Human Agent escalation — basic flow',
        steps: 'Consumer enters VA flow → VA escalates to human agent queue → Agent picks up',
        verify: 'Escalation completes. Agent receives full context. Call recording captures VA + HA segments.',
        priority: 'Critical',
        category: 'VA/AI',
      },
      {
        title: 'VA escalation — agent puts consumer on hold after escalation',
        steps: 'VA escalation to HA → Agent answers → Agent puts consumer on hold → Unhold → End call',
        verify: 'Hold music works correctly after VA escalation. Recording handles VA→HA transition + hold.',
        priority: 'High',
        category: 'VA/AI',
      },
      {
        title: 'VA escalation — warm transfer after VA handoff',
        steps: 'VA escalates to Agent 1 → Agent 1 warm transfers to Agent 2 → Complete call',
        verify: 'Transfer works after VA escalation. ProgressService handles state correctly. No method errors.',
        priority: 'High',
        category: 'VA/AI',
      },
      {
        title: 'VA return to queue — attempt_return_end_user_to_queue',
        steps: 'VA flow → Attempt to return end user to queue → Queue routes to agent',
        verify: 'No NoMethodError. Consumer is successfully returned to queue. Agent receives call.',
        priority: 'Critical',
        category: 'VA/AI',
      },
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
      {
        title: 'Verify all callers of changed methods',
        steps: 'For each modified/removed symbol: identify all calling code paths → execute those paths end-to-end',
        verify: 'No NoMethodError, ArgumentError, or unexpected behavior in any calling path',
        priority: 'Critical',
        category: 'Code Impact',
      },
      {
        title: 'Service-to-service contract validation',
        steps: 'If changed methods are in shared services: test all consuming services independently',
        verify: 'Each consuming service handles the new method signature/behavior correctly',
        priority: 'High',
        category: 'Code Impact',
      },
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
      {
        title: 'Error path testing — network failure during call',
        steps: 'Simulate network interruption during active call (consumer or agent side)',
        verify: 'Graceful degradation. No unhandled exceptions. Call terminates cleanly or reconnects.',
        priority: 'High',
        category: 'Error Handling',
      },
      {
        title: 'Error path testing — invalid input to modified methods',
        steps: 'Send edge case / nil / empty inputs to modified API endpoints or service methods',
        verify: 'Proper error responses returned. No 500 errors. No data corruption.',
        priority: 'Medium',
        category: 'Error Handling',
      },
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
      {
        title: 'Post-call processing job — recording upload',
        steps: 'Complete call → Wait for background job to process recording → Check storage',
        verify: 'Recording uploaded to external storage. Job completes without retry loops. File is accessible.',
        priority: 'High',
        category: 'Background Jobs',
      },
      {
        title: 'CRM metadata upload job — after call completion',
        steps: 'Complete call with CRM integration active → Wait for metadata upload',
        verify: 'CRM receives correct metadata. Job is idempotent (running twice doesn\'t duplicate data).',
        priority: 'Medium',
        category: 'Background Jobs',
      },
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
      {
        title: 'Data integrity after migration',
        steps: 'Run migration → Query affected tables → Verify data',
        verify: 'Existing records are intact. New columns have correct defaults. No orphaned records.',
        priority: 'Critical',
        category: 'Database',
      },
      {
        title: 'Rollback safety',
        steps: 'Apply migration → Roll back → Verify application still works on old schema',
        verify: 'Rollback completes without data loss. Application functions correctly on prior schema version.',
        priority: 'High',
        category: 'Database',
      },
    ],
  },

  // ── Provider-Specific (Twilio/Telnyx/Nexmo) ───────────────────────────
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
      {
        title: 'Cross-provider call flow — Twilio',
        steps: 'Use Twilio provider → Complete full call flow (inbound → hold → transfer → end)',
        verify: 'All call events handled correctly for Twilio. Recording files generated. Hold music works.',
        priority: 'High',
        category: 'Provider',
      },
      {
        title: 'Cross-provider call flow — Telnyx',
        steps: 'Use Telnyx provider → Complete full call flow (inbound → hold → transfer → end)',
        verify: 'All call events handled correctly for Telnyx. Recording files generated. Hold music works.',
        priority: 'High',
        category: 'Provider',
      },
      {
        title: 'Cross-provider call flow — Nexmo',
        steps: 'Use Nexmo provider → Complete full call flow (inbound → hold → transfer → end)',
        verify: 'All call events handled correctly for Nexmo. Recording files generated. Hold music works.',
        priority: 'Medium',
        category: 'Provider',
      },
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
      {
        title: 'CRM metadata upload — Zendesk',
        steps: 'Complete call with Zendesk CRM active → Wait for metadata upload',
        verify: 'Ticket created/updated in Zendesk. Recording link posted as comment. All fields populated.',
        priority: 'High',
        category: 'CRM',
      },
      {
        title: 'CRM metadata upload — Salesforce',
        steps: 'Complete call with Salesforce CRM active → Wait for metadata upload',
        verify: 'Case/record updated in Salesforce. Recording link accessible. Custom fields mapped correctly.',
        priority: 'High',
        category: 'CRM',
      },
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
      {
        title: 'API backward compatibility — mobile clients',
        steps: 'Use older mobile SDK version → Make API calls to changed endpoints',
        verify: 'Older clients still receive valid responses. No breaking changes in response shape.',
        priority: 'Critical',
        category: 'API',
      },
      {
        title: 'API backward compatibility — Agent Adapter',
        steps: 'Use Agent Adapter → Exercise all changed API endpoints during normal call flow',
        verify: 'Adapter functions correctly. No missing data or broken UI elements.',
        priority: 'High',
        category: 'API',
      },
    ],
  },
];


// ============================================================================
// RISK MAP GENERATOR
// ============================================================================

class RiskMapGenerator {

  /**
   * Main entry: takes analyzer results and produces all outputs.
   * @param {Array} analysisResults — from RegressionAnalyzer.analyzeCALLTickets()
   * @returns {Object} { riskMap, scenarios, gaps }
   */
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

    // Generate outputs
    const riskMapMd = this._generateRiskMapMarkdown(ticketScenarios);
    const scenarioCsv = this._generateScenarioCSV(ticketScenarios);
    const bsCsv = this._generateBrowserStackCSV(ticketScenarios);
    const summary = this._generateSummary(ticketScenarios);

    // Write files
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

  /**
   * Match a ticket's risk signals against all scenario rules.
   */
  static _matchRules(ticket) {
    const pr = ticket.prAnalysis || {};
    const matchedRules = [];
    const allScenarios = [];
    const matchedRuleIds = new Set();

    // Build searchable text blobs from the ticket
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

    // Identify coverage gaps: risk signals that didn't match any rule
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

  /**
   * Generate the Markdown risk map document.
   */
  static _generateRiskMapMarkdown(ticketScenarios) {
    const lines = [];
    const now = new Date().toISOString().split('T')[0];

    lines.push(`# Regression Risk Map`);
    lines.push(`Generated: ${now}\n`);

    // ── Executive Summary ──
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

    // ── Per-Ticket Risk Breakdown ──
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

      // Changed files
      if (pr.diffSummary?.length) {
        lines.push(`**Changed Files:**`);
        for (const f of pr.diffSummary.slice(0, 10)) {
          lines.push(`- \`${f}\``);
        }
        lines.push('');
      }

      // Direct risks
      if (pr.directRisks?.length) {
        lines.push(`**Direct Risks:**`);
        for (const r of pr.directRisks) {
          lines.push(`- ${r}`);
        }
        lines.push('');
      }

      // Indirect risks
      if (pr.indirectRisks?.length) {
        lines.push(`**Indirect Risks (callers outside the diff):**`);
        for (const r of pr.indirectRisks) {
          lines.push(`- ${r}`);
        }
        lines.push('');
      }

      // Matched rules
      if (ts.matchedRules.length) {
        lines.push(`**Risk Categories Triggered:**`);
        for (const rule of ts.matchedRules) {
          lines.push(`- ${rule.name} (\`${rule.id}\`)`);
        }
        lines.push('');
      }

      // Recommended scenarios for this ticket
      if (ts.scenarios.length) {
        lines.push(`**Recommended Test Scenarios:**\n`);
        lines.push(`| # | Scenario | Priority | Category |`);
        lines.push(`|---|----------|----------|----------|`);
        ts.scenarios.forEach((s, i) => {
          lines.push(`| ${i + 1} | ${s.title} | ${s.priority} | ${s.category} |`);
        });
        lines.push('');
      }

      // Existing BrowserStack matches
      if (t.matchedTestCases?.length) {
        lines.push(`**Existing BrowserStack Test Cases:**`);
        for (const tc of t.matchedTestCases) {
          lines.push(`- ${tc.identifier}: ${tc.title} (score: ${tc.score})`);
        }
        lines.push('');
      }

      // Coverage gaps
      if (ts.coverageGaps.length) {
        lines.push(`**⚠️ Uncovered Risks (no matching scenario rule):**`);
        for (const gap of ts.coverageGaps) {
          lines.push(`- ${gap.detail}`);
        }
        lines.push('');
      }

      lines.push('---\n');
    }

    // ── Consolidated Scenario List (deduplicated) ──
    lines.push(`## Consolidated Test Scenario List\n`);
    lines.push(`Deduplicated across all tickets, sorted by priority.\n`);

    const priorityOrder = { Critical: 0, High: 1, Medium: 2, Low: 3 };
    uniqueScenarios.sort((a, b) => (priorityOrder[a.priority] ?? 99) - (priorityOrder[b.priority] ?? 99));

    lines.push(`| # | Scenario | Priority | Category | Source Ticket(s) |`);
    lines.push(`|---|----------|----------|----------|-----------------|`);
    uniqueScenarios.forEach((s, i) => {
      lines.push(`| ${i + 1} | ${s.title} | ${s.priority} | ${s.category} | ${s.sourceTickets.join(', ')} |`);
    });
    lines.push('');

    // ── Execution Priority Guide ──
    lines.push(`## Execution Priority Guide\n`);
    lines.push(`### Phase 1: Smoke (Critical scenarios only)`);
    lines.push(`Run these first to catch show-stoppers:\n`);
    uniqueScenarios.filter(s => s.priority === 'Critical').forEach((s, i) => {
      lines.push(`${i + 1}. **${s.title}** — ${s.verify}`);
    });
    lines.push('');

    lines.push(`### Phase 2: Core Regression (High priority)`);
    lines.push(`Run after smoke passes:\n`);
    uniqueScenarios.filter(s => s.priority === 'High').forEach((s, i) => {
      lines.push(`${i + 1}. **${s.title}** — ${s.verify}`);
    });
    lines.push('');

    lines.push(`### Phase 3: Extended Coverage (Medium/Low priority)`);
    lines.push(`Run if time permits:\n`);
    uniqueScenarios.filter(s => s.priority === 'Medium' || s.priority === 'Low').forEach((s, i) => {
      lines.push(`${i + 1}. **${s.title}** — ${s.verify}`);
    });
    lines.push('');

    return lines.join('\n');
  }

  /**
   * Generate a flat CSV with all recommended scenarios.
   */
  static _generateScenarioCSV(ticketScenarios) {
    const headers = [
      'Source Ticket',
      'Risk Score',
      'Rule ID',
      'Rule Name',
      'Priority',
      'Category',
      'Scenario Title',
      'Steps',
      'Verification',
    ];

    const rows = [];
    for (const ts of ticketScenarios) {
      for (const s of ts.scenarios) {
        rows.push([
          s.sourceTicket,
          s.ticketRiskScore,
          s.sourceRule,
          s.sourceRuleName,
          s.priority,
          s.category,
          s.title,
          s.steps,
          s.verify,
        ]);
      }
    }

    const escapeCsv = (val) => {
      if (val === null || val === undefined) return '""';
      return `"${String(val).replace(/"/g, '""')}"`;
    };

    return [headers, ...rows].map(row => row.map(escapeCsv).join(',')).join('\n');
  }

  /**
   * Generate BrowserStack-compatible CSV for import.
   * Uses the multi-row format from the user's sample export.
   */
  static _generateBrowserStackCSV(ticketScenarios) {
    const headers = [
      'Test Case ID', 'Title', 'Folder ID', 'Folder Path', 'State', 'Owner',
      'Priority', 'Type of Test Case', 'Automation Status', 'Description',
      'Preconditions', 'Template', 'Steps', 'Expected Result', 'Issues', 'Tags',
    ];

    const allScenarios = this._deduplicateScenarios(
      ticketScenarios.flatMap(ts => ts.scenarios)
    );

    const priorityOrder = { Critical: 0, High: 1, Medium: 2, Low: 3 };
    allScenarios.sort((a, b) => (priorityOrder[a.priority] ?? 99) - (priorityOrder[b.priority] ?? 99));

    const rows = [];
    const escapeCsv = (val) => {
      if (val === null || val === undefined) return '';
      const str = String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const priorityMap = { Critical: 'Critical', High: 'High', Medium: 'Medium', Low: 'Low' };
    const folderPath = CONFIG.browserstack.folderPath;
    const folderId = CONFIG.browserstack.targetFolderId;

    for (const scenario of allScenarios) {
      // Parse steps into individual lines
      const stepParts = scenario.steps.split(/→|➜|->/).map(s => s.trim()).filter(Boolean);
      const verifyParts = scenario.verify.split(/\.\s+/).map(s => s.trim()).filter(Boolean);

      // First row: has all metadata + first step
      const firstRow = [
        '',  // Test Case ID (auto-generated by BS)
        `[${scenario.category}] ${scenario.title}`,
        folderId,
        folderPath,
        'Active',
        'Ryan Dedumo',
        priorityMap[scenario.priority] || 'Medium',
        'Functional',
        'Not Automated',
        `Auto-generated regression scenario from risk analysis. Source: ${scenario.sourceTickets.join(', ')}`,
        '', // Preconditions — will be filled per-config
        'Steps',
        stepParts[0] ? stepParts[0] : scenario.steps,
        verifyParts[0] ? verifyParts[0] : scenario.verify,
        scenario.sourceTickets.join(', '),
        `regression,risk-map,${scenario.category.toLowerCase().replace(/[/ ]/g, '-')}`,
      ];
      rows.push(firstRow);

      // Continuation rows: additional steps
      for (let i = 1; i < stepParts.length; i++) {
        const contRow = new Array(headers.length).fill('');
        contRow[12] = stepParts[i]; // Steps column
        contRow[13] = verifyParts[i] || ''; // Expected Result
        rows.push(contRow);
      }

      // Final verification step if there are more verify items than steps
      for (let i = stepParts.length; i < verifyParts.length; i++) {
        const contRow = new Array(headers.length).fill('');
        contRow[12] = 'Verify the result';
        contRow[13] = verifyParts[i];
        rows.push(contRow);
      }
    }

    return [headers.map(escapeCsv), ...rows.map(r => r.map(escapeCsv))].join('\n');
  }

  /**
   * Deduplicate scenarios by title, merging source tickets.
   */
  static _deduplicateScenarios(scenarios) {
    const map = new Map();
    for (const s of scenarios) {
      if (map.has(s.title)) {
        const existing = map.get(s.title);
        if (!existing.sourceTickets.includes(s.sourceTicket)) {
          existing.sourceTickets.push(s.sourceTicket);
        }
        // Upgrade priority if this ticket has higher risk
        const prio = { Critical: 0, High: 1, Medium: 2, Low: 3 };
        if ((prio[s.priority] ?? 99) < (prio[existing.priority] ?? 99)) {
          existing.priority = s.priority;
        }
      } else {
        map.set(s.title, { ...s, sourceTickets: [s.sourceTicket] });
      }
    }
    return Array.from(map.values());
  }

  /**
   * Console summary output.
   */
  static _generateSummary(ticketScenarios) {
    const allScenarios = this._deduplicateScenarios(
      ticketScenarios.flatMap(ts => ts.scenarios)
    );
    const byPriority = { Critical: 0, High: 0, Medium: 0, Low: 0 };
    for (const s of allScenarios) {
      byPriority[s.priority] = (byPriority[s.priority] || 0) + 1;
    }
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
// CSV INPUT PARSER (for standalone mode — reads pr-risk-mapping.csv)
// ============================================================================

class CSVInputParser {
  /**
   * Parses the pr-risk-mapping.csv output from jira-pr-regression-analyzer.js
   * and converts it back to the analysisResults format expected by RiskMapGenerator.
   */
  static parse(csvPath) {
    const content = fs.readFileSync(csvPath, 'utf-8');
    const rows = this._parseCSVRows(content);

    if (rows.length < 2) {
      throw new Error('CSV file is empty or has only headers');
    }

    const headers = rows[0];
    const results = [];

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row[0]) continue; // skip empty rows

      results.push({
        ticketKey: row[0] || '',
        ticketSummary: '', // not in CSV — could enhance later
        status: row[1] || '',
        prLink: row[2] === 'No PR Found' ? null : row[2],
        riskScore: parseInt(row[3]) || 0,
        regressionConcern: row[4] || '',
        affectedAreas: (row[9] || '').split(',').map(a => a.trim()).filter(Boolean),
        changedSymbols: (row[8] || '').split(',').map(s => {
          const match = s.trim().match(/^(.+?)\s*\((\w+)\)$/);
          return match ? { symbol: match[1], kind: match[2] } : null;
        }).filter(Boolean),
        matchedTestCases: (row[10] || '').split('\n').map(tc => {
          const match = tc.trim().match(/^(.+?):\s*(.+)$/);
          return match ? { identifier: match[1], title: match[2] } : null;
        }).filter(Boolean),
        prAnalysis: {
          diffSummary: (row[5] || '').split('\n').filter(Boolean),
          directRisks: (row[6] || '').split('\n').filter(Boolean),
          indirectRisks: (row[7] || '').split('\n').filter(Boolean),
        },
      });
    }

    return results;
  }

  /**
   * Basic CSV parser that handles quoted fields with commas and newlines.
   */
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
          if (content[i + 1] === '"') {
            currentField += '"';
            i += 2;
          } else {
            inQuotes = false;
            i++;
          }
        } else {
          currentField += char;
          i++;
        }
      } else {
        if (char === '"') {
          inQuotes = true;
          i++;
        } else if (char === ',') {
          currentRow.push(currentField);
          currentField = '';
          i++;
        } else if (char === '\n' || (char === '\r' && content[i + 1] === '\n')) {
          currentRow.push(currentField);
          rows.push(currentRow);
          currentRow = [];
          currentField = '';
          i += (char === '\r' ? 2 : 1);
        } else {
          currentField += char;
          i++;
        }
      }
    }

    // Last field/row
    if (currentField || currentRow.length) {
      currentRow.push(currentField);
      rows.push(currentRow);
    }

    return rows;
  }
}


// ============================================================================
// MAIN (standalone mode)
// ============================================================================

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    // Try default CSV path
    const defaultPath = path.join(CONFIG.outputDir, 'pr-risk-mapping.csv');
    if (fs.existsSync(defaultPath)) {
      console.log(`📂 Using default input: ${defaultPath}`);
      args.push(defaultPath);
    } else {
      console.log(`
Usage: node regression-risk-map-generator.js [path-to-pr-risk-mapping.csv]

  Reads the CSV output from jira-pr-regression-analyzer.js and generates:
    - regression-risk-map.md         (structured risk map document)
    - recommended-test-scenarios.csv (flat scenario list)
    - browserstack-regression-scenarios.csv (BrowserStack import-ready)

  If no path is given, looks for: ${defaultPath}
`);
      process.exit(0);
    }
  }

  const csvPath = args[0];
  if (!fs.existsSync(csvPath)) {
    console.error(`❌ File not found: ${csvPath}`);
    process.exit(1);
  }

  console.log(`🚀 Generating Regression Risk Map from: ${csvPath}\n`);

  const analysisResults = CSVInputParser.parse(csvPath);
  console.log(`   Parsed ${analysisResults.length} ticket(s) from CSV.`);

  RiskMapGenerator.generate(analysisResults);
}

if (require.main === module) {
  main();
}

module.exports = {
  RiskMapGenerator,
  CSVInputParser,
  RISK_SCENARIO_RULES,
  CONFIG,
};
