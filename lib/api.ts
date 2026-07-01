"use client";

import { deviceHeaders } from "@/lib/identity";

/**
 * api.ts — tiny client fetch helpers that attach the device id and unwrap errors.
 */

async function parse<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const err =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `request failed (${res.status})`;
    throw new Error(err);
  }
  return body as T;
}

export async function apiGet<T>(url: string): Promise<T> {
  return parse<T>(await fetch(url, { headers: { ...deviceHeaders() } }));
}

export async function apiPost<T>(url: string, body?: unknown): Promise<T> {
  return parse<T>(
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...deviceHeaders() },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}
