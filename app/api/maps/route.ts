import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { isAdminAuthorized } from "@/lib/adminAuth";
import { createMap, listMaps } from "@/lib/maps";
import { putObject } from "@/lib/storage";
import type { Vec3 } from "@/lib/tracks";

const MAX_MODEL_BYTES = 50 * 1024 * 1024;

function numberField(form: FormData, key: string, fallback: number): number {
  const value = form.get(key);
  if (value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parsePoints(value: FormDataEntryValue | null): Vec3[] {
  if (typeof value !== "string") return [];
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(
      (point): point is number[] =>
        Array.isArray(point) && point.length >= 2 && point.every((axis) => Number.isFinite(axis)),
    )
    .map((point) =>
      point.length >= 3
        ? [Number(point[0]), Number(point[1]), Number(point[2])]
        : [Number(point[0]), 0, Number(point[1])],
    );
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ maps: listMaps() });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!(await isAdminAuthorized())) {
    return NextResponse.json({ error: "관리자 로그인이 필요합니다" }, { status: 401 });
  }
  try {
    const form = await req.formData();
    const name = String(form.get("name") ?? "").trim().slice(0, 60);
    const blurb = String(form.get("blurb") ?? "").trim().slice(0, 140);
    const points = parsePoints(form.get("points"));
    const modelFile = form.get("model");
    const remoteModelUrl = String(form.get("modelUrl") ?? "").trim();

    if (!name) return NextResponse.json({ error: "맵 이름을 입력하세요" }, { status: 400 });
    if (points.length > 0 && points.length < 3) {
      return NextResponse.json({ error: "체크포인트는 없거나 3개 이상이어야 합니다" }, { status: 400 });
    }

    let modelUrl = remoteModelUrl;
    if (modelFile instanceof File && modelFile.size > 0) {
      if (modelFile.size > MAX_MODEL_BYTES) {
        return NextResponse.json({ error: "GLB 파일은 50MB 이하여야 합니다" }, { status: 413 });
      }
      const extension = modelFile.name.toLowerCase().endsWith(".glb");
      if (!extension) {
        return NextResponse.json({ error: "자체 포함된 .glb 파일을 올려주세요" }, { status: 400 });
      }
      const stored = await putObject(
        `maps/${Date.now()}-${randomUUID()}.glb`,
        await modelFile.arrayBuffer(),
        "model/gltf-binary",
      );
      modelUrl = stored.url;
    }
    if (!modelUrl) {
      return NextResponse.json({ error: "GLB 파일을 올리거나 모델 URL을 입력하세요" }, { status: 400 });
    }
    if (remoteModelUrl && !/^https?:\/\//i.test(remoteModelUrl) && !remoteModelUrl.startsWith("/")) {
      return NextResponse.json({ error: "모델 URL은 http(s) 또는 앱 내부 경로여야 합니다" }, { status: 400 });
    }

    const map = createMap({
      name,
      blurb: blurb || "사용자 제작 환경",
      points,
      gateWidth: Math.min(20, Math.max(2, numberField(form, "gateWidth", 5))),
      defaultLaps: Math.min(2, Math.max(1, Math.round(numberField(form, "laps", 1)))),
      modelScale: Math.min(100, Math.max(0.01, numberField(form, "modelScale", 1))),
      groundColor: String(form.get("groundColor") ?? "#8a6a45"),
      accent: String(form.get("accent") ?? "#e0a84e"),
      skyColor: String(form.get("skyColor") ?? "#e8c88f"),
      modelUrl,
    });
    return NextResponse.json({ map }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "맵을 만들지 못했습니다";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
