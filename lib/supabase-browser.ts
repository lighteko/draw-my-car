"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * supabase-browser.ts — the anon Supabase client for the browser.
 *
 * Used only for Realtime (lobby presence + race broadcast). Table writes go through the
 * server routes (service role), never this client. Safe to expose: it holds the anon key.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

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
