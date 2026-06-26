import type {
  BinaryImageInput,
  ImageTo3DInput,
  ModelProvider,
  MultiviewImages,
  MultiviewTo3DInput,
  ProviderTask,
  ProviderTaskStatus,
  SegmentationResult,
  ViewName,
} from "./index";

/**
 * tripo.ts - Tripo provider (https://api.tripo3d.ai).
 *
 * v1 uses Tripo's direct upload endpoint so local development does not need a
 * public image URL. The generated model URL is copied into local storage by the
 * job status route before Tripo's short-lived download URL expires.
 */

export const TRIPO_API_BASE = "https://api.tripo3d.ai/v2/openapi";

export interface TripoConfig {
  apiKey: string;
  /** Optional webhook URL Tripo calls on task completion (unused in local polling mode). */
  webhookUrl?: string;
  modelVersion?: string;
  textureQuality?: "standard" | "detailed" | "extreme";
  textureAlignment?: "original_image" | "geometry";
  enableImageAutofix?: boolean;
  pbr?: boolean;
  /** Cap on mesh face count; lower = simpler, blockier (more doodle-like) geometry. */
  faceLimit?: number;
}

interface TripoEnvelope<T> {
  code: number;
  data?: T;
  message?: string;
}

interface TripoUploadData {
  image_token?: string;
  file_token?: string;
}

interface TripoCreateTaskData {
  task_id?: string;
}

interface TripoTaskData {
  task_id?: string;
  status?: string;
  progress?: number;
  output?: {
    model?: string;
    pbr_model?: string;
    base_model?: string;
    front_view_url?: string;
    left_view_url?: string;
    back_view_url?: string;
    right_view_url?: string;
    generate_multiview_image?: {
      front_view_url?: string;
      left_view_url?: string;
      back_view_url?: string;
      right_view_url?: string;
    };
  };
  error?: string;
}

interface TripoFileInput {
  type: string;
  file_token?: string;
  url?: string;
}

function extensionForContentType(contentType: string): string {
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  if (contentType.includes("webp")) return "webp";
  return "png";
}

function imageFilename(contentType: string, filename: string | undefined): string {
  return filename ?? `drawing.${extensionForContentType(contentType)}`;
}

function toArrayBuffer(bytes: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes;
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  return body;
}

function tripoStatus(status: string | undefined): ProviderTaskStatus {
  if (status === "queued") return "queued";
  if (status === "running") return "running";
  if (status === "success") return "succeeded";
  return "failed";
}

function envBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

function envTextureQuality(value: string | undefined): "standard" | "detailed" | "extreme" {
  if (value === "detailed" || value === "extreme") return value;
  return "standard";
}

function envTextureAlignment(value: string | undefined): "original_image" | "geometry" {
  return value === "geometry" ? "geometry" : "original_image";
}

