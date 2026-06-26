import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MultiviewImages } from "@/lib/providers";

/**
 * db.ts - local job records.
 *
 * This project is local-only for now, so persistence is a small JSON-backed store
 * instead of Supabase/Postgres. The public function signatures stay synchronous
 * so the route seams do not need to change.
 */

export type JobStatus = "pending" | "processing" | "review" | "ready" | "failed";
export type JobStage = "multiview" | "review" | "model";

export interface StoredView {
  key: string;
  url: string;
}

export interface Job {
  id: string;
  status: JobStatus;
  /** Provider task id (e.g. Tripo), set once image-to-3D is submitted. */
  taskId?: string;
  /** Current pipeline stage for local polling/review. */
  stage?: JobStage;
  /** Local storage key for the submitted source drawing. */
  inputKey?: string;
  /** Provider task id for source drawing -> four generated views. */
  multiviewTaskId?: string;
  /** Provider task id for four generated views -> final 3D model. */
  modelTaskId?: string;
  /** Local copies of generated front/left/back/right view images. */
  multiview?: MultiviewImages<StoredView>;
  /** The single 3/4 "doodle-as-3D" render fed to the 3D generator. */
  render?: StoredView;
  /** Identifier the /simulate/[carId] route resolves a car from. */
  carId?: string;
  /** Signed URL to the generated GLB, set once ready. */
  carUrl?: string;
  /** Failure reason when status === "failed". */
  error?: string;
  createdAt: number;
  updatedAt: number;
}

const DATA_DIR = path.resolve(
  /* turbopackIgnore: true */ process.cwd(),
  process.env.LOCAL_DATA_DIR ?? ".data",
);
const DB_PATH = path.join(DATA_DIR, "jobs.json");
const TMP_PATH = path.join(DATA_DIR, "jobs.json.tmp");
const JOB_STATUSES: readonly JobStatus[] = ["pending", "processing", "review", "ready", "failed"];

function isJob(value: unknown): value is Job {
  if (!value || typeof value !== "object") return false;
  const job = value as Partial<Job>;
  return (
    typeof job.id === "string" &&
    typeof job.status === "string" &&
    JOB_STATUSES.includes(job.status as JobStatus) &&
    typeof job.createdAt === "number" &&
    typeof job.updatedAt === "number"
  );
}

// Always read the latest from disk. In Next.js the create route (/api/jobs) and the
// status route (/api/jobs/[id]) can run as separate module instances, so a cached
// in-memory map diverges between them — a job created by one becomes invisible to the
// other ("job not found"). The JSON file (written atomically) is the source of truth.
function loadJobs(): Map<string, Job> {
  if (!existsSync(DB_PATH)) return new Map();

  const raw = readFileSync(DB_PATH, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const entries = Array.isArray(parsed)
    ? parsed.filter((entry): entry is Job => isJob(entry))
    : [];

  return new Map(entries.map((job) => [job.id, job]));
}

function persistJobs(store: Map<string, Job>): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const data = JSON.stringify([...store.values()], null, 2);
  writeFileSync(TMP_PATH, `${data}\n`, "utf8");
  renameSync(TMP_PATH, DB_PATH);
}

function newId(): string {
  return `job_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export function createJob(init: Partial<Job> = {}): Job {
  const now = Date.now();
  const job: Job = {
    id: init.id ?? newId(),
    status: init.status ?? "pending",
    taskId: init.taskId,
    stage: init.stage,
    inputKey: init.inputKey,
    multiviewTaskId: init.multiviewTaskId,
    modelTaskId: init.modelTaskId,
    multiview: init.multiview,
    render: init.render,
    carId: init.carId,
    carUrl: init.carUrl,
    error: init.error,
    createdAt: now,
    updatedAt: now,
  };
  const store = loadJobs();
  store.set(job.id, job);
  persistJobs(store);
  return job;
}

export function getJob(jobId: string): Job | undefined {
  return loadJobs().get(jobId);
}

export function updateJob(jobId: string, patch: Partial<Job>): Job | undefined {
  const store = loadJobs();
  const existing = store.get(jobId);
  if (!existing) return undefined;

  const updated: Job = {
    ...existing,
    ...patch,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: Date.now(),
  };
  store.set(jobId, updated);
  persistJobs(store);
  return updated;
}
