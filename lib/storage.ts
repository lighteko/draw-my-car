import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ASSET_BUCKET, getServiceClient, hasSupabase } from "@/lib/supabase";

/**
 * storage.ts - object storage wrapper.
 *
 * When Supabase is configured, objects live in the public `assets` bucket and `url` is a
 * Supabase public URL the browser loads directly. Otherwise we fall back to files under
 * .data/storage served through /api/storage/[...key]. The StoredObject { key, url } shape
 * is identical either way, so callers never change.
 */

export interface StoredObject {
  /** Object key/path within the bucket (or local storage dir). */
  key: string;
  /** Browser-readable URL for the object. */
  url: string;
}

const DEFAULT_DATA_DIR = ".data";
const DEFAULT_STORAGE_DIR = path.join(DEFAULT_DATA_DIR, "storage");

// ---- shared key helpers ----

function normalizeKey(key: string): string {
  const normalized = key.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..")) {
    throw new Error(`Invalid storage key: ${key}`);
  }
  return normalized;
}

function extensionForContentType(contentType: string): string {
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("png")) return "png";
  if (contentType.includes("gltf-binary") || contentType.includes("model/gltf")) return "glb";
  return "bin";
}

function withContentExtension(key: string, contentType: string): string {
  if (path.extname(key)) return key;
  return `${key}.${extensionForContentType(contentType)}`;
}

export function contentTypeForKey(key: string): string {
  const ext = path.extname(key).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".glb") return "model/gltf-binary";
  if (ext === ".gltf") return "model/gltf+json";
  return "application/octet-stream";
}

function toBuffer(bytes: ArrayBuffer | Uint8Array): Buffer {
  return bytes instanceof Uint8Array ? Buffer.from(bytes) : Buffer.from(new Uint8Array(bytes));
}

// ---- Supabase-backed store ----

async function sbPut(key: string, bytes: ArrayBuffer | Uint8Array, contentType: string): Promise<StoredObject> {
  const normalizedKey = normalizeKey(key);
  const client = getServiceClient();
  const { error } = await client.storage
    .from(ASSET_BUCKET)
    .upload(normalizedKey, toBuffer(bytes), { contentType, upsert: true });
  if (error) throw new Error(`failed to upload ${normalizedKey}: ${error.message}`);
  const { data } = client.storage.from(ASSET_BUCKET).getPublicUrl(normalizedKey);
  return { key: normalizedKey, url: data.publicUrl };
}

async function sbRead(key: string): Promise<Uint8Array> {
  const { data, error } = await getServiceClient().storage.from(ASSET_BUCKET).download(normalizeKey(key));
  if (error || !data) throw new Error(`failed to read ${key}: ${error?.message ?? "not found"}`);
  return new Uint8Array(await data.arrayBuffer());
}

// ---- local file store (fallback) ----

function projectPath(...parts: string[]): string {
  return path.resolve(/* turbopackIgnore: true */ process.cwd(), ...parts);
}

function storageRoot(): string {
  return projectPath(process.env.LOCAL_STORAGE_DIR ?? DEFAULT_STORAGE_DIR);
}

export function getObjectPath(key: string): string {
  const root = storageRoot();
  const filePath = path.resolve(root, normalizeKey(key));
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Storage key escapes local root: ${key}`);
  }
  return filePath;
}

function localUrlForKey(key: string): string {
  return `/api/storage/${normalizeKey(key)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
}

async function localPut(key: string, bytes: ArrayBuffer | Uint8Array): Promise<StoredObject> {
  const normalizedKey = normalizeKey(key);
  const filePath = getObjectPath(normalizedKey);
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  await writeFile(filePath, toBuffer(bytes));
  return { key: normalizedKey, url: localUrlForKey(normalizedKey) };
}

// ---- public API ----

export async function putObject(
  key: string,
  bytes: ArrayBuffer | Uint8Array,
  contentType: string = "application/octet-stream",
): Promise<StoredObject> {
  const finalKey = withContentExtension(key, contentType);
  return hasSupabase() ? sbPut(finalKey, bytes, contentType) : localPut(finalKey, bytes);
}

/** Upload raw image bytes and return its key + browser-readable URL. */
export async function uploadImage(
  bytes: ArrayBuffer | Uint8Array,
  contentType: string = "image/png",
): Promise<StoredObject> {
  const ext = extensionForContentType(contentType);
  return putObject(`inputs/${Date.now()}-${randomUUID()}.${ext}`, bytes, contentType);
}

/** Copy a remote provider URL into our storage before the provider URL expires. */
export async function saveRemoteObject(
  url: string,
  key: string,
  fallbackContentType: string = "application/octet-stream",
): Promise<StoredObject> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download generated asset (${res.status})`);
  }
  const contentType = res.headers.get("content-type") ?? fallbackContentType;
  const bytes = await res.arrayBuffer();
  return putObject(withContentExtension(key, contentType), bytes, contentType);
}

/** Copy a remote model URL into our storage before the provider URL expires. */
export async function saveRemoteModel(url: string, key: string): Promise<StoredObject> {
  return saveRemoteObject(url, key, "model/gltf-binary");
}

/** Return a browser-readable URL for an object. Expiration is ignored (public assets). */
export async function getSignedUrl(key: string, _expiresInSeconds: number = 3600): Promise<string> {
  if (!hasSupabase()) return localUrlForKey(key);
  const { data } = getServiceClient().storage.from(ASSET_BUCKET).getPublicUrl(normalizeKey(key));
  return data.publicUrl;
}

export async function readObject(key: string): Promise<Uint8Array> {
  return hasSupabase() ? sbRead(key) : readFile(getObjectPath(key));
}
