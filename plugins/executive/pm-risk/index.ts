/**
 * PM Risk Intelligence Plugin
 *
 * Risk lifecycle management grounded in PMI methodology.
 * Five tools cover identification, analysis, response planning,
 * register compilation, and monitoring with trend analysis.
 *
 * Risk scoring: P × I on a 1–5 scale → 1–25 score
 * Quadrant mapping:
 *   - Score 15–25: High → Avoid or Transfer
 *   - Score 8–14:  Medium → Mitigate
 *   - Score 1–7:   Low → Accept
 *
 * Depends on: executive.pm-knowledge (for PMI ontology risk categories)
 */

import type { PluginModule, PluginAPI } from "../../../src/plugin/types.js";

// ─── Risk Scoring Utilities ───────────────────────────────────────────────────

type ResponseStrategy = "avoid" | "transfer" | "mitigate" | "accept";

function scoreRisk(probability: number, impact: number): number {
  return Math.round(probability * impact * 100) / 100;
}

function riskLevel(score: number): "High" | "Medium" | "Low" {
  if (score >= 15) return "High";
  if (score >= 8) return "Medium";
  return "Low";
}

function suggestStrategy(score: number): ResponseStrategy {
  if (score >= 20) return "avoid";
  if (score >= 15) return "transfer";
  if (score >= 8) return "mitigate";
  return "accept";
}

function matrixPosition(probability: number, impact: number): string {
  const row = probability <= 1 ? "Very Low" : probability <= 2 ? "Low" : probability <= 3 ? "Medium" : probability <= 4 ? "High" : "Very High";
  const col = impact <= 1 ? "Very Low" : impact <= 2 ? "Low" : impact <= 3 ? "Medium" : impact <= 4 ? "High" : "Very High";
  return `${row} Probability / ${col} Impact`;
}

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

// ─── PMI Risk Category Prompts ────────────────────────────────────────────────

const PMI_RISK_CATEGORY_PROMPTS: Record<string, string> = {
  "Technical": "Technical complexity, technology maturity, integration challenges, performance requirements, security vulnerabilities, technical debt",
  "Schedule": "Duration estimation errors, dependency delays, resource availability, critical path compression, regulatory approval timelines",
  "Cost": "Budget estimating uncertainty, cost escalation, currency fluctuation, contract variations, resource cost overruns",
  "Resource": "Key personnel availability, skill gaps, team turnover, vendor capacity, contractor performance",
  "Scope": "Requirements ambiguity, scope creep, changing stakeholder needs, regulatory changes, interface definition gaps",
  "Quality": "Testing adequacy, defect rates, acceptance criteria ambiguity, rework requirements, compliance gaps",
  "Stakeholder": "Stakeholder resistance, decision-making delays, communication failures, political risk, organizational change",
  "External": "Market conditions, regulatory changes, natural disasters, geopolitical events, supply chain disruption",
  "Organizational": "Governance changes, priority conflicts, cultural resistance, process maturity, leadership transitions",
};

// ─── Tool: identify_risks ────────────────────────────────────────────────────

function buildRiskIdentificationPrompt(
  projectName: string,
  projectDescription: string,
  phase: string,
  existingRisks: string[]
): string {
  const categoryLines = Object.entries(PMI_RISK_CATEGORY_PROMPTS)
    .map(([cat, prompt]) => `**${cat}:** ${prompt}`)
    .join("\n");

  const existing = existingRisks.length > 0
    ? `\nAlready identified (do not duplicate):\n${existingRisks.map((r, i) => `${i + 1}. ${r}`).join("\n")}`
    : "";

  return [
    `# Risk Identification — ${projectName}`,
    `**Phase:** ${phase}`,
    `**Generated:** ${timestamp()}`,
    "",
    "## Project Context",
    projectDescription,
    "",
    "## PMI Risk Category Analysis",
    "",
    "Consider potential risks across the following PMI-defined categories:",
    "",
    categoryLines,
    existing,
    "",
    "## Risk Identification Output Template",
    "",
    "For each identified risk, provide:",
    "- **Category** (from PMI taxonomy above)",
    "- **Risk Description** (cause → risk event → effect format)",
    "- **Trigger** (early warning indicator)",
    "- **Suggested Owner** (functional area or role)",
    "- **Initial Probability** (1=Very Low, 2=Low, 3=Medium, 4=High, 5=Very High)",
    "- **Initial Impact** (1=Very Low, 2=Low, 3=Medium, 4=High, 5=Very High)",
  ].join("\n");
}

