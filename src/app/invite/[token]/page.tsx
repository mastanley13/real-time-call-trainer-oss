import InviteAccept from "@/components/InviteAccept";

export const metadata = { title: "Team invite · Real-Time Call Trainer", robots: { index: false, follow: false } };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <InviteAccept token={token} />;
}
