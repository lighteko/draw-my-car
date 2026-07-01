import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * supabase.ts — server-side Supabase access (service-role).
 *
 * SERVER ONLY. This reads SUPABASE_SERVICE_ROLE_KEY, which must never reach the browser
 * bundle — import it only from route handlers and other server code (lib/db, lib/storage).
 * The browser talks to Supabase Realtime through the separate anon client in
 * lib/supabase-browser.ts (added in the rooms phase).
 *
 * When Supabase env is absent, hasSupabase() is false and lib/db + lib/storage fall back
 * to the local .data/ file store so the app still runs in bare local dev.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

/** Public storage bucket for generated renders + GLBs. Created by the init migration. */
export const ASSET_BUCKET = "assets";

/** Whether the Supabase backend is configured. Callers fall back to local files when false. */
export function hasSupabase(): boolean {
  return Boolean(url && serviceKey);
}

let cached: SupabaseClient | null = null;

/** Cached service-role client. Bypasses RLS — never expose to the browser. */
export function getServiceClient(): SupabaseClient {
  if (!url || !serviceKey) {
    throw new Error(
      "Supabase is not configured (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)",
    );
  }
  if (!cached) {
    cached = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return cached;
}