// ─── Tool: analyze_risk ──────────────────────────────────────────────────────

function buildRiskAnalysis(
  riskDescription: string,
  probability: number,
  impact: number,
  projectPhase: string,
  costDataAvailable: boolean
): string {
  const score = scoreRisk(probability, impact);
  const level = riskLevel(score);
  const strategy = suggestStrategy(score);
  const position = matrixPosition(probability, impact);

  const strategyRationale: Record<ResponseStrategy, string> = {
    avoid: "Risk score is critically high. Recommend eliminating the risk by changing the project approach, modifying requirements, or descoping the affected work.",
    transfer: "Risk score is high. Consider transferring financial exposure via insurance, fixed-price contracts, or bonding. Risk ownership moves but project must manage residual risk.",
    mitigate: "Risk score is moderate. Take proactive actions to reduce probability and/or impact to an acceptable level before the risk occurs.",
    accept: "Risk score is low. No active response required. Monitor for changes. Consider adding a contingency reserve for potential impact.",
  };

  const lines: string[] = [
    `# Risk Analysis`,
    `**Generated:** ${timestamp()}`,
    "",
    "## Risk Description",
    riskDescription,
    "",
    "## Quantitative Assessment",
    "| Attribute | Value |",
    "|-----------|-------|",
    `| Probability (P) | ${probability}/5 |`,
    `| Impact (I) | ${impact}/5 |`,
    `| Risk Score (P×I) | **${score}** |`,
    `| Risk Level | **${level}** |`,
    `| Matrix Position | ${position} |`,
    `| Project Phase | ${projectPhase} |`,
    "",
  ];

  if (costDataAvailable) {
    lines.push(
      "## Expected Monetary Value (EMV)",
      "_Provide estimated financial impact to calculate EMV = Probability × Financial Impact._",
      "| Input | Value |",
      "|-------|-------|",
      "| Probability (decimal) | " + (probability / 5).toFixed(2) + " |",
      "| Estimated Cost Impact | _Enter value_ |",
      "| EMV | _= Probability × Cost Impact_ |",
      ""
    );
  }

  lines.push(
    "## Recommended Response Strategy",
    `**Strategy: ${strategy.toUpperCase()}**`,
    "",
    strategyRationale[strategy],
    "",
    "## Risk Matrix Position",
    "```",
    "           Impact",
    "           Low    Med    High   Very High",
    "Prob High  [ M ]  [ H ]  [ H ]  [ H ]",
    "     Med   [ L ]  [ M ]  [ H ]  [ H ]",
    "     Low   [ L ]  [ L ]  [ M ]  [ H ]",
    "```",
    `_This risk falls in the **${level}** zone (${position})_`,
    "",
    "---",
    "_Generated by Lliam PM Risk Intelligence — PMI PMBOK-Aligned_"
  );

  return lines.join("\n");
}

// ─── Tool: plan_risk_response ─────────────────────────────────────────────────

