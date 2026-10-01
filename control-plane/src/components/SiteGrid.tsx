import Image from "next/image";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { getHomepageUrl, getRenderedSiteUrl } from "@/lib/site-urls";

export interface SiteGridUser {
  id: string;
  login_name: string;
  site_rendered_at: Date | null;
}

// Screenshots of discoverable sites, linking to each one. Shared by the home
// page's 최근 업데이트된 and /sites.
export function SiteGrid({ users }: { users: SiteGridUser[] }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(220px,100%),1fr))] gap-4">
      {users.map((user) => (
        <div
          key={user.id}
          className="bg-card border border-border rounded-lg p-3 shadow-sm hover:shadow-md transition-shadow duration-200"
        >
          <Link
            href={getHomepageUrl(user.login_name)}
            target="_blank"
            className="block"
          >
            <div className="border border-border rounded mb-3 overflow-hidden">
              <Image
                src={getRenderedSiteUrl(user.login_name, user.site_rendered_at)}
                alt="screenshot"
                width={320}
                height={240}
                className="w-full h-auto hover:opacity-90 transition-opacity"
              />
            </div>
            <Button
              variant="outline"
              className="w-full border-border text-muted-foreground hover:bg-background bg-card"
            >
              {user.login_name}
            </Button>
          </Link>
        </div>
      ))}
    </div>
  );
}
