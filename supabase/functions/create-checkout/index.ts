// supabase/functions/create-checkout/index.ts
// Creates a Stripe Checkout Session for the annual subscription.
// Requires an authenticated Supabase user.

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

const priceIds: Record<string, string> = {
  yearly: Deno.env.get('STRIPE_YEARLY_PRICE_ID') || 'price_1TYzsE0bRhmsCmKquPAdLmh3',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Get user from Supabase auth using the JWT token
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized - Please log in first' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Create Supabase client with the user's auth token
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') || '',
      Deno.env.get('SUPABASE_ANON_KEY') || '',
      {
        global: {
          headers: { Authorization: authHeader },
        },
      }
    );

    // Get the user from the token
    const {
      data: { user },
      error: userError,
    } = await supabaseClient.auth.getUser();

    if (userError || !user) {
      return new Response(
        JSON.stringify({ error: 'Invalid session - Please log in again' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { plan = 'yearly' } = await req.json();
    const priceId = priceIds[plan];
    const appOrigin = (Deno.env.get('APP_ORIGIN') || '').replace(/\/$/, '');

    if (!priceId || !appOrigin) {
      return new Response(
        JSON.stringify({ error: !priceId ? 'Invalid checkout plan' : 'Checkout origin is not configured' }),
        { status: !priceId ? 400 : 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') || '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
    );

    const { data: existingSubscription } = await supabaseAdmin
      .from('subscriptions')
      .select('stripe_customer_id, status, current_period_end')
      .eq('user_id', user.id)
      .maybeSingle();

    const hasActiveSubscription =
      existingSubscription &&
      ['active', 'trialing'].includes(existingSubscription.status) &&
      new Date(existingSubscription.current_period_end).getTime() > Date.now();

    if (hasActiveSubscription) {
      return new Response(
        JSON.stringify({ error: 'You already have an active subscription' }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer: existingSubscription?.stripe_customer_id || undefined,
      customer_email: existingSubscription?.stripe_customer_id ? undefined : user.email,
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      subscription_data: {
        metadata: {
          plan,
          user_id: user.id,
        },
      },
      client_reference_id: user.id,
      allow_promotion_codes: true,
      success_url: `${appOrigin}/openings.html?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appOrigin}/checkout.html`,
      metadata: {
        plan,
        user_id: user.id,
      },
    });

    return new Response(
      JSON.stringify({ url: session.url }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Stripe checkout error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
