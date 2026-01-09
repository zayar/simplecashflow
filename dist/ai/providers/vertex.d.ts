export type VertexConfig = {
    projectId: string;
    location: string;
    model: string;
};
export type VertexGenerateResult = {
    text: string;
    model: string;
    traceId: string;
};
export declare function getVertexConfig(): VertexConfig | null;
export declare function vertexGenerateText(args: {
    config: VertexConfig;
    prompt: string;
    temperature?: number;
    maxOutputTokens?: number;
}): Promise<VertexGenerateResult>;
//# sourceMappingURL=vertex.d.ts.map