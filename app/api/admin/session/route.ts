import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_MAX_AGE_S,
  adminSessionToken,
  isAdminAuthorized,
  isAdminConfigured,
  verifyAdminPassword,
} from "@/lib/adminAuth";

/** Current session state, for the admin page to decide whether to show the login. */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    configured: isAdminConfigured(),
    authorized: await isAdminAuthorized(),
  });
}

/** Log in: exchange the admin password for the HttpOnly session cookie. */
export async function POST(req: Request): Promise<NextResponse> {
  if (!isAdminConfigured()) {
    return NextResponse.json(
      { error: "관리자 접근이 설정되지 않았습니다. 서버에 ADMIN_PASSWORD를 설정하세요." },
      { status: 503 },
    );
  }

  let password = "";
  try {
    const body = (await req.json()) as { password?: unknown };
    if (typeof body.password === "string") password = body.password;
  } catch {
    return NextResponse.json({ error: "잘못된 요청 형식입니다" }, { status: 400 });
  }

  if (!password || !verifyAdminPassword(password)) {
    return NextResponse.json({ error: "비밀번호가 틀렸습니다" }, { status: 401 });
  }

  const store = await cookies();
  store.set(ADMIN_SESSION_COOKIE, adminSessionToken()!, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ADMIN_SESSION_MAX_AGE_S,
  });
  return NextResponse.json({ ok: true });
}

/** Log out: clear the session cookie. */
export async function DELETE(): Promise<NextResponse> {
  const store = await cookies();
  store.delete(ADMIN_SESSION_COOKIE);
  return NextResponse.json({ ok: true });
}
