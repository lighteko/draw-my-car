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
    <main className="game-bg flex h-dvh w-full flex-col items-center justify-center gap-4 px-6 text-center text-white">
      <h1 className="font-heading text-2xl font-bold uppercase tracking-wide">{title}</h1>
      <p className="max-w-md text-white/60">{body}</p>
      <Link href="/" className="btn-race px-6 py-3">
        Back to garage
      </Link>
    </main>
  );
}
