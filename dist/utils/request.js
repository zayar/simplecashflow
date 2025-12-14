export function parseCompanyId(params) {
    const raw = params?.companyId;
    const n = Number(raw);
    if (!raw || Number.isNaN(n))
        return null;
    return n;
}
//# sourceMappingURL=request.js.map