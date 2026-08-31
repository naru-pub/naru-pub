import type { Metadata } from "next";
import "./globals.css";
import Link from "next/link";
import { validateRequest } from "@/lib/auth";
import Image from "next/image";
import { Toaster } from "@/components/ui/sonner";
import { getHomepageUrl } from "@/lib/utils";
import { ThemeProvider } from "@/components/theme-provider";
import { ModeToggle } from "@/components/ModeToggle";
import { SUPPORT_VISIBLE_USERS } from "@/lib/support";
import { getUserEntitlement, PLAN_FEATURES } from "@/lib/entitlements";

export const metadata: Metadata = {
  title: "나루",
  description: "당신의 공간이 되는, 나루.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { user } = await validateRequest();
  const entitlement = user ? await getUserEntitlement(user.id) : null;
  const features = entitlement?.isSupporter
    ? (PLAN_FEATURES[entitlement.plan ?? "supporter"] ?? [])
    : [];
  const analyticsEnabled = features.includes("analytics");
  const supporterToolsEnabled =
    features.includes("custom_domains") || features.includes("github_deploys");

  return (
    <html lang="ko" suppressHydrationWarning>
      <body className="font-mono">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <div className="bg-background h-screen flex flex-col">
            <nav className="bg-card border-b border-border">
              <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
                <div className="flex items-center justify-between h-16">
                  <div className="flex items-center">
                    <Link href="/" className="flex items-center gap-3 group">
                      <h1 className="text-2xl font-bold text-foreground group-hover:text-primary transition-colors duration-200">
                        나루
                      </h1>
                      <Image
                        src="/logo.png"
                        alt="logo"
                        width={28}
                        height={28}
                        className="group-hover:scale-110 transition-transform duration-200"
                        style={{
                          filter: "var(--logo-filter, none)",
                        }}
                      />
                    </Link>
                  </div>

                  <div className="flex items-center space-x-1">
                    <Link
                      href="/"
                      className="text-muted-foreground hover:text-foreground hover:bg-accent px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200"
                    >
                      소개
                    </Link>
                    <Link
                      href="/open"
                      className="text-muted-foreground hover:text-foreground hover:bg-accent px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200"
                    >
                      지표
                    </Link>
                    {user ? (
                      <>
                        <Link
                          href="/files"
                          className="text-muted-foreground hover:text-foreground hover:bg-accent px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200"
                        >
                          파일
                        </Link>
                        {analyticsEnabled && (
                          <Link
                            href="/analytics"
                            className="text-muted-foreground hover:text-foreground hover:bg-accent px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200"
                          >
                            분석
                          </Link>
                        )}
                        {supporterToolsEnabled && (
                          <Link
                            href="/supporters"
                            className="text-muted-foreground hover:text-foreground hover:bg-accent px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200"
                          >
                            후원자
                          </Link>
                        )}
                        {SUPPORT_VISIBLE_USERS.has(user.loginName) && (
                          <Link
                            href="/support"
                            className="text-muted-foreground hover:text-foreground hover:bg-accent px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200"
                          >
                            후원
                          </Link>
                        )}
                        <Link
                          href="/account"
                          className="text-muted-foreground hover:text-foreground hover:bg-accent px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200"
                        >
                          계정
                        </Link>
                      </>
                    ) : (
                      <>
                        <Link
                          href="/login"
                          className="text-muted-foreground hover:text-foreground hover:bg-accent px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200"
                        >
                          로그인
                        </Link>
                        <Link
                          href="/signup"
                          className="bg-primary hover:bg-primary/90 text-primary-foreground px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200 shadow-sm hover:shadow-md"
                        >
                          회원가입
                        </Link>
                      </>
                    )}
                    <ModeToggle />
                  </div>
                </div>
              </div>

              {user && (
                <div className="border-t border-border bg-primary/5">
                  <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-3">
                    <p className="text-sm flex items-center gap-2 whitespace-nowrap overflow-x-auto">
                      <span className="text-muted-foreground select-none">
                        {user.loginName}@naru:~$
                      </span>
                      <span className="text-muted-foreground select-none">
                        open
                      </span>
                      <Link
                        href={getHomepageUrl(user.loginName)}
                        target="_blank"
                        className="text-primary font-medium hover:underline transition-colors duration-200"
                      >
                        {getHomepageUrl(user.loginName)}
                      </Link>
                      <span
                        aria-hidden="true"
                        className="inline-block w-2 h-4 bg-primary/70 animate-pulse"
                      />
                    </p>
                  </div>
                </div>
              )}
            </nav>

            <main className="flex-1 min-h-0">{children}</main>
          </div>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
