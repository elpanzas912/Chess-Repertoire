import type { Metadata } from "next";
import "./globals.css";
import "../lib/cm-chessboard-assets/chessboard.css";
import "../lib/cm-chessboard-assets/extensions/markers/markers.css";

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
