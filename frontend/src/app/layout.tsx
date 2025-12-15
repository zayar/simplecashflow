import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/contexts/auth-context";
import { AppFrame } from "@/components/app-frame";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Cashflow App",
  description: "Simple bookkeeping for multi-merchant businesses",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <AuthProvider>
          <AppFrame>{children}</AppFrame>
        </AuthProvider>
      </body>
    </html>
  );
}
