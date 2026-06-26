import { NextRequest, NextResponse } from "next/server";
import { createJob, updateJob } from "@/lib/db";
import { getOpenAIImageProvider } from "@/lib/providers/openai-images";
import { putObject, uploadImage } from "@/lib/storage";

interface ParsedImage {
  bytes: Uint8Array;
  contentType: string;
}

function extensionForContentType(contentType: string): string {
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  if (contentType.includes("webp")) return "webp";
  return "png";
}

function parseDataUrl(dataUrl: string): ParsedImage {
  const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(dataUrl);
  if (!match) throw new Error("image must be a data URL");

  const contentType = match[1] || "image/png";
  const isBase64 = Boolean(match[2]);
  const data = match[3] ?? "";
  const bytes = isBase64
    ? Buffer.from(data, "base64")
    : Buffer.from(decodeURIComponent(data), "utf8");

  return { bytes, contentType };
}

async function readImage(req: NextRequest): Promise<ParsedImage> {
  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const body = (await req.json()) as { image?: string } | null;
    if (!body?.image) throw new Error("missing image");
    return parseDataUrl(body.image);
  }

  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    const image = form.get("image");
    if (typeof image === "string") return parseDataUrl(image);
    if (image instanceof File) {
      return {
        bytes: new Uint8Array(await image.arrayBuffer()),
        contentType: image.type || "image/png",
      };
    }
  }

  throw new Error("expected JSON data URL or multipart image");
}

/**
 * POST /api/jobs - accept a drawing and turn it into a single 3/4 3D "toy" render.
 *
 * The render is saved locally and reviewed by the client; on approval it becomes the
 * input image for Tripo's single-image-to-3D build. A 3D-shaped image (depth + shading)
 * is what the generator needs — flat orthographic views produce a flat model.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  let image: ParsedImage;
  try {
    image = await readImage(req);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "invalid image" },
      { status: 400 },
    );
  }

  const imageProvider = getOpenAIImageProvider();
  if (!imageProvider) {
    return NextResponse.json({ error: "OPENAI_API_KEY is not configured" }, { status: 503 });
  }

  const job = createJob({ status: "pending" });

  try {
    const stored = await uploadImage(image.bytes, image.contentType);
    const fileType = extensionForContentType(image.contentType);
    const generated = await imageProvider.generateCar3DRender({
      bytes: image.bytes,
      contentType: image.contentType,
      filename: `drawing.${fileType}`,
    });
    const render = await putObject(
      `render/${job.id}/${generated.filename}`,
      generated.bytes,
      generated.contentType,
    );

    const updated =
      updateJob(job.id, {
        status: "review",
        stage: "review",
        inputKey: stored.key,
        render,
      }) ?? job;

    return NextResponse.json(
      {
        jobId: updated.id,
        status: updated.status,
        stage: updated.stage ?? null,
        render: updated.render ?? null,
      },
      { status: 201 },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : "failed to generate views";
    updateJob(job.id, { status: "failed", error: message });
    return NextResponse.json({ jobId: job.id, status: "failed", error: message }, { status: 502 });
  }
}
