import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "EVE CCTV · 감시 기록",
  description: "EVE Online 스크린샷 기반 로컬 감시 분석 콘솔",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko"><body>{children}</body></html>;
}
