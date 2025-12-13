'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { fetchApi } from '@/lib/api';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Plus, CheckCircle, DollarSign } from 'lucide-react';

export default function InvoicesPage() {
  const { user } = useAuth();
  const [invoices, setInvoices] = useState<any[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (user?.companyId) {
      fetchApi(`/companies/${user.companyId}/invoices`)
        .then(setInvoices)
        .catch(console.error);
    }
  }, [user?.companyId, refreshKey]);

  const handlePost = async (invoiceId: number) => {
    if (!user?.companyId) return;
    if (!confirm('Are you sure you want to POST this invoice? This will create journal entries.')) return;

    try {
      await fetchApi(`/companies/${user.companyId}/invoices/${invoiceId}/post`, {
        method: 'POST',
        body: JSON.stringify({}), // Fix: Send empty JSON object to satisfy Content-Type
      });
      setRefreshKey((k) => k + 1); // Refresh list
    } catch (err: any) {
      console.error(err);
      alert(err.message || 'Failed to post invoice');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Invoices</h1>
        <Link href="/invoices/new">
          <Button className="gap-2">
            <Plus className="h-4 w-4" /> New Invoice
          </Button>
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All Invoices</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="relative w-full overflow-auto">
            <table className="w-full caption-bottom text-sm text-left">
              <thead className="[&_tr]:border-b">
                <tr className="border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted">
                  <th className="h-12 px-4 align-middle font-medium text-muted-foreground">Date</th>
                  <th className="h-12 px-4 align-middle font-medium text-muted-foreground">Number</th>
                  <th className="h-12 px-4 align-middle font-medium text-muted-foreground">Customer</th>
                  <th className="h-12 px-4 align-middle font-medium text-muted-foreground">Status</th>
                  <th className="h-12 px-4 align-middle font-medium text-muted-foreground text-right">Total</th>
                  <th className="h-12 px-4 align-middle font-medium text-muted-foreground text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="[&_tr:last-child]:border-0">
                {invoices.map((inv) => (
                  <tr key={inv.id} className="border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted">
                    <td className="p-4 align-middle">{new Date(inv.invoiceDate).toLocaleDateString()}</td>
                    <td className="p-4 align-middle font-medium">{inv.invoiceNumber}</td>
                    <td className="p-4 align-middle">{inv.customerName}</td>
                    <td className="p-4 align-middle">
                      <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 ${
                        inv.status === 'POSTED' ? 'bg-green-100 text-green-800' :
                        inv.status === 'PAID' ? 'bg-blue-100 text-blue-800' :
                        inv.status === 'DRAFT' ? 'bg-yellow-100 text-yellow-800' :
                        'bg-gray-100 text-gray-800'
                      }`}>
                        {inv.status}
                      </span>
                    </td>
                    <td className="p-4 align-middle text-right font-medium">{Number(inv.total).toLocaleString()}</td>
                    <td className="p-4 align-middle text-right flex justify-end gap-2">
                      {inv.status === 'DRAFT' && (
                        <Button variant="ghost" size="sm" onClick={() => handlePost(inv.id)}>
                          <CheckCircle className="mr-2 h-4 w-4" /> Post
                        </Button>
                      )}
                      {(inv.status === 'POSTED' || inv.status === 'PARTIAL') && (
                        <Link href={`/invoices/${inv.id}/payment`}>
                          <Button variant="ghost" size="sm">
                            <DollarSign className="mr-2 h-4 w-4" /> Pay
                          </Button>
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
                {invoices.length === 0 && (
                  <tr>
                    <td colSpan={6} className="p-4 text-center text-muted-foreground">
                      No invoices found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
