import { Button } from "@/components/ui/button";

export default function SignOutButton() {
  return (
    <Button asChild size="sm" variant="outline">
      <a href="/.auth/logout?post_logout_redirect_uri=/">Sign out</a>
    </Button>
  );
}
