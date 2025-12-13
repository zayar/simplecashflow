'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { fetchApi } from '@/lib/api';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Plus } from 'lucide-react';

export default function CustomersPage() {
  const { user } = useAuth();
  const [customers, setCustomers] = useState<any[]>([]);

  useEffect(() => {
    if (user?.companyId) {
      fetchApi(`/companies/${user.companyId}/customers`)
        .then(setCustomers)
        .catch(console.error);
    }
  }, [user?.companyId]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Customers</h1>
        <Link href="/customers/new">
          <Button className="gap-2">
            <Plus className="h-4 w-4" /> New Customer
          </Button>
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All Customers</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="relative w-full overflow-auto">
            <table className="w-full caption-bottom text-sm text-left">
              <thead className="[&_tr]:border-b">
                <tr className="border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted">
                  <th className="h-12 px-4 align-middle font-medium text-muted-foreground">Name</th>
                  <th className="h-12 px-4 align-middle font-medium text-muted-foreground">Email</th>
                  <th className="h-12 px-4 align-middle font-medium text-muted-foreground">Phone</th>
                  <th className="h-12 px-4 align-middle font-medium text-muted-foreground">Currency</th>
                </tr>
              </thead>
              <tbody className="[&_tr:last-child]:border-0">
                {customers.map((c) => (
                  <tr key={c.id} className="border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted">
                    <td className="p-4 align-middle font-medium">{c.name}</td>
                    <td className="p-4 align-middle">{c.email || '-'}</td>
                    <td className="p-4 align-middle">{c.phone || '-'}</td>
                    <td className="p-4 align-middle">{c.currency || '-'}</td>
                  </tr>
                ))}
                {customers.length === 0 && (
                  <tr>
                    <td colSpan={4} className="p-4 text-center text-muted-foreground">
                      No customers found.
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
