"use client";

import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

export default function LoginForm() {
  const searchParams = useSearchParams();
  const callbackUrl = searchParams?.get("callbackUrl") || "/dashboard";
  const loginUrl = `/.auth/login/aad?post_login_redirect_uri=${encodeURIComponent(callbackUrl)}`;

  return (
    <Card className="bg-white/90 shadow-xl backdrop-blur-lg border-slate-200">
      <CardHeader>
        <CardTitle className="text-2xl font-semibold text-slate-900">Sign in</CardTitle>
        <CardDescription className="text-slate-500">
          Use your organization Entra ID account to access VIPER.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-slate-600">
          Access is managed by the deployed app and your administrator-assigned role.
        </p>
      </CardContent>
      <CardFooter>
        <Button asChild className="w-full">
          <a href={loginUrl}>Continue with Entra ID</a>
        </Button>
      </CardFooter>
    </Card>
  );
}
