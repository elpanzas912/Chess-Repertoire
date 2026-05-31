import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function activeSubscription(subscription: { status?: string; current_period_end?: string | null } | null) {
  if (!subscription) return false;
  const activeStatus = subscription.status === 'active' || subscription.status === 'trialing';
  const activePeriod = subscription.current_period_end
    ? new Date(subscription.current_period_end) > new Date()
    : false;
  return activeStatus && activePeriod;
}

const databaseCacheTtlMs = 5 * 60 * 1000;
let databaseCache: { loadedAt: number; promise: Promise<Record<string, unknown>> } | null = null;

async function getOpeningDatabase(supabaseAdmin: ReturnType<typeof createClient>) {
  if (!databaseCache || Date.now() - databaseCache.loadedAt >= databaseCacheTtlMs) {
    const promise = supabaseAdmin.storage
      .from('private-opening-data')
      .download('openings.json')
      .then(async ({ data, error }) => {
        if (error || !data) {
          throw new Error(error?.message || 'Opening database unavailable');
        }
        const payload = JSON.parse(await data.text());
        return payload.openings || {};
      });
    databaseCache = { loadedAt: Date.now(), promise };
  }

  try {
    return await databaseCache.promise;
  } catch (error) {
    databaseCache = null;
    throw error;
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  try {
    const url = new URL(req.url);
    const slug = url.searchParams.get('slug')?.trim();
    if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
      return jsonResponse({ error: 'Invalid opening' }, 400);
    }

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return jsonResponse({ error: 'Authentication required' }, 401);
    }

    const supabaseUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !userData.user) {
      return jsonResponse({ error: 'Invalid session' }, 401);
    }

    const database = await getOpeningDatabase(supabaseAdmin);
    const opening = database[slug];
    if (!opening) {
      return jsonResponse({ error: 'Opening not found' }, 404);
    }

    const { data: subscription } = await supabaseAdmin
      .from('subscriptions')
      .select('status, current_period_end')
      .eq('user_id', userData.user.id)
      .maybeSingle();

    let access = activeSubscription(subscription);

    if (!access) {
      const { data: profile, error: profileError } = await supabaseAdmin
        .from('profiles')
        .select('free_opening_slug')
        .eq('id', userData.user.id)
        .maybeSingle();

      if (profileError) {
        return jsonResponse({ error: profileError.message }, 500);
      }

      const freeOpeningSlug = typeof profile?.free_opening_slug === 'string'
        ? profile.free_opening_slug
        : null;

      if (!freeOpeningSlug) {
        const { error: updateError } = await supabaseAdmin
          .from('profiles')
          .upsert({
            id: userData.user.id,
            free_opening_slug: slug,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'id' });

        if (updateError) {
          return jsonResponse({ error: updateError.message }, 500);
        }
        access = true;
      } else {
        access = freeOpeningSlug === slug;
      }
    }

    if (!access) {
      return jsonResponse({ error: 'Opening locked' }, 403);
    }

    return jsonResponse({ opening });
  } catch (error) {
    console.error('get-opening error:', error);
    return jsonResponse({ error: error.message || 'Unexpected error' }, 500);
  }
});