function buildRiskResponsePlan(
  riskDescription: string,
  riskScore: number,
  responseStrategy: ResponseStrategy,
  availableBudget?: number
): string {
  const level = riskLevel(riskScore);

  const strategyActions: Record<ResponseStrategy, string[]> = {
    avoid: [
      "Re-evaluate project scope to eliminate the risk condition",
      "Modify project objectives or constraints that create the risk exposure",
      "Change technical approach to avoid the risk trigger",
      "Obtain additional clarification on requirements to remove ambiguity",
      "Escalate to sponsor for authorization to change scope/approach",
    ],
    transfer: [
      "Identify appropriate insurance products or bonding instruments",
      "Develop fixed-price contract language for affected work",
      "Define performance guarantees and penalty clauses with vendors",
      "Negotiate Service Level Agreements (SLAs) with clear breach remedies",
      "Document risk transfer in contract and procurement plan",
    ],
    mitigate: [
      "Identify root causes and address the most impactful ones first",
      "Implement preventive controls to reduce probability of occurrence",
      "Develop contingency plans to reduce impact if risk is realized",
      "Add schedule buffer or resource capacity to absorb potential impact",
      "Conduct regular monitoring reviews to detect early warning indicators",
    ],
    accept: [
      "Document acceptance decision and rationale in risk register",
      "Establish monitoring frequency and trigger thresholds",
      "Assign risk owner responsible for monitoring",
      "Reserve contingency budget proportional to expected monetary value",
      "Define escalation path if risk probability or impact increases",
    ],
  };

  const actions = strategyActions[responseStrategy];
  const residualScoreEstimate = responseStrategy === "avoid" ? 0
    : responseStrategy === "transfer" ? Math.round(riskScore * 0.2)
    : responseStrategy === "mitigate" ? Math.round(riskScore * 0.4)
    : riskScore;

  const lines: string[] = [
    `# Risk Response Plan`,
    `**Generated:** ${timestamp()}`,
    "",
    "## Risk Description",
    riskDescription,
    "",
    "## Response Strategy: " + responseStrategy.toUpperCase(),
    `**Current Risk Score:** ${riskScore} (${level})`,
    `**Estimated Residual Risk Score:** ${residualScoreEstimate}`,
    "",
    "## Action Items",
    "| # | Action | Owner | Target Date | Status |",
    "|---|--------|-------|-------------|--------|",
    ...actions.map((a, i) => `| ${i + 1} | ${a} | _TBD_ | _TBD_ | Not Started |`),
    "",
  ];

  if (availableBudget !== undefined) {
    lines.push(
      "## Budget Allocation",
      `| Item | Amount |`,
      `|------|--------|`,
      `| Available Response Budget | $${availableBudget.toLocaleString()} |`,
      `| Recommended Contingency Reserve | $${Math.round(availableBudget * 0.3).toLocaleString()} |`,
      `| Active Response Budget | $${Math.round(availableBudget * 0.7).toLocaleString()} |`,
      ""
    );
  }

  lines.push(
    "## Fallback (Contingency) Plan",
    "If the primary response proves insufficient or the risk is realized:",
    "1. Immediately notify Project Sponsor and key stakeholders",
    "2. Activate contingency reserve per approved change request",
    "3. Convene war room with relevant subject matter experts",
    "4. Assess full impact on scope, schedule, cost, and quality baselines",
    "5. Submit integrated change request to CCB within 24 hours",
    "",
    "---",
    "_Generated by Lliam PM Risk Intelligence — PMI PMBOK-Aligned_"
  );

  return lines.join("\n");
}

// ─── Tool: create_risk_register ───────────────────────────────────────────────

function buildFullRiskRegister(params: {
  projectName: string;
  risks: Array<{
    description: string;
    category: string;
    probability: number;
    impact: number;
    owner?: string;
    responseStrategy?: string;
  }>;
}): string {
  const date = timestamp();

  const scoredRisks = params.risks.map((r, i) => {
    const score = scoreRisk(r.probability, r.impact);
    const level = riskLevel(score);
    const strategy = r.responseStrategy ?? suggestStrategy(score);
    return { ...r, id: `R-${String(i + 1).padStart(3, "0")}`, score, level, strategy };
  });

  scoredRisks.sort((a, b) => b.score - a.score);

  const highCount = scoredRisks.filter((r) => r.level === "High").length;
  const medCount = scoredRisks.filter((r) => r.level === "Medium").length;
  const lowCount = scoredRisks.filter((r) => r.level === "Low").length;
  const totalExposure = scoredRisks.reduce((sum, r) => sum + r.score, 0);

  const lines: string[] = [
    `# Risk Register — ${params.projectName}`,
    `**Generated:** ${date}`,
    `**Framework:** PMI PMBOK-Aligned`,
    "",
    "## Summary",
    "| Metric | Value |",
    "|--------|-------|",
    `| Total Risks | ${scoredRisks.length} |`,
    `| High (Score ≥ 15) | ${highCount} |`,
    `| Medium (Score 8–14) | ${medCount} |`,
    `| Low (Score < 8) | ${lowCount} |`,
    `| Total Risk Exposure Score | ${Math.round(totalExposure * 10) / 10} |`,
    "",
    "## Risk Register",
    "",
    "| ID | Level | Score | Category | Description | P | I | Owner | Strategy | Status |",
    "|----|-------|-------|----------|-------------|---|---|-------|----------|--------|",
    ...scoredRisks.map((r) =>
      `| ${r.id} | **${r.level}** | ${r.score} | ${r.category} | ${r.description} | ${r.probability} | ${r.impact} | ${r.owner ?? "_TBD_"} | ${r.strategy} | Open |`
    ),
    "",
    "## High-Priority Risks Requiring Immediate Attention",
    "",
  ];

  const highRisks = scoredRisks.filter((r) => r.level === "High");
  if (highRisks.length === 0) {
    lines.push("_No high-priority risks identified at this time._", "");
  } else {
    for (const r of highRisks) {
      lines.push(
        `### ${r.id}: ${r.description}`,
        `**Score:** ${r.score} | **Category:** ${r.category} | **Recommended Strategy:** ${r.strategy}`,
        ""
      );
    }
  }

  lines.push(
    "---",
    "_Generated by Lliam PM Risk Intelligence — PMI PMBOK-Aligned_"
  );

  return lines.join("\n");
}

