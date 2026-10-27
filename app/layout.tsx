import type { Metadata } from "next";
import { Inter, Lora } from "next/font/google";
import "./globals.css";
import PomodoroProvider from "@/components/learn/PomodoroProvider";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const lora = Lora({
  variable: "--font-lora",
  subsets: ["latin"],
  style: ["normal", "italic"],
});

export const metadata: Metadata = {
  title: "Hugh: learn data and analytics by conversation",
  description: "Hugh teaches through conversation like a chatbot, keeps you to a source-checked syllabus the way a course does, and counts something as learned only once you've proven it in your own words.",
  openGraph: {
    title:       "Hugh: learn data and analytics by conversation",
    description: "Learn data and analytics by talking it through, on a source-checked syllabus, and prove it in your own words.",
    siteName:    "Hugh",
  },
  twitter: {
    card:        "summary",
    title:       "Hugh: learn data and analytics by conversation",
    description: "Learn data and analytics by talking it through, on a source-checked syllabus, and prove it in your own words.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} ${lora.variable} h-full`}>
      <body className="h-full bg-[#0F172A] font-sans text-slate-100 antialiased">
        <PomodoroProvider>
          {children}
        </PomodoroProvider>
      </body>
    </html>
  );
}
