import { z } from 'zod';
import { runCashflowCopilotInsights } from './usecases/cashflowCopilotInsights.js';

export type AiAgentId = 'cashflow_copilot_insights';

export type RunAgentInput = {
  agentId: AiAgentId;
  companyId: number;
  userId: number | null;
  scenario: 'base' | 'conservative' | 'optimistic';
  // The orchestrator is intentionally limited for MVP: agent runs must be grounded on structured inputs.
  input: unknown;
};

export type RunAgentOutput<T> = {
  ok: true;
  data: T;
  provider: 'vertex';
  model: string;
  cached: boolean;
  traceId: string;
} | {
  ok: false;
  error: string;
  code: 'AI_NOT_CONFIGURED' | 'AI_PROVIDER_ERROR' | 'AI_SCHEMA_ERROR';
};

// Small helper so routes can validate contract without importing agent internals.
export const CashflowCopilotInsightsSchema = z.object({
  headline: z.string().min(1).max(300),
  summary: z.string().min(1).max(1200),
  key_risks: z.array(z.object({
    title: z.string().min(1).max(160),
    severity: z.enum(['high', 'medium', 'low']),
    evidence: z.string().min(1).max(280),
  })).max(10),
  recommended_actions: z.array(z.object({
    title: z.string().min(1).max(160),
    why: z.string().min(1).max(260),
    link: z.object({
      label: z.string().min(1).max(60),
      href: z.string().min(1).max(200),
    }).optional(),
  })).max(10),
  assumptions: z.array(z.string().min(1).max(200)).max(10),
  confidence_notes: z.array(z.string().min(1).max(200)).max(10),
});

export type CashflowCopilotInsights = z.infer<typeof CashflowCopilotInsightsSchema>;

export async function runAgent(input: RunAgentInput): Promise<RunAgentOutput<any>> {
  if (input.agentId === 'cashflow_copilot_insights') {
    return await runCashflowCopilotInsights(input);
  }
  return { ok: false, code: 'AI_PROVIDER_ERROR', error: 'unknown agent' };
}

