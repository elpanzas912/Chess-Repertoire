import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ChessEngineered | Opening repertoire",
  description: "Practice chess openings with move-by-move training.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
