import type { BinaryImageInput } from "./index";

const OPENAI_IMAGES_API = "https://api.openai.com/v1/images/edits";

export interface OpenAIImageConfig {
  apiKey: string;
  model: string;
  size: string;
  quality: string;
}

export interface GeneratedImage {
  bytes: Uint8Array;
  contentType: string;
  filename: string;
}

interface OpenAIImageResponse {
  data?: Array<{
    b64_json?: string;
    url?: string;
  }>;
  error?: {
    message?: string;
  };
}

function extensionForContentType(contentType: string): string {
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  if (contentType.includes("webp")) return "webp";
  return "png";
}

function toArrayBuffer(bytes: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes;
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  return body;
}

/**
 * Turn the flat child's drawing into ONE 3/4 volumetric "toy" render — a genuinely
 * 3D-shaped image with depth cues (perspective + soft shading). Single-image-to-3D
 * needs this; flat orthographic line-art gives the generator nothing to reconstruct,
 * which is why it produced a flat blob. The doodle's character is preserved; only its
 * dimensionality changes.
 */
function promptForRender(): string {
  return [
    "Transform the attached child's car drawing into a single 3D render of the SAME car,",
    "seen from a 3/4 angle (front-left corner, slightly above eye level) so its front, one full side,",
    "and the top are all clearly visible. Keep the original drawing style: preserve its exact linework,",
    "marks, decorations, rough handmade edges, silhouette, and charming wonky character.",
    "Use ONLY colors that are visibly present in the source drawing. Do not invent colors, recolor",
    "anything, or flood-fill outlined or uncolored areas. Any white, blank, transparent, or paper-colored",
    "region in the source must remain white or uncolored on the car. Use changes in brightness only for",
    "gentle 3D shading; do not introduce new hues, gradients, patterns, or material colors.",
    "Turn the drawing into a coherent car-shaped volume while retaining its distinctive exaggerations.",
    "The front-to-back body length must clearly be the longest dimension, the side-to-side width must",
    "be shorter, and the ground-to-roof height must be the shortest. Use believable compact-car",
    "proportions, with a long wheelbase along the sides, a narrower track across the car, four wheels",
    "placed consistently at the corners, and a clearly defined front, cabin, roof, and rear.",
    "Give it real three-dimensional volume with softly rounded handmade toy surfaces, lit with soft,",
    "even studio lighting and restrained shading so the solid form reads clearly without changing its art.",
    "Plain seamless very-light-gray background, the whole toy centered with comfortable margin on every",
    "side, and a soft contact shadow directly beneath it.",
    "Do not make it glossy, metallic, photorealistic, or cinematic; keep the friendly handmade look.",
    "No text, no labels, no captions, no scenery, no extra objects, no reflections, no duplicate views.",
    "Output exactly one image containing only this single car.",
  ].join(" ");
}

function parsePayload(text: string): OpenAIImageResponse | null {
  try {
    return JSON.parse(text) as OpenAIImageResponse;
  } catch {
    return null;
  }
}

async function downloadUrl(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OpenAI image download failed (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

export class OpenAIImageProvider {
  constructor(private readonly config: OpenAIImageConfig) {}

  /** The single 3/4 "doodle-as-3D-toy" render used as the 3D generator's input. */
  async generateCar3DRender(input: BinaryImageInput): Promise<GeneratedImage> {
    const bytes = await this.generateImage(input);
    return { bytes, contentType: "image/png", filename: "render.png" };
  }

  private async generateImage(input: BinaryImageInput): Promise<Uint8Array> {
    const fileType = extensionForContentType(input.contentType);
    const form = new FormData();
    form.append("model", this.config.model);
    form.append(
      "image",
      new Blob([toArrayBuffer(input.bytes)], { type: input.contentType }),
      input.filename ?? `drawing.${fileType}`,
    );
    form.append("prompt", promptForRender());
    form.append("size", this.config.size);
    form.append("quality", this.config.quality);
    form.append("background", "opaque");
    form.append("output_format", "png");

    const res = await fetch(OPENAI_IMAGES_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: form,
    });

    const text = await res.text();
    const payload = parsePayload(text);
    if (!res.ok) {
      const message = payload?.error?.message ? `: ${payload.error.message}` : "";
      throw new Error(`OpenAI image generation failed (${res.status})${message}`);
    }

    const image = payload?.data?.[0];
    if (image?.b64_json) {
      return new Uint8Array(Buffer.from(image.b64_json, "base64"));
    }
    if (image?.url) {
      return downloadUrl(image.url);
    }
    throw new Error("OpenAI image generation did not return image data");
  }
}

export function getOpenAIImageProvider(): OpenAIImageProvider | null {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  return new OpenAIImageProvider({
    apiKey,
    model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-2",
    size: process.env.OPENAI_IMAGE_SIZE || "2048x2048",
    quality: process.env.OPENAI_IMAGE_QUALITY || "medium",
  });
}