// ─── Tool: monitor_risks ──────────────────────────────────────────────────────

type RiskStatus = "open" | "closed" | "escalated" | "realized";

function buildRiskMonitoringReport(params: {
  projectName: string;
  currentRisks: Array<{
    id: string;
    description: string;
    currentProbability: number;
    currentImpact: number;
    originalProbability: number;
    originalImpact: number;
    status: RiskStatus;
  }>;
}): string {
  const date = timestamp();

  type TrendType = "Improving" | "Worsening" | "Stable" | "Closed" | "Realized";

  const risksWithTrend = params.currentRisks.map((r) => {
    const originalScore = scoreRisk(r.originalProbability, r.originalImpact);
    const currentScore = scoreRisk(r.currentProbability, r.currentImpact);
    const delta = currentScore - originalScore;

    let trend: TrendType;
    if (r.status === "closed") trend = "Closed";
    else if (r.status === "realized") trend = "Realized";
    else if (delta < -1.5) trend = "Improving";
    else if (delta > 1.5) trend = "Worsening";
    else trend = "Stable";

    return { ...r, originalScore, currentScore, delta, trend };
  });

  const openRisks = risksWithTrend.filter((r) => r.status === "open" || r.status === "escalated");
  const worsening = risksWithTrend.filter((r) => r.trend === "Worsening");
  const improving = risksWithTrend.filter((r) => r.trend === "Improving");
  const realized = risksWithTrend.filter((r) => r.trend === "Realized");

  const currentExposure = openRisks.reduce((sum, r) => sum + r.currentScore, 0);
  const originalExposure = openRisks.reduce((sum, r) => sum + r.originalScore, 0);
  const overallTrend = currentExposure < originalExposure * 0.9
    ? "Improving"
    : currentExposure > originalExposure * 1.1
    ? "Worsening"
    : "Stable";

  const trendEmoji = (trend: TrendType): string => {
    if (trend === "Improving") return "📉";
    if (trend === "Worsening") return "📈";
    if (trend === "Closed") return "✅";
    if (trend === "Realized") return "🔴";
    return "➡️";
  };

  const lines: string[] = [
    `# Risk Monitoring Report — ${params.projectName}`,
    `**Generated:** ${date}`,
    `**Framework:** PMI PMBOK-Aligned`,
    "",
    "## Overall Risk Profile",
    "| Metric | Value |",
    "|--------|-------|",
    `| Total Tracked Risks | ${params.currentRisks.length} |`,
    `| Open / Active | ${openRisks.length} |`,
    `| Escalated | ${risksWithTrend.filter((r) => r.status === "escalated").length} |`,
    `| Closed | ${risksWithTrend.filter((r) => r.status === "closed").length} |`,
    `| Realized | ${realized.length} |`,
    `| Overall Risk Trend | **${overallTrend}** |`,
    `| Current Exposure Score | ${Math.round(currentExposure * 10) / 10} |`,
    `| Original Exposure Score | ${Math.round(originalExposure * 10) / 10} |`,
    "",
    "## Risk Trend Analysis",
    "",
    "| ID | Description | Orig Score | Curr Score | Δ | Trend | Status |",
    "|----|-------------|-----------|-----------|---|-------|--------|",
    ...risksWithTrend.map((r) =>
      `| ${r.id} | ${r.description} | ${r.originalScore} | ${r.currentScore} | ${r.delta > 0 ? "+" : ""}${Math.round(r.delta * 10) / 10} | ${trendEmoji(r.trend)} ${r.trend} | ${r.status} |`
    ),
    "",
  ];

  if (worsening.length > 0) {
    lines.push(
      "## Risks Requiring Immediate Attention",
      "_The following risks have worsened since last review and require escalation or response adjustment:_",
      "",
      ...worsening.map((r) => [
        `### ${r.id}: ${r.description}`,
        `**Score change:** ${r.originalScore} → ${r.currentScore} (+${Math.round(r.delta * 10) / 10})`,
        `**Recommended action:** Revisit response strategy — current approach is insufficient.`,
        "",
      ].join("\n")),
    );
  }

  if (improving.length > 0) {
    lines.push(
      "## Risks Trending Positively",
      ...improving.map((r) => `- **${r.id}:** ${r.description} (${r.originalScore} → ${r.currentScore})`),
      ""
    );
  }

  if (realized.length > 0) {
    lines.push(
      "## Realized Risks — Impact Assessment Needed",
      ...realized.map((r) => `- **${r.id}:** ${r.description} — Document actual impact and activate contingency plan.`),
      ""
    );
  }

  lines.push(
    "## Recommended Next Steps",
    `1. Review ${worsening.length} worsening risk(s) with risk owners within 48 hours`,
    "2. Update response plans for any risks that have exceeded threshold scores",
    "3. Confirm contingency plans are activated for realized risks",
    "4. Validate closed risks have sufficient acceptance documentation",
    "5. Schedule next risk review per risk management plan cadence",
    "",
    "---",
    "_Generated by Lliam PM Risk Intelligence — PMI PMBOK-Aligned_"
  );

  return lines.join("\n");
}

