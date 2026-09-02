import { validateRequest } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import LogoutButton from "./LogoutButton";
import DeleteAccountButton from "./DeleteAccountButton";
import DownloadDirectoryButton from "./DownloadDirectoryButton";
import ChangePasswordForm from "./ChangePasswordForm";
import EmailManagement from "./EmailManagement";
import { hasVerifiedEmail } from "@/lib/support";
import { Settings, User } from "lucide-react";

export default async function AccountPage() {
  const { user } = await validateRequest();

  if (!user) {
    redirect("/");
  }

  return (
    <div className="bg-background min-h-screen">
      <div className="max-w-4xl mx-auto p-6 space-y-8">
        <Card className="bg-card border-2 border-border shadow-lg">
          <CardHeader className="bg-secondary border-b-2 border-border">
            <CardTitle className="text-foreground text-xl font-bold flex items-center gap-2">
              <User size={20} /> 계정 관리
            </CardTitle>
          </CardHeader>
          <CardContent className="p-6 space-y-4">
            <div className="bg-background border border-border rounded p-3">
              <p className="text-muted-foreground text-base leading-relaxed mb-2">
                안녕하세요,{" "}
                <strong className="text-primary">{user.loginName}</strong>님!
              </p>
              <p className="text-muted-foreground text-base leading-relaxed">
                나루와 {user.createdAt.getFullYear()}년{" "}
                {user.createdAt.getMonth() + 1}
                월부터 함께해 주셨어요.
              </p>
            </div>
          </CardContent>
        </Card>

        <EmailManagement
          currentEmail={user.email}
          emailVerifiedAt={user.emailVerifiedAt}
        />
        <ChangePasswordForm />

        <Card className="bg-card border-2 border-border shadow-lg">
          <CardHeader className="bg-secondary border-b-2 border-border">
            <CardTitle className="text-foreground text-xl font-bold flex items-center gap-2">
              <Settings size={20} /> 계정 작업
            </CardTitle>
          </CardHeader>
          <CardContent className="p-6">
            <div className="flex flex-row gap-4 flex-wrap">
              <DownloadDirectoryButton
                hasVerifiedEmail={hasVerifiedEmail(user)}
              />
              <LogoutButton />
              <DeleteAccountButton />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
