import { redirect } from "next/navigation";
import { Globe2 } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { validateRequest } from "@/lib/auth";
import { db } from "@/lib/database";
import FediverseCard from "./FediverseCard";
import { DiscoverabilityForm } from "./DiscoverabilityForm";

// Free for everyone: this is how people find your 갠홈, not an extension that
// supporting unlocks.
export default async function PresencePage() {
  const { user } = await validateRequest();

  if (!user) {
    redirect("/");
  }

  const followerRows = await db
    .selectFrom("followers")
    .innerJoin("remote_actors", "remote_actors.id", "followers.remote_actor_id")
    .select([
      "remote_actors.iri as iri",
      "remote_actors.preferred_username as preferred_username",
      "remote_actors.profile_url as profile_url",
    ])
    .where("followers.user_id", "=", user.id)
    .orderBy("followers.id", "desc")
    .limit(200)
    .execute();

  const followers = followerRows.map((row) => {
    let host = "";
    try {
      host = new URL(row.iri).host;
    } catch {
      // fall through
    }
    const handle =
      row.preferred_username && host
        ? `@${row.preferred_username}@${host}`
        : row.iri;
    return {
      handle,
      url: row.profile_url ?? row.iri,
    };
  });
  const fediverseDomain = process.env.NEXT_PUBLIC_DOMAIN ?? "naru.pub";

  return (
    <div className="bg-background min-h-screen">
      <div className="mx-auto max-w-4xl space-y-8 p-6">
        <Card className="bg-card border-2 border-border shadow-lg">
          <CardHeader className="bg-secondary border-b-2 border-border">
            <CardTitle className="text-foreground flex items-center gap-2 text-xl font-bold">
              <Globe2 size={20} /> 공개 설정
            </CardTitle>
          </CardHeader>
          <CardContent className="p-6">
            <p className="text-muted-foreground text-base leading-relaxed">
              사람들이 내 갠홈을 어떻게 찾고 따라올 수 있는지 정합니다.
            </p>
          </CardContent>
        </Card>

        <FediverseCard
          loginName={user.loginName}
          domain={fediverseDomain}
          followers={followers}
        />
        <DiscoverabilityForm discoverable={user.discoverable} />
      </div>
    </div>
  );
}
