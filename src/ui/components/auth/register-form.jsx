"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

export default function RegisterForm() {
  return (
    <Card className="bg-white/90 shadow-xl backdrop-blur-lg border-slate-200">
      <CardHeader>
        <CardTitle className="text-2xl font-semibold text-slate-900">Access is managed</CardTitle>
        <CardDescription className="text-slate-500">
          VIPER uses your organization's Entra ID authentication.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-slate-600">
          Ask a VIPER administrator to grant the appropriate organization or collection role
          after you sign in.
        </p>
      </CardContent>
      <CardFooter>
        <Button asChild className="w-full">
          <a href="/login">Go to sign in</a>
        </Button>
      </CardFooter>
    </Card>
  );
}
