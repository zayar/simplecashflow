export function parseCompanyId(params: any): number | null {
  const raw = params?.companyId;
  const n = Number(raw);
  if (!raw || Number.isNaN(n)) return null;
  return n;
}

