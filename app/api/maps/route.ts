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
    return NextResponse.json({ error: "admin sign-in required" }, { status: 401 });
  }
  try {
    const form = await req.formData();
    const name = String(form.get("name") ?? "").trim().slice(0, 60);
    const blurb = String(form.get("blurb") ?? "").trim().slice(0, 140);
    const points = parsePoints(form.get("points"));
    const modelFile = form.get("model");
    const remoteModelUrl = String(form.get("modelUrl") ?? "").trim();

    if (!name) return NextResponse.json({ error: "Map name is required" }, { status: 400 });
    if (points.length > 0 && points.length < 3) {
      return NextResponse.json({ error: "Use either no checkpoints or at least three" }, { status: 400 });
    }

    let modelUrl = remoteModelUrl;
    if (modelFile instanceof File && modelFile.size > 0) {
      if (modelFile.size > MAX_MODEL_BYTES) {
        return NextResponse.json({ error: "GLB must be 50 MB or smaller" }, { status: 413 });
      }
      const extension = modelFile.name.toLowerCase().endsWith(".glb");
      if (!extension) {
        return NextResponse.json({ error: "Upload a self-contained .glb file" }, { status: 400 });
      }
      const stored = await putObject(
        `maps/${Date.now()}-${randomUUID()}.glb`,
        await modelFile.arrayBuffer(),
        "model/gltf-binary",
      );
      modelUrl = stored.url;
    }
    if (!modelUrl) {
      return NextResponse.json({ error: "Upload a GLB or provide a model URL" }, { status: 400 });
    }
    if (remoteModelUrl && !/^https?:\/\//i.test(remoteModelUrl) && !remoteModelUrl.startsWith("/")) {
      return NextResponse.json({ error: "Model URL must be an http(s) or app-relative URL" }, { status: 400 });
    }

    const map = createMap({
      name,
      blurb: blurb || "Custom test environment",
      points,
      gateWidth: Math.min(20, Math.max(2, numberField(form, "gateWidth", 5))),
      defaultLaps: Math.min(20, Math.max(1, Math.round(numberField(form, "laps", 3)))),
      modelScale: Math.min(100, Math.max(0.01, numberField(form, "modelScale", 1))),
      groundColor: String(form.get("groundColor") ?? "#263238"),
      accent: String(form.get("accent") ?? "#22d3ee"),
      skyColor: String(form.get("skyColor") ?? "#8ecae6"),
      modelUrl,
    });
    return NextResponse.json({ map }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not create map";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
