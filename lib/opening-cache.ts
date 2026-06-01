import type { SupabaseClient } from "@supabase/supabase-js";

export type CachedOpening = {
  id: string;
  displayName: string;
  playerSide: "w" | "b";
  lines: string[];
  lineNames: Record<string, string>;
  lineCount: number;
  descriptions: Record<string, string>;
};

const cachePrefix = "chessengineered_opening_";
const pendingRequests = new Map<string, Promise<CachedOpening>>();

export class OpeningAccessError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export function readCachedOpening(slug: string) {
  try {
    return JSON.parse(sessionStorage.getItem(`${cachePrefix}${slug}`) ?? "null") as CachedOpening | null;
  } catch {
    return null;
  }
}

function cacheOpening(slug: string, opening: CachedOpening) {
  sessionStorage.setItem(`${cachePrefix}${slug}`, JSON.stringify(opening));
  return opening;
}

export function clearCachedOpenings() {
  for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
    const key = sessionStorage.key(index);
    if (key?.startsWith(cachePrefix)) sessionStorage.removeItem(key);
  }
}

export async function loadOpening(client: SupabaseClient, slug: string) {
  const cached = readCachedOpening(slug);
  if (cached) return cached;

  const existingRequest = pendingRequests.get(slug);
  if (existingRequest) return existingRequest;

  const request = (async () => {
    const {
      data: { session },
    } = await client.auth.getSession();
    const token = session?.access_token;
    if (!token) throw new OpeningAccessError("Authentication required", 401);

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    const response = await fetch(`${url}/functions/v1/get-opening?slug=${encodeURIComponent(slug)}`, {
      headers: { apikey: key ?? "", Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new OpeningAccessError(payload.error || "Unable to load opening", response.status);
    }

    const payload = (await response.json()) as { opening?: CachedOpening };
    if (!payload.opening) throw new OpeningAccessError("Opening data unavailable", 500);
    return cacheOpening(slug, payload.opening);
  })();

  pendingRequests.set(slug, request);
  try {
    return await request;
  } finally {
    pendingRequests.delete(slug);
  }
}
