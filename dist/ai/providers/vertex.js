import { VertexAI } from '@google-cloud/vertexai';
function requireEnv(name) {
    const v = process.env[name];
    const s = v ? String(v).trim() : '';
    return s ? s : null;
}
export function getVertexConfig() {
    const projectId = requireEnv('GCP_PROJECT_ID') ?? requireEnv('GOOGLE_CLOUD_PROJECT');
    const location = requireEnv('GCP_LOCATION') ?? requireEnv('VERTEX_LOCATION') ?? 'asia-southeast1';
    const model = requireEnv('VERTEX_GEMINI_MODEL') ?? 'gemini-1.5-flash';
    if (!projectId)
        return null;
    return { projectId, location, model };
}
export async function vertexGenerateText(args) {
    const traceId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const vertex = new VertexAI({ project: args.config.projectId, location: args.config.location });
    // Note: keep it simple: one-shot generation + strict JSON in prompt.
    const model = vertex.getGenerativeModel({
        model: args.config.model,
        generationConfig: {
            temperature: args.temperature ?? 0.2,
            maxOutputTokens: args.maxOutputTokens ?? 800,
        },
    });
    const resp = await model.generateContent({
        contents: [
            {
                role: 'user',
                parts: [{ text: args.prompt }],
            },
        ],
    });
    const text = resp?.response?.candidates?.[0]?.content?.parts?.map((p) => p?.text ?? '').join('') ??
        resp?.response?.text?.() ??
        '';
    return { text: String(text ?? ''), model: args.config.model, traceId };
}
//# sourceMappingURL=vertex.js.map