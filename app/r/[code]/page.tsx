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
        title="멀티플레이가 설정되지 않았습니다"
        body="방 기능을 쓰려면 SUPABASE_* 환경 변수를 설정하세요."
      />
    );
  }

  const room = await getRoom(code).catch(() => undefined);
  if (!room) {
    return <Notice title="방을 찾을 수 없습니다" body={`“${code}” 코드에 해당하는 방이 없습니다.`} />;
  }

  return (
    <Lobby code={code} ownerDeviceId={room.ownerDeviceId} initialSettings={room.settings} />
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <main className="landscape-notice game-bg flex h-dvh w-full flex-col items-center justify-center gap-4 px-6 text-center text-white">
      <h1 className="font-display text-2xl font-bold uppercase tracking-wide">{title}</h1>
      <p className="max-w-md text-white/60">{body}</p>
      <Link href="/" className="btn-race px-6 py-3">
        차고로 돌아가기
      </Link>
    </main>
  );
}