// ─── Plugin Definition ────────────────────────────────────────────────────────

const pmRiskPlugin: PluginModule = {
  id: "executive.pm-risk",
  name: "PM Risk Intelligence",
  version: "1.0.0",
  description: "Risk lifecycle management with PMI-aligned processes: identify, analyze, respond, register, monitor",

  register(api: PluginAPI): void {

    // ─── identify_risks ──────────────────────────────────────────

    api.registerTool({
      name: "identify_risks",
      description:
        "Use PMI ontology risk categories to structure a comprehensive risk identification analysis. " +
        "Returns a structured prompt and risk list with category, trigger, and suggested owner " +
        "across Technical, Schedule, Cost, Resource, Scope, Quality, Stakeholder, External, and Organizational dimensions.",
      parameters: {
        type: "object" as const,
        properties: {
          projectName: { type: "string", description: "Project name" },
          projectDescription: { type: "string", description: "Description of the project, its objectives, and key constraints" },
          phase: { type: "string", description: "Current project phase (e.g. 'Planning', 'Executing') (optional)" },
          existingRisks: {
            type: "array",
            items: { type: "string" },
            description: "Risks already identified — will be excluded from new output (optional)",
          },
        },
        required: ["projectName", "projectDescription"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const content = buildRiskIdentificationPrompt(
          String(params["projectName"]),
          String(params["projectDescription"]),
          params["phase"] ? String(params["phase"]) : "Not specified",
          (params["existingRisks"] as string[]) ?? []
        );
        return { content };
      },
    });

    // ─── analyze_risk ────────────────────────────────────────────

    api.registerTool({
      name: "analyze_risk",
      description:
        "Perform qualitative and quantitative risk analysis. Computes P×I risk score, " +
        "maps to risk matrix quadrant (High/Medium/Low), suggests PMI response strategy " +
        "(avoid/transfer/mitigate/accept), and optionally calculates EMV.",
      parameters: {
        type: "object" as const,
        properties: {
          riskDescription: { type: "string", description: "Risk description (cause → event → effect format recommended)" },
          probability: { type: "number", description: "Probability score 1–5 (1=Very Low, 5=Very High)" },
          impact: { type: "number", description: "Impact score 1–5 (1=Very Low, 5=Very High)" },
          projectPhase: { type: "string", description: "Current project phase (optional)" },
          costDataAvailable: { type: "boolean", description: "Include EMV calculation template (optional, default: false)" },
        },
        required: ["riskDescription", "probability", "impact"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const probability = Number(params["probability"]);
        const impact = Number(params["impact"]);

        if (probability < 1 || probability > 5 || impact < 1 || impact > 5) {
          return { content: "Error: probability and impact must be between 1 and 5 (inclusive)." };
        }

        const content = buildRiskAnalysis(
          String(params["riskDescription"]),
          probability,
          impact,
          params["projectPhase"] ? String(params["projectPhase"]) : "Not specified",
          Boolean(params["costDataAvailable"] ?? false)
        );

        return { content };
      },
    });

    // ─── plan_risk_response ──────────────────────────────────────

    api.registerTool({
      name: "plan_risk_response",
      description:
        "Generate a detailed risk response plan with PMI-aligned action items, residual risk estimate, " +
        "and contingency plan. Strategy must be one of: avoid, transfer, mitigate, accept.",
      parameters: {
        type: "object" as const,
        properties: {
          riskDescription: { type: "string", description: "Risk description" },
          riskScore: { type: "number", description: "Current risk score (P×I, 1–25 scale)" },
          responseStrategy: {
            type: "string",
            enum: ["avoid", "transfer", "mitigate", "accept"],
            description: "PMI risk response strategy",
          },
          availableBudget: {
            type: "number",
            description: "Available budget for risk response (optional — enables budget allocation section)",
          },
        },
        required: ["riskDescription", "riskScore", "responseStrategy"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const strategy = String(params["responseStrategy"]) as ResponseStrategy;
        const validStrategies: ResponseStrategy[] = ["avoid", "transfer", "mitigate", "accept"];

        if (!validStrategies.includes(strategy)) {
          return { content: `Error: responseStrategy must be one of: ${validStrategies.join(", ")}` };
        }

        const content = buildRiskResponsePlan(
          String(params["riskDescription"]),
          Number(params["riskScore"]),
          strategy,
          params["availableBudget"] !== undefined ? Number(params["availableBudget"]) : undefined
        );

        return { content };
      },
    });

    // ─── create_risk_register ────────────────────────────────────

    api.registerTool({
      name: "create_risk_register",
      description:
        "Compile a complete project risk register from an array of risks. Computes P×I scores, " +
        "sorts by score descending, and includes summary stats (total, high/medium/low breakdown, " +
        "total risk exposure score).",
      parameters: {
        type: "object" as const,
        properties: {
          projectName: { type: "string", description: "Project name" },
          risks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                description: { type: "string" },
                category: { type: "string" },
                probability: { type: "number" },
                impact: { type: "number" },
                owner: { type: "string" },
                responseStrategy: { type: "string" },
              },
              required: ["description", "category", "probability", "impact"],
            },
            description: "Array of risk entries",
          },
        },
        required: ["projectName", "risks"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const content = buildFullRiskRegister({
          projectName: String(params["projectName"]),
          risks: params["risks"] as Array<{
            description: string;
            category: string;
            probability: number;
            impact: number;
            owner?: string;
            responseStrategy?: string;
          }>,
        });

        return { content };
      },
    });

    // ─── monitor_risks ───────────────────────────────────────────

    api.registerTool({
      name: "monitor_risks",
      description:
        "Produce a risk monitoring report with trend analysis. Compares current vs. original " +
        "P×I scores to classify each risk as Improving/Worsening/Stable. Surfaces risks requiring " +
        "immediate attention and produces overall portfolio trend assessment.",
      parameters: {
        type: "object" as const,
        properties: {
          projectName: { type: "string", description: "Project name" },
          currentRisks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                description: { type: "string" },
                currentProbability: { type: "number" },
                currentImpact: { type: "number" },
                originalProbability: { type: "number" },
                originalImpact: { type: "number" },
                status: { type: "string", enum: ["open", "closed", "escalated", "realized"] },
              },
              required: ["id", "description", "currentProbability", "currentImpact", "originalProbability", "originalImpact", "status"],
            },
            description: "Array of risks with current and original scores",
          },
        },
        required: ["projectName", "currentRisks"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const content = buildRiskMonitoringReport({
          projectName: String(params["projectName"]),
          currentRisks: params["currentRisks"] as Array<{
            id: string;
            description: string;
            currentProbability: number;
            currentImpact: number;
            originalProbability: number;
            originalImpact: number;
            status: RiskStatus;
          }>,
        });

        return { content };
      },
    });

    api.logger.info("PM Risk Intelligence plugin registered.");
  },
};

export default pmRiskPlugin;
