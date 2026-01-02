import React from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getPublicInvoice } from '../lib/ar';
import { InvoicePaper } from '../components/invoice/InvoicePaper';
import { Card } from '../components/ui/card';

export default function PublicInvoice() {
  const params = useParams();
  const token = String(params.token ?? '');

  const q = useQuery({
    queryKey: ['public-invoice', token],
    queryFn: async () => await getPublicInvoice(token),
    enabled: token.length > 10,
    retry: false,
  });

  return (
    <div className="min-h-dvh bg-background">
      <div className="mx-auto max-w-xl px-3 py-3">
        {q.isLoading ? (
          <Card className="rounded-2xl p-4 text-sm text-muted-foreground shadow-sm">Loading…</Card>
        ) : q.isError ? (
          <Card className="rounded-2xl p-4 text-sm text-destructive shadow-sm">
            {(q.error as any)?.message ? String((q.error as any).message) : 'Link is invalid or expired.'}
          </Card>
        ) : !q.data ? (
          <Card className="rounded-2xl p-4 text-sm text-muted-foreground shadow-sm">Not found.</Card>
        ) : (
          <Card className="overflow-hidden rounded-2xl shadow-sm">
            <InvoicePaper
              invoice={{
                invoiceNumber: q.data.invoice.invoiceNumber,
                status: q.data.invoice.status,
                invoiceDate: q.data.invoice.invoiceDate,
                dueDate: q.data.invoice.dueDate,
                currency: q.data.invoice.currency,
                total: q.data.invoice.total,
                totalPaid: q.data.invoice.totalPaid,
                remainingBalance: q.data.invoice.remainingBalance,
                customer: { name: q.data.invoice.customerName ?? null },
                location: q.data.invoice.locationName ? { name: q.data.invoice.locationName } : null,
                warehouse: null,
                customerNotes: q.data.invoice.customerNotes,
                termsAndConditions: q.data.invoice.termsAndConditions,
                taxAmount: q.data.invoice.taxAmount,
                lines: (q.data.invoice.lines ?? []).map((l: any) => ({
                  id: l.id,
                  quantity: l.quantity,
                  unitPrice: l.unitPrice,
                  discountAmount: l.discountAmount,
                  description: l.description,
                  item: l.itemName ? { name: l.itemName } : null,
                })),
              }}
              companyName={q.data.company.name}
              tz={q.data.company.timeZone}
              template={q.data.company.template}
            />
          </Card>
        )}
      </div>
    </div>
  );
}


