import { z } from 'zod';
export type AiAgentId = 'cashflow_copilot_insights';
export type RunAgentInput = {
    agentId: AiAgentId;
    companyId: number;
    userId: number | null;
    scenario: 'base' | 'conservative' | 'optimistic';
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
export declare const CashflowCopilotInsightsSchema: z.ZodObject<{
    headline: z.ZodString;
    summary: z.ZodString;
    key_risks: z.ZodArray<z.ZodObject<{
        title: z.ZodString;
        severity: z.ZodEnum<{
            high: "high";
            medium: "medium";
            low: "low";
        }>;
        evidence: z.ZodString;
    }, z.core.$strip>>;
    recommended_actions: z.ZodArray<z.ZodObject<{
        title: z.ZodString;
        why: z.ZodString;
        link: z.ZodOptional<z.ZodObject<{
            label: z.ZodString;
            href: z.ZodString;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    assumptions: z.ZodArray<z.ZodString>;
    confidence_notes: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
export type CashflowCopilotInsights = z.infer<typeof CashflowCopilotInsightsSchema>;
export declare function runAgent(input: RunAgentInput): Promise<RunAgentOutput<any>>;
//# sourceMappingURL=orchestrator.d.ts.map