import Link from "next/link";
import { hasSupabase } from "@/lib/supabase";
import { getRoom } from "@/lib/rooms";
import { Lobby } from "@/components/Lobby";

/**
 * /r/[code] — the room lobby. Server component: resolves the room (for a share-link cold
 * load) and hands its owner + settings to the client <Lobby/>, which drives Realtime.
 */
export default async function RoomPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;

  if (!hasSupabase()) {
    return (
      <Notice
        title="Multiplayer isn't configured"
        body="Set the SUPABASE_* environment variables to enable rooms."
      />
    );
  }

  const room = await getRoom(code).catch(() => undefined);
  if (!room) {
    return <Notice title="Room not found" body={`No room matches the code “${code}”.`} />;
  }

  return (
    <Lobby code={code} ownerDeviceId={room.ownerDeviceId} initialSettings={room.settings} />
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <main className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-neutral-900 px-6 text-center text-white">
      <h1 className="text-2xl font-bold">{title}</h1>
      <p className="max-w-md text-neutral-400">{body}</p>
      <Link
        href="/"
        className="rounded-lg bg-emerald-600 px-5 py-2.5 font-semibold text-white transition hover:bg-emerald-500"
      >
        Back to garage
      </Link>
    </main>
  );
}
