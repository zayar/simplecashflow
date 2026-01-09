import { z } from 'zod';
import { getVertexConfig, vertexGenerateText } from '../providers/vertex.js';
import type { RunAgentInput, RunAgentOutput } from '../orchestrator.js';
import { CashflowCopilotInsightsSchema } from '../orchestrator.js';

const InputSchema = z.object({
  forecast: z.object({
    asOfDate: z.string(),
    scenario: z.enum(['base', 'conservative', 'optimistic']),
    currency: z.string().nullable(),
    warnings: z.array(z.string()).default([]),
    startingCash: z.string(),
    minCashBuffer: z.string(),
    lowestCash: z.object({ weekStart: z.string(), endingCash: z.string() }).nullable(),
    alerts: z.array(z.object({
      severity: z.enum(['high', 'medium', 'low']),
      code: z.string(),
      message: z.string(),
      weekStart: z.string().optional(),
    })).default([]),
    topInflows: z.array(z.object({
      kind: z.string(),
      id: z.number(),
      label: z.string(),
      expectedDate: z.string(),
      amount: z.string(),
    })).default([]),
    topOutflows: z.array(z.object({
      kind: z.string(),
      id: z.number(),
      label: z.string(),
      expectedDate: z.string(),
      amount: z.string(),
    })).default([]),
    series: z.array(z.object({
      weekStart: z.string(),
      cashIn: z.string(),
      cashOut: z.string(),
      net: z.string(),
      endingCash: z.string(),
    })).min(1),
  }),
});

// Very small in-memory cache to control cost (per process).
// Keyed by company + scenario + asOfDate + first/last series point + top drivers hash.
const cache = new Map<string, { expiresAt: number; value: any; traceId: string; model: string }>();

function stableKey(companyId: number, scenario: string, input: any): string {
  const first = input?.forecast?.series?.[0]?.weekStart ?? '';
  const last = input?.forecast?.series?.[input.forecast.series.length - 1]?.weekStart ?? '';
  const a0 = input?.forecast?.alerts?.[0]?.code ?? '';
  const i0 = input?.forecast?.topInflows?.[0]?.id ?? '';
  const o0 = input?.forecast?.topOutflows?.[0]?.id ?? '';
  return `${companyId}:${scenario}:${input.forecast.asOfDate}:${first}:${last}:${a0}:${i0}:${o0}`;
}

function extractJson(text: string): string {
  const s = String(text ?? '').trim();
  // Prefer fenced json blocks if present.
  const m = s.match(/```json\s*([\s\S]*?)```/i);
  if (m?.[1]) return m[1].trim();
  // Otherwise, try to locate the first { ... } block.
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) return s.slice(start, end + 1);
  return s;
}

function buildPrompt(args: {
  companyId: number;
  scenario: string;
  currency: string | null;
  forecast: any;
}): string {
  // Grounding: we pass only computed forecast + top drivers, not raw ledgers.
  // Strict output: JSON only. No prose outside JSON.
  return [
    `You are Cashflow Copilot for a small business owner.`,
    `Task: explain a 13-week cash forecast and propose next actions.`,
    ``,
    `RULES:`,
    `- You MUST use ONLY the provided data. Do not invent numbers or entities.`,
    `- Do NOT do math beyond comparing provided values.`,
    `- Output MUST be valid JSON matching the schema below. No markdown, no extra text.`,
    `- Recommended actions must be safe and operational (e.g., follow up invoices, delay non-urgent bills, add recurring items).`,
    `- For invoice/bill-related actions, you MUST reference a SPECIFIC document from the provided topInflows/topOutflows and include a deep link:`,
    `  - Invoice detail: /invoices/{id}`,
    `  - Purchase bill detail: /purchase-bills/{id}`,
    `  Example action title: "Follow up invoice INV-000123" with link.href "/invoices/123"`,
    `  Example action title: "Review bill PB-000019" with link.href "/purchase-bills/19"`,
    `- Only use list links (/invoices or /purchase-bills) if there are no specific documents provided.`,
    `- Prefer linking to existing screens: /banking, /cashflow-copilot`,
    ``,
    `Output JSON schema:`,
    `{"headline": string, "summary": string, "key_risks": [{"title": string,"severity":"high"|"medium"|"low","evidence": string}], "recommended_actions": [{"title": string,"why": string, "link"?: {"label": string, "href": string}}], "assumptions": [string], "confidence_notes": [string]}`,
    ``,
    `Context: companyId=${args.companyId}, scenario=${args.scenario}, currency=${args.currency ?? 'N/A'}`,
    ``,
    `Forecast (computed):`,
    JSON.stringify(
      {
        asOfDate: args.forecast.asOfDate,
        startingCash: args.forecast.startingCash,
        minCashBuffer: args.forecast.minCashBuffer,
        lowestCash: args.forecast.lowestCash,
        alerts: args.forecast.alerts,
        warnings: args.forecast.warnings,
        series: args.forecast.series,
        topInflows: args.forecast.topInflows,
        topOutflows: args.forecast.topOutflows,
      },
      null,
      2
    ),
  ].join('\n');
}

export async function runCashflowCopilotInsights(input: RunAgentInput): Promise<RunAgentOutput<any>> {
  const parsed = InputSchema.safeParse(input.input);
  if (!parsed.success) {
    return { ok: false, code: 'AI_SCHEMA_ERROR', error: 'invalid input to cashflow copilot insights' };
  }

  const vertex = getVertexConfig();
  if (!vertex) {
    return { ok: false, code: 'AI_NOT_CONFIGURED', error: 'Vertex AI is not configured (missing GCP_PROJECT_ID)' };
  }

  const key = stableKey(input.companyId, input.scenario, parsed.data);
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    return {
      ok: true,
      data: cached.value,
      provider: 'vertex',
      model: cached.model,
      cached: true,
      traceId: cached.traceId,
    };
  }

  const prompt = buildPrompt({
    companyId: input.companyId,
    scenario: input.scenario,
    currency: parsed.data.forecast.currency,
    forecast: parsed.data.forecast,
  });

  let text = '';
  let traceId = '';
  let model = vertex.model;
  try {
    const res = await vertexGenerateText({ config: vertex, prompt, temperature: 0.2, maxOutputTokens: 900 });
    text = res.text;
    traceId = res.traceId;
    model = res.model;
  } catch (e: any) {
    return { ok: false, code: 'AI_PROVIDER_ERROR', error: e?.message ?? 'Vertex AI request failed' };
  }

  const jsonText = extractJson(text);
  let obj: unknown;
  try {
    obj = JSON.parse(jsonText);
  } catch {
    return { ok: false, code: 'AI_SCHEMA_ERROR', error: 'AI returned invalid JSON' };
  }

  const out = CashflowCopilotInsightsSchema.safeParse(obj);
  if (!out.success) {
    return { ok: false, code: 'AI_SCHEMA_ERROR', error: 'AI output failed schema validation' };
  }

  cache.set(key, { value: out.data, expiresAt: now + 10 * 60_000, traceId, model });

  return {
    ok: true,
    data: out.data,
    provider: 'vertex',
    model,
    cached: false,
    traceId,
  };
}

