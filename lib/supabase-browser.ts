"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * supabase-browser.ts — the anon Supabase client for the browser.
 *
 * Used only for Realtime (lobby presence + race broadcast). Table writes go through the
 * server routes (secret key), never this client. Safe to expose: it holds a public key.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
// Prefer the new publishable key (sb_publishable_...); fall back to the legacy anon key
// (both are statically inlined by Next, so either may be set).
const anonKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/** Whether multiplayer (Realtime) is available in this build. */
export function hasBrowserSupabase(): boolean {
  return Boolean(url && anonKey);
}

let client: SupabaseClient | null = null;

export function getBrowserClient(): SupabaseClient {
  if (!url || !anonKey) {
    throw new Error("Supabase browser client is not configured (NEXT_PUBLIC_SUPABASE_*)");
  }
  if (!client) {
    client = createClient(url, anonKey, {
      auth: { persistSession: false },
      // ~20-30 Hz car transforms in the race phase.
      realtime: { params: { eventsPerSecond: 30 } },
    });
  }
  return client;
}
