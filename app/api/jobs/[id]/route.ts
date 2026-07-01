import { NextRequest, NextResponse } from "next/server";
import { getJob, updateJob, type Job, type StoredView } from "@/lib/db";
import { getProvider } from "@/lib/providers/tripo";
import type { MultiviewImages, ViewName } from "@/lib/providers";
import {
  contentTypeForKey,
  readObject,
  saveRemoteModel,
  saveRemoteObject,
} from "@/lib/storage";

const VIEW_ORDER: readonly ViewName[] = ["front", "left", "back", "right"];

function responseForJob(job: Job, progress?: number): NextResponse {
  return NextResponse.json({
    jobId: job.id,
    status: job.status,
    stage: job.stage ?? null,
    carId: job.carId ?? job.id,
    carUrl: job.carUrl ?? null,
    render: job.render ?? null,
    error: job.error ?? null,
    progress: progress ?? null,
  });
}

async function saveMultiview(
  jobId: string,
  urls: MultiviewImages,
): Promise<MultiviewImages<StoredView>> {
  const entries = await Promise.all(
    VIEW_ORDER.map(async (view) => {
      const stored = await saveRemoteObject(urls[view], `multiview/${jobId}/${view}`, "image/png");
      return [view, stored] as const;
    }),
  );
  return Object.fromEntries(entries) as MultiviewImages<StoredView>;
}

/**
 * GET /api/jobs/[id] - job status. The client polls this until the car is ready.
 *
 * Local-only completion happens here: when a job is processing, this route polls
 * Tripo, copies short-lived outputs into local storage, and promotes the job.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;

  if (id === "placeholder") {
    return NextResponse.json({
      jobId: id,
      status: "ready",
      stage: null,
      carId: "placeholder",
      carUrl: null,
      multiview: null,
      error: null,
      progress: null,
    });
  }

  const job = await getJob(id);
  if (!job) {
    return NextResponse.json({ error: "job not found" }, { status: 404 });
  }

  let current = job;
  let progress: number | undefined;

  if (job.status === "processing") {
    const provider = getProvider();
    if (!provider) {
      current =
        (await updateJob(job.id, {
          status: "failed",
          error: "TRIPO_API_KEY is not configured",
        })) ?? job;
    } else {
      try {
        const stage = job.stage ?? "model";

        if (stage === "multiview") {
          const taskId = job.multiviewTaskId ?? job.taskId;
          if (!taskId) throw new Error("multiview job is missing a provider task id");

          const task = await provider.getTask(taskId);
          progress = task.progress;

          if (task.status === "succeeded") {
            if (!task.multiviewUrls) {
              throw new Error("Tripo multiview task succeeded without generated views");
            }
            const multiview = await saveMultiview(job.id, task.multiviewUrls);
            current =
              (await updateJob(job.id, {
                status: "review",
                stage: "review",
                multiview,
                error: undefined,
              })) ?? job;
          } else if (task.status === "failed") {
            current =
              (await updateJob(job.id, {
                status: "failed",
                error: task.error ?? "Tripo multiview generation failed",
              })) ?? job;
          }
        } else {
          const taskId = job.modelTaskId ?? job.taskId;
          if (!taskId) throw new Error("model job is missing a provider task id");

          const task = await provider.getTask(taskId);
          progress = task.progress;

          if (task.status === "succeeded") {
            if (!task.modelUrl) throw new Error("Tripo task succeeded without a model URL");
            const stored = await saveRemoteModel(task.modelUrl, `models/${job.id}.glb`);
            current =
              (await updateJob(job.id, {
                status: "ready",
                stage: "model",
                carId: job.id,
                carUrl: stored.url,
                error: undefined,
              })) ?? job;
          } else if (task.status === "failed") {
            current =
              (await updateJob(job.id, {
                status: "failed",
                error: task.error ?? "Tripo generation failed",
              })) ?? job;
          }
        }
      } catch (e) {
        current =
          (await updateJob(job.id, {
            status: "failed",
            error: e instanceof Error ? e.message : "failed to poll Tripo task",
          })) ?? job;
      }
    }
  }

  return responseForJob(current, progress);
}

/**
 * POST /api/jobs/[id] - approve generated views and start the final 3D model task.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  const job = await getJob(id);

  if (!job) {
    return NextResponse.json({ error: "job not found" }, { status: 404 });
  }

  const body = (await req.json().catch(() => null)) as { action?: string } | null;
  if (body?.action !== "approve_multiview") {
    return NextResponse.json({ error: "unsupported job action" }, { status: 400 });
  }

  if (job.status !== "review" || !job.render) {
    return NextResponse.json(
      { error: "job is not waiting for render approval" },
      { status: 409 },
    );
  }

  const provider = getProvider();
  if (!provider) {
    return NextResponse.json({ error: "TRIPO_API_KEY is not configured" }, { status: 503 });
  }

  try {
    // Build from the GPT 3/4 render: a 3D-shaped image (depth + shading) gives the
    // generator what it needs to reconstruct a real 3D model. A flat doodle does not.
    if (!job.render) throw new Error("job is missing its generated 3D render");
    const bytes = await readObject(job.render.key);
    const contentType = contentTypeForKey(job.render.key);
    const { taskId } = await provider.submitImageTo3D({
      image: { bytes, contentType },
      jobId: job.id,
    });

    const updated =
      (await updateJob(job.id, {
        status: "processing",
        stage: "model",
        taskId,
        modelTaskId: taskId,
        error: undefined,
      })) ?? job;

    return responseForJob(updated);
  } catch (e) {
    const message = e instanceof Error ? e.message : "failed to submit multiview model task";
    await updateJob(job.id, { error: message });
    return NextResponse.json({ jobId: job.id, status: job.status, error: message }, { status: 502 });
  }
}
