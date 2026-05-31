// Verifies a completed Stripe Checkout Session and mirrors the subscription in Supabase.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'https://esm.sh/stripe@12.0.0?target=deno';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') || '', {
  httpClient: Stripe.createFetchHttpClient(),
});

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function dateFromStripeTimestamp(timestamp: number | null | undefined) {
  return timestamp ? new Date(timestamp * 1000).toISOString() : null;
}

function getSubscriptionPeriod(subscription: Stripe.Subscription) {
  const item = subscription.items?.data?.[0];
  const start = subscription.current_period_start || item?.current_period_start;
  const end = subscription.current_period_end || item?.current_period_end;
  return {
    start: dateFromStripeTimestamp(start),
    end: dateFromStripeTimestamp(end),
  };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') || '',
      Deno.env.get('SUPABASE_ANON_KEY') || '',
      { global: { headers: { Authorization: authHeader } } },
    );

    const {
      data: { user },
      error: userError,
    } = await supabaseClient.auth.getUser();

    if (userError || !user) {
      return new Response(
        JSON.stringify({ error: 'Invalid session' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const { sessionId } = await req.json();
    if (!sessionId || typeof sessionId !== 'string') {
      return new Response(
        JSON.stringify({ error: 'Missing checkout session' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['subscription'],
    });

    if (session.client_reference_id !== user.id && session.metadata?.user_id !== user.id) {
      return new Response(
        JSON.stringify({ error: 'Checkout session does not belong to this user' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    if (session.payment_status !== 'paid' || session.status !== 'complete') {
      return new Response(
        JSON.stringify({ error: 'Checkout is not complete' }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const subscription = typeof session.subscription === 'string'
      ? await stripe.subscriptions.retrieve(session.subscription)
      : session.subscription as Stripe.Subscription;

    if (!subscription?.id) {
      return new Response(
        JSON.stringify({ error: 'Checkout has no subscription' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const period = getSubscriptionPeriod(subscription);
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') || '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
    );

    const { error } = await supabaseAdmin
      .from('subscriptions')
      .upsert({
        user_id: user.id,
        stripe_customer_id: session.customer as string,
        stripe_subscription_id: subscription.id,
        status: subscription.status || 'active',
        plan: session.metadata?.plan || 'yearly',
        current_period_start: period.start,
        current_period_end: period.end,
        trial_end: dateFromStripeTimestamp(subscription.trial_end),
        cancel_at_period_end: subscription.cancel_at_period_end,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });

    if (error) {
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    return new Response(
      JSON.stringify({ ok: true }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (error) {
    console.error('Confirm checkout error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
