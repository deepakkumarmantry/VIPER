import { Inter } from "next/font/google";
import "./globals.css";
import AppProviders from "@/components/providers/session-provider";

const inter = Inter({ subsets: ["latin"] });

export const metadata = {
  title: "VIPER",
  description: "Video Intelligence Platform for Enterprise Review",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className={`${inter.className} bg-slate-100 text-slate-900`}>
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
