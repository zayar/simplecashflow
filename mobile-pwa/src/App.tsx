import React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { ProtectedRoute } from './components/ProtectedRoute';
import Login from './pages/Login';
import Register from './pages/Register';
import Dashboard from './pages/Dashboard';
import Invoices from './pages/Invoices';
import InvoiceNew from './pages/InvoiceNew';
import InvoiceLine from './pages/InvoiceLine';
import Customers from './pages/Customers';
import Items from './pages/Items';
import CustomerNew from './pages/CustomerNew';
import CustomerEdit from './pages/CustomerEdit';
import ItemNew from './pages/ItemNew';
import ItemEdit from './pages/ItemEdit';
import InvoiceDetail from './pages/InvoiceDetail';
import InvoicePayment from './pages/InvoicePayment';
import Warehouses from './pages/Warehouses';
import PublicInvoice from './pages/PublicInvoice';
import Expenses from './pages/Expenses';
import ExpenseNew from './pages/ExpenseNew';
import Reports from './pages/Reports';
import Settings from './pages/Settings';

function NotFound() {
  return (
    <div className="min-h-dvh grid place-items-center px-6">
      <div className="max-w-md text-center">
        <div className="text-lg font-semibold">Page not found</div>
        <div className="mt-2 text-sm text-slate-400">That route does not exist.</div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/public/invoices/:token" element={<PublicInvoice />} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Invoices />
          </ProtectedRoute>
        }
      />
      <Route
        path="/invoices"
        element={
          <ProtectedRoute>
            <Invoices />
          </ProtectedRoute>
        }
      />
      <Route
        path="/invoices/new"
        element={
          <ProtectedRoute>
            <InvoiceNew />
          </ProtectedRoute>
        }
      />
      <Route
        path="/invoices/new/line"
        element={
          <ProtectedRoute>
            <InvoiceLine />
          </ProtectedRoute>
        }
      />
      <Route
        path="/invoices/:id"
        element={
          <ProtectedRoute>
            <InvoiceDetail />
          </ProtectedRoute>
        }
      />
      <Route
        path="/invoices/:id/payment"
        element={
          <ProtectedRoute>
            <InvoicePayment />
          </ProtectedRoute>
        }
      />
      <Route
        path="/customers"
        element={
          <ProtectedRoute>
            <Customers />
          </ProtectedRoute>
        }
      />
      <Route
        path="/customers/new"
        element={
          <ProtectedRoute>
            <CustomerNew />
          </ProtectedRoute>
        }
      />
      <Route
        path="/customers/:id"
        element={
          <ProtectedRoute>
            <CustomerEdit />
          </ProtectedRoute>
        }
      />
      <Route
        path="/items"
        element={
          <ProtectedRoute>
            <Items />
          </ProtectedRoute>
        }
      />
      <Route
        path="/items/new"
        element={
          <ProtectedRoute>
            <ItemNew />
          </ProtectedRoute>
        }
      />
      <Route
        path="/items/:id"
        element={
          <ProtectedRoute>
            <ItemEdit />
          </ProtectedRoute>
        }
      />
      <Route
        path="/more"
        element={
          <ProtectedRoute>
            <Dashboard />
          </ProtectedRoute>
        }
      />
      <Route
        path="/reports"
        element={
          <ProtectedRoute>
            <Reports />
          </ProtectedRoute>
        }
      />
      <Route
        path="/warehouses"
        element={
          <ProtectedRoute>
            <Warehouses />
          </ProtectedRoute>
        }
      />
      <Route
        path="/expenses"
        element={
          <ProtectedRoute>
            <Expenses />
          </ProtectedRoute>
        }
      />
      <Route
        path="/expenses/new"
        element={
          <ProtectedRoute>
            <ExpenseNew />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings"
        element={
          <ProtectedRoute>
            <Settings />
          </ProtectedRoute>
        }
      />
      <Route path="/404" element={<NotFound />} />
      <Route path="*" element={<Navigate to="/404" replace />} />
    </Routes>
  );
}


