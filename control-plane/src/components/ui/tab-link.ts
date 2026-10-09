import { cn } from "@/lib/utils"

// The underlined tab look, shared by the Radix Tabs in tabs.tsx and by tab
// rows whose tabs are links between pages. A plain module rather than part of
// tabs.tsx so server components can call it: tabs.tsx is a client module.
export const tabTriggerClass =
  "-mb-px inline-flex min-h-12 shrink-0 items-center whitespace-nowrap border-b-[3px] border-transparent px-3 text-[15px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-[state=active]:border-primary data-[state=active]:font-bold data-[state=active]:text-foreground"

export function tabLinkClass(active: boolean) {
  return cn(tabTriggerClass, active && "border-primary font-bold text-foreground")
}
