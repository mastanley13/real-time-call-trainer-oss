import { FREE_SIGNUP_LINE } from "@/lib/registerForm";
import { pageMetadata } from "@/lib/seo";

// The sign-up page is a client component, so its title and description live here.
export const metadata = pageMetadata({
  title: "Create your account | Call Trainer",
  description: `Create your Call Trainer account and start practicing sales calls. ${FREE_SIGNUP_LINE}`,
  path: "/register",
});

export default function RegisterLayout({ children }: { children: React.ReactNode }) {
  return children;
}
