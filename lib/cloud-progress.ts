import type { SupabaseClient } from "@supabase/supabase-js";

export type CloudProgress = Record<string, any>;

const progressKey = "chessengineered_progress";
const pendingActivityKey = "chessengineered_pending_training_activity";

type PendingTrainingActivity = {
  eventId: string;
  slug: string;
  mode: "learn" | "practice";
  durationMs: number;
  timezone: string;
};

export function readCachedProgress(): CloudProgress {
  try {
    return JSON.parse(localStorage.getItem(progressKey) ?? "{}");
  } catch {
    return {};
  }
}

export function cacheProgress(progress: CloudProgress) {
  localStorage.setItem(progressKey, JSON.stringify(progress));
  return progress;
}

function timezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function createEventId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function readPendingActivity() {
  try {
    const pending = JSON.parse(localStorage.getItem(pendingActivityKey) ?? "[]");
    return Array.isArray(pending) ? (pending as PendingTrainingActivity[]) : [];
  } catch {
    return [];
  }
}

function writePendingActivity(pending: PendingTrainingActivity[]) {
  localStorage.setItem(pendingActivityKey, JSON.stringify(pending));
}

export async function flushPendingTrainingActivity(client: SupabaseClient) {
  const pending = readPendingActivity();
  for (let index = 0; index < pending.length; index += 1) {
    const event = pending[index];
    const { error } = await client.rpc("record_training_activity", {
      p_event_id: event.eventId,
      p_opening_slug: event.slug,
      p_mode: event.mode ?? "learn",
      p_duration_ms: event.durationMs,
      p_timezone: event.timezone,
    });
    if (error) {
      throw error;
    }
    writePendingActivity(readPendingActivity().filter((pendingEvent) => pendingEvent.eventId !== event.eventId));
  }
}

async function applyActivitySummary(client: SupabaseClient, userId: string, progress: CloudProgress) {
  const { data, error } = await client.rpc("get_training_activity_summary", {
    p_user_id: userId,
    p_timezone: timezone(),
  });
  if (error) throw error;
  const activitySummary = (data as CloudProgress | null) ?? {};
  return {
    ...progress,
    ...activitySummary,
    dailyStreak: {
      ...(activitySummary.dailyStreak ?? {}),
      lineActivityDates: progress.dailyStreak?.activityDates ?? {},
    },
  };
}

export async function loadCloudProgress(client: SupabaseClient, userId: string) {
  await flushPendingTrainingActivity(client).catch((error: Error) => {
    console.warn("Unable to sync pending training time:", error.message);
  });
  const { data, error } = await client.rpc("get_user_progress", {
    p_user_id: userId,
    p_timezone: timezone(),
  });
  if (error) throw error;
  return cacheProgress(await applyActivitySummary(client, userId, (data as CloudProgress | null) ?? {}));
}

export async function resetOpeningProgress(client: SupabaseClient, slug: string) {
  const { data, error } = await client.rpc("reset_opening_training_progress", {
    p_opening_slug: slug,
    p_timezone: timezone(),
  });
  if (error) throw error;
  return cacheProgress((data as CloudProgress | null) ?? {});
}

export async function recordTrainingCompletion(
  client: SupabaseClient,
  input: {
    eventId: string;
    slug: string;
    line: string;
    mode: "learn" | "practice";
    correctMoves: number;
    incorrectMoves: number;
    durationMs: number;
  },
) {
  const { data, error } = await client.rpc("record_training_session", {
    p_event_id: input.eventId,
    p_opening_slug: input.slug,
    p_line_pgn: input.line,
    p_mode: input.mode,
    p_correct_moves: input.correctMoves,
    p_incorrect_moves: input.incorrectMoves,
    p_duration_ms: input.durationMs,
    p_timezone: timezone(),
  });
  if (error) throw error;
  const {
    data: { user },
  } = await client.auth.getUser();
  const progress = (data as CloudProgress | null) ?? {};
  return cacheProgress(user ? await applyActivitySummary(client, user.id, progress) : progress);
}

export async function recordTrainingActivity(
  client: SupabaseClient,
  slug: string,
  durationMs: number,
  mode: "learn" | "practice" = "learn",
) {
  writePendingActivity([
    ...readPendingActivity(),
    {
      eventId: createEventId(),
      slug,
      mode,
      durationMs: Math.max(1, Math.min(60000, Math.round(durationMs))),
      timezone: timezone(),
    },
  ]);
  await flushPendingTrainingActivity(client);
}
