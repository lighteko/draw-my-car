/**
 * providers/index.ts — the model-provider interface.
 *
 * AI is API-only (we never self-host models). Tripo is the primary provider; this
 * interface is shaped so a second provider (Meshy) can be swapped behind it.
 *
 * Two-step flow (gotcha #2): Tripo's part generation is incompatible with
 * texture/pbr/quad, so we (1) generate the *textured* model, then (2) send that GLB to
 * the *segmentation* endpoint. Each step is an async task we submit, then poll.
 */

export type ProviderTaskStatus = "queued" | "running" | "succeeded" | "failed";
export type ViewName = "front" | "left" | "back" | "right";

export interface BinaryImageInput {
  bytes: ArrayBuffer | Uint8Array;
  contentType: string;
  filename?: string;
}

export type MultiviewImages<T = string> = Record<ViewName, T>;

export interface ImageTo3DInput {
  /** Signed URL of the (cleaned) input drawing the provider should fetch. */
  imageUrl?: string;
  /** Local-only path: bytes to upload directly to the provider when no public URL exists. */
  image?: BinaryImageInput;
  /** Our job id, for correlation / webhook routing. */
  jobId?: string;
}

export interface MultiviewTo3DInput {
  /** Four orthographic view images in Tripo order: front, left, back, right. */
  views: MultiviewImages<BinaryImageInput>;
  /** Our job id, for correlation / webhook routing. */
  jobId?: string;
}

export interface ProviderTask {
  taskId: string;
  status: ProviderTaskStatus;
  /** URL to the generated textured GLB, present once status === "succeeded". */
  modelUrl?: string;
  /** Generated orthographic image views, present for multiview-image tasks. */
  multiviewUrls?: MultiviewImages;
  /** 0..1 progress when available. */
  progress?: number;
  error?: string;
}

export interface SegmentationPart {
  /** Semantic name when the provider supplies one (e.g. "wheel", "body"). */
  name: string;
  /** URL or inline reference to the part's mesh/metadata. */
  ref: string;
}

export interface SegmentationResult {
  taskId: string;
  status: ProviderTaskStatus;
  parts?: SegmentationPart[];
}

/**
 * A 3D-generation provider. Step 1 = image→3D, step 2 = segment the produced GLB.
 * Both steps are submit-then-poll; `getTask`/`getSegmentation` are polled by the
 * status route (or driven by the provider webhook).
 */
export interface ModelProvider {
  readonly name: string;
  /** Step 0: expand one drawing into four style-matched orthographic views. */
  submitImageToMultiview(input: ImageTo3DInput): Promise<{ taskId: string }>;
  /** Step 1: submit four views for textured multiview-to-3D. */
  submitMultiviewTo3D(input: MultiviewTo3DInput): Promise<{ taskId: string }>;
  /** Step 1: submit the drawing for textured image-to-3D. */
  submitImageTo3D(input: ImageTo3DInput): Promise<{ taskId: string }>;
  /** Poll a generation task. */
  getTask(taskId: string): Promise<ProviderTask>;
  /** Step 2: submit the generated GLB for part segmentation. */
  segment(modelUrl: string): Promise<{ taskId: string }>;
  /** Poll a segmentation task. */
  getSegmentation(taskId: string): Promise<SegmentationResult>;
}
