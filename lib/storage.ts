import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * storage.ts - local object storage wrapper.
 *
 * For local-only v1 this replaces R2 with files under .data/storage. The browser
 * still receives route URLs rather than filesystem paths.
 */

export interface StoredObject {
  /** Object key within the local storage directory. */
  key: string;
  /** Browser-readable URL for the object. */
  url: string;
}

const DEFAULT_DATA_DIR = ".data";
const DEFAULT_STORAGE_DIR = path.join(DEFAULT_DATA_DIR, "storage");

function projectPath(...parts: string[]): string {
  return path.resolve(/* turbopackIgnore: true */ process.cwd(), ...parts);
}

function storageRoot(): string {
  return projectPath(process.env.LOCAL_STORAGE_DIR ?? DEFAULT_STORAGE_DIR);
}

function normalizeKey(key: string): string {
  const normalized = key.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..")) {
    throw new Error(`Invalid storage key: ${key}`);
  }
  return normalized;
}

export function getObjectPath(key: string): string {
  const root = storageRoot();
  const filePath = path.resolve(root, normalizeKey(key));
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Storage key escapes local root: ${key}`);
  }
  return filePath;
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

function urlForKey(key: string): string {
  return `/api/storage/${normalizeKey(key)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
}

export async function putObject(
  key: string,
  bytes: ArrayBuffer | Uint8Array,
  _contentType: string = "application/octet-stream",
): Promise<StoredObject> {
  const normalizedKey = normalizeKey(key);
  const filePath = getObjectPath(normalizedKey);
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const buffer = bytes instanceof Uint8Array ? Buffer.from(bytes) : Buffer.from(new Uint8Array(bytes));
  await writeFile(filePath, buffer);
  return { key: normalizedKey, url: await getSignedUrl(normalizedKey) };
}

/**
 * Upload raw image bytes and return its local key + browser-readable URL.
 */
export async function uploadImage(
  bytes: ArrayBuffer | Uint8Array,
  contentType: string = "image/png",
): Promise<StoredObject> {
  const ext = extensionForContentType(contentType);
  return putObject(`inputs/${Date.now()}-${randomUUID()}.${ext}`, bytes, contentType);
}

/**
 * Copy a remote provider URL into local storage before the provider URL expires.
 */
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

/**
 * Copy a remote model URL into local storage before the provider URL expires.
 */
export async function saveRemoteModel(url: string, key: string): Promise<StoredObject> {
  return saveRemoteObject(url, key, "model/gltf-binary");
}

/**
 * Return a local route URL for an object. Expiration is ignored in local mode.
 */
export async function getSignedUrl(key: string, _expiresInSeconds: number = 3600): Promise<string> {
  return urlForKey(key);
}

export async function readObject(key: string): Promise<Uint8Array> {
  return readFile(getObjectPath(key));
}
