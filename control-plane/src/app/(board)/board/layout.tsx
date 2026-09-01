import type { Metadata } from "next";
import { BusinessFooter } from "@/components/BusinessFooter";

export const metadata: Metadata = {
  title: "나루",
  description: "당신의 공간이 되는, 나루.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body className="font-mono">
        <main>{children}</main>
        <BusinessFooter />
      </body>
    </html>
  );
}
