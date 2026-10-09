import Image from "next/image";
import Link from "next/link";
import { BrowserFrame, SiteAddress } from "@/components/BrowserFrame";
import { getHomepageUrl, getRenderedSiteUrl } from "@/lib/site-urls";

export interface SiteGridUser {
  id: string;
  login_name: string;
  site_rendered_at: Date | null;
}

// Screenshots of discoverable sites, linking to each one. Shared by the home
// page's 방금 고쳐진 사이트들 and /sites.
export function SiteGrid({
  users,
  priorityCount = 0,
}: {
  users: SiteGridUser[];
  // How many leading screenshots are above the fold and load eagerly.
  priorityCount?: number;
}) {
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(230px,100%),1fr))] gap-6">
      {users.map((user, index) => (
        <li key={user.id}>
          <Link
            href={getHomepageUrl(user.login_name)}
            target="_blank"
            className="lift block"
          >
            <BrowserFrame address={<SiteAddress loginName={user.login_name} />}>
              <div className="relative aspect-[4/3] bg-muted">
                <Image
                  src={getRenderedSiteUrl(
                    user.login_name,
                    user.site_rendered_at,
                  )}
                  alt={`${user.login_name}의 사이트`}
                  fill
                  sizes="(max-width: 640px) 100vw, 320px"
                  priority={index < priorityCount}
                  // A missing screenshot leaves the muted frame, not alt text.
                  className="object-cover object-top text-transparent"
                />
              </div>
            </BrowserFrame>
          </Link>
        </li>
      ))}
    </ul>
  );
}
