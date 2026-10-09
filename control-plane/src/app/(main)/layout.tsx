import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans_KR } from "next/font/google";
import { Suspense } from "react";
import "./globals.css";
import Link from "next/link";
import { validateRequest } from "@/lib/auth";
import Image from "next/image";
import { Toaster } from "@/components/ui/sonner";
import { ConfirmProvider } from "@/components/ui/confirm";
import { getHomepageUrl } from "@/lib/site-urls";
import { ThemeProvider } from "@/components/theme-provider";
import { ModeToggle } from "@/components/ModeToggle";
import { LoadingBar } from "@/components/LoadingBar";
import { PAYMENT_OPERATOR_USERS } from "@/lib/payments/support";
import {
  getUserEntitlement,
  PLAN_FEATURES,
  type Feature,
} from "@/lib/entitlements";
import { AccountMenu, NavLink, SupporterMenu } from "@/components/NavMenus";

// Korean comes in ~100 unicode-range slices per weight; the browser fetches
// only the ones a page uses, so nothing is preloaded.
const sans = IBM_Plex_Sans_KR({
  weight: ["400", "500", "700"],
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
  preload: false,
});
const mono = IBM_Plex_Mono({
  weight: ["400", "500", "600"],
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

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
  const features = new Set<Feature>(
    entitlement?.isSupporter
      ? (PLAN_FEATURES[entitlement.plan ?? "supporter"] ?? [])
      : [],
  );

  return (
    <html
      lang="ko"
      suppressHydrationWarning
      className={`${sans.variable} ${mono.variable}`}
    >
      <body>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <ConfirmProvider>
            <div className="bg-background h-screen flex flex-col">
              <nav className="relative bg-card border-b-2 border-line">
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                  {/* On a phone the links drop to a second row under the
                    logo and account controls. */}
                  <div className="flex flex-wrap items-center justify-between gap-x-2 pt-2 md:h-16 md:flex-nowrap md:py-0">
                    <Link
                      href="/"
                      className="flex h-12 shrink-0 items-center gap-2.5 group"
                    >
                      <Image
                        src="/logo.png"
                        alt=""
                        width={32}
                        height={32}
                        priority
                        className="[image-rendering:pixelated] transition-transform duration-200 group-hover:-translate-y-0.5"
                        style={{
                          filter: "var(--logo-filter, none)",
                        }}
                      />
                      <span className="whitespace-nowrap text-2xl font-bold tracking-tight text-foreground">
                        나루
                      </span>
                    </Link>

                    <div className="order-last -mx-2 flex w-[calc(100%+1rem)] items-center gap-1 overflow-x-auto py-1 [scrollbar-width:none] md:order-none md:mx-0 md:w-auto md:flex-1 md:justify-end [&::-webkit-scrollbar]:hidden">
                      <NavLink href="/board">게시판</NavLink>
                      <NavLink href="/docs">길잡이</NavLink>
                      {user && <NavLink href="/files">파일</NavLink>}
                      {entitlement?.isSupporter ? (
                        <SupporterMenu
                          analytics={features.has("analytics")}
                          database={features.has("database")}
                          customDomains={features.has("custom_domains")}
                          githubDeploys={features.has("github_deploys")}
                        />
                      ) : (
                        <NavLink href="/supporter">서포터</NavLink>
                      )}
                    </div>

                    <div className="flex shrink-0 items-center gap-1">
                      {user ? (
                        <AccountMenu
                          loginName={user.loginName}
                          paymentOperator={PAYMENT_OPERATOR_USERS.has(
                            user.loginName,
                          )}
                        />
                      ) : (
                        <>
                          <NavLink href="/login">로그인</NavLink>
                          <Link
                            href="/signup"
                            className="press mx-1 whitespace-nowrap border-2 border-line bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground"
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
                  <div className="border-t border-border bg-accent">
                    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-2.5">
                      <p className="font-mono text-sm flex items-center gap-2 whitespace-nowrap overflow-x-auto">
                        <span className="text-muted-foreground select-none">
                          {user.loginName}@naru:~$
                        </span>
                        <span className="text-muted-foreground select-none">
                          open
                        </span>
                        <Link
                          href={getHomepageUrl(user.loginName)}
                          target="_blank"
                          className="text-link font-medium underline-offset-4 hover:underline"
                        >
                          {getHomepageUrl(user.loginName)}
                        </Link>
                        <span
                          aria-hidden="true"
                          className="inline-block w-2 h-4 bg-primary animate-pulse motion-reduce:animate-none"
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
          </ConfirmProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
