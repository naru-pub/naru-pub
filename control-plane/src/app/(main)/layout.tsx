import type { Metadata } from "next";
import { Suspense } from "react";
import "./globals.css";
import Link from "next/link";
import { validateRequest } from "@/lib/auth";
import Image from "next/image";
import { Toaster } from "@/components/ui/sonner";
import { getHomepageUrl } from "@/lib/site-urls";
import { ThemeProvider } from "@/components/theme-provider";
import { ModeToggle } from "@/components/ModeToggle";
import { LoadingBar } from "@/components/LoadingBar";
import { hasSupportRelationship, PAYMENT_OPERATOR_USERS } from "@/lib/payments/support";
import { getUserFeatures, type Feature } from "@/lib/entitlements";
import { AccountMenu, DocsMenu, ExtensionsMenu } from "@/components/NavMenus";

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
  const [features, supportRelationship] = user
    ? await Promise.all([
        getUserFeatures(user.id),
        hasSupportRelationship(user.id),
      ])
    : [new Set<Feature>(), false];

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
            <nav className="relative bg-card border-b border-border">
              <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                <div className="flex items-center justify-between gap-2 h-16">
                  <div className="flex shrink-0 items-center">
                    <Link href="/" className="flex items-center gap-3 group">
                      <h1 className="whitespace-nowrap text-2xl font-bold text-foreground group-hover:text-primary transition-colors duration-200">
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

                  {/* Scrolls sideways on a phone rather than running into
                      the logo once every menu is showing. */}
                  <div className="flex min-w-0 items-center space-x-1 overflow-x-auto">
                    <Link
                      href="/board"
                      className="text-muted-foreground hover:text-foreground hover:bg-accent whitespace-nowrap px-2 sm:px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200"
                    >
                      게시판
                    </Link>
                    {user ? (
                      <>
                        <Link
                          href="/files"
                          className="text-muted-foreground hover:text-foreground hover:bg-accent whitespace-nowrap px-2 sm:px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200"
                        >
                          파일
                        </Link>
                        {features.has("database") && <DocsMenu />}
                        <ExtensionsMenu
                          analytics={features.has("analytics")}
                          database={features.has("database")}
                          customDomains={features.has("custom_domains")}
                          githubDeploys={features.has("github_deploys")}
                        />
                        <AccountMenu
                          loginName={user.loginName}
                          supporter={supportRelationship}
                          paymentOperator={PAYMENT_OPERATOR_USERS.has(
                            user.loginName,
                          )}
                        />
                      </>
                    ) : (
                      <>
                        <Link
                          href="/login"
                          className="text-muted-foreground hover:text-foreground hover:bg-accent whitespace-nowrap px-2 sm:px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200"
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
                  <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3">
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
              {/* useSearchParams needs a Suspense boundary to keep static
                  pages static. */}
              <Suspense fallback={null}>
                <LoadingBar />
              </Suspense>
            </nav>

            <main className="flex-1 min-h-0">{children}</main>
          </div>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