function envFaceLimit(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function getMultiviewUrls(data: TripoTaskData): MultiviewImages | undefined {
  const views = data.output?.generate_multiview_image;
  const front = views?.front_view_url ?? data.output?.front_view_url;
  const left = views?.left_view_url ?? data.output?.left_view_url;
  const back = views?.back_view_url ?? data.output?.back_view_url;
  const right = views?.right_view_url ?? data.output?.right_view_url;
  if (!front || !left || !back || !right) return undefined;
  return { front, left, back, right };
}

export class TripoProvider implements ModelProvider {
  readonly name = "tripo";

  constructor(private readonly config: TripoConfig) {}

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const res = await fetch(`${TRIPO_API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        ...init.headers,
      },
    });

    const payload = (await res.json().catch(() => null)) as TripoEnvelope<T> | null;
    if (!res.ok || !payload || payload.code !== 0 || !payload.data) {
      const providerMessage = payload?.message ? `: ${payload.message}` : "";
      throw new Error(`Tripo request failed (${res.status}, code ${payload?.code ?? "unknown"})${providerMessage}`);
    }
    return payload.data;
  }

  private async uploadImageBytes(input: BinaryImageInput): Promise<TripoFileInput> {
    const { bytes, contentType, filename } = input;
    const fileType = extensionForContentType(contentType);
    const form = new FormData();
    form.append(
      "file",
      new Blob([toArrayBuffer(bytes)], { type: contentType }),
      imageFilename(contentType, filename),
    );

    const data = await this.request<TripoUploadData>("/upload/sts", {
      method: "POST",
      body: form,
    });

    const token = data.image_token ?? data.file_token;
    if (!token) throw new Error("Tripo upload did not return an image token");
    return { type: fileType, file_token: token };
  }

  private async imageFileInput(input: ImageTo3DInput): Promise<TripoFileInput> {
    if (input.image) return this.uploadImageBytes(input.image);
    if (input.imageUrl) return { type: "png", url: input.imageUrl };
    throw new Error("Tripo image input requires bytes or a URL");
  }

  private fidelityOptions(): Record<string, unknown> {
    const options: Record<string, unknown> = {
      texture: true,
      pbr: this.config.pbr ?? false,
      texture_quality: this.config.textureQuality ?? "standard",
      texture_alignment: this.config.textureAlignment ?? "original_image",
      orientation: "align_image",
      enable_image_autofix: this.config.enableImageAutofix ?? false,
    };
    if (typeof this.config.faceLimit === "number") {
      options.face_limit = this.config.faceLimit;
    }
    return options;
  }

  async submitImageToMultiview(input: ImageTo3DInput): Promise<{ taskId: string }> {
    const file = await this.imageFileInput(input);
    const data = await this.request<TripoCreateTaskData>("/task", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "generate_multiview_image",
        file,
      }),
    });

    if (!data.task_id) throw new Error("Tripo multiview task creation did not return a task id");
    return { taskId: data.task_id };
  }

  async submitMultiviewTo3D(input: MultiviewTo3DInput): Promise<{ taskId: string }> {
    const order: ViewName[] = ["front", "left", "back", "right"];
    const files = await Promise.all(order.map((view) => this.uploadImageBytes(input.views[view])));
    const body: Record<string, unknown> = {
      type: "multiview_to_model",
      files,
      ...this.fidelityOptions(),
    };

    if (this.config.modelVersion) {
      body.model_version = this.config.modelVersion;
    }

    const data = await this.request<TripoCreateTaskData>("/task", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!data.task_id) throw new Error("Tripo model task creation did not return a task id");
    return { taskId: data.task_id };
  }

  async submitImageTo3D(input: ImageTo3DInput): Promise<{ taskId: string }> {
    const file = await this.imageFileInput(input);
    const body: Record<string, unknown> = {
      type: "image_to_model",
      file,
      ...this.fidelityOptions(),
    };

    if (this.config.modelVersion) {
      body.model_version = this.config.modelVersion;
    }

    const data = await this.request<TripoCreateTaskData>("/task", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!data.task_id) throw new Error("Tripo task creation did not return a task id");
    return { taskId: data.task_id };
  }

  async getTask(taskId: string): Promise<ProviderTask> {
    const data = await this.request<TripoTaskData>(`/task/${encodeURIComponent(taskId)}`, {
      method: "GET",
    });

    const status = tripoStatus(data.status);
    return {
      taskId: data.task_id ?? taskId,
      status,
      modelUrl: data.output?.model ?? data.output?.pbr_model ?? data.output?.base_model,
      multiviewUrls: getMultiviewUrls(data),
      progress: typeof data.progress === "number" ? data.progress / 100 : undefined,
      error:
        status === "failed"
          ? data.error ?? `Tripo task ended with status ${data.status ?? "unknown"}`
          : undefined,
    };
  }

  async segment(_modelUrl: string): Promise<{ taskId: string }> {
    throw new Error("TripoProvider.segment: not implemented (v2)");
  }

  async getSegmentation(_taskId: string): Promise<SegmentationResult> {
    throw new Error("TripoProvider.getSegmentation: not implemented (v2)");
  }
}

/**
 * Factory reading server-side env. Returns `null` when unconfigured.
 */
export function getProvider(): ModelProvider | null {
  const apiKey = process.env.TRIPO_API_KEY;
  if (!apiKey) return null;
  return new TripoProvider({
    apiKey,
    webhookUrl: process.env.TRIPO_WEBHOOK_URL,
    modelVersion: process.env.TRIPO_MODEL_VERSION,
    textureQuality: envTextureQuality(process.env.TRIPO_TEXTURE_QUALITY),
    textureAlignment: envTextureAlignment(process.env.TRIPO_TEXTURE_ALIGNMENT),
    enableImageAutofix: envBoolean(process.env.TRIPO_ENABLE_IMAGE_AUTOFIX, false),
    pbr: envBoolean(process.env.TRIPO_PBR, false),
    faceLimit: envFaceLimit(process.env.TRIPO_FACE_LIMIT),
  });
}
