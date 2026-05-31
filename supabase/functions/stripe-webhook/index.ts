// supabase/functions/stripe-webhook/index.ts
// Handles Stripe webhook events for subscriptions
// Uses client_reference_id (set to user_id) to link subscription to user

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'https://esm.sh/stripe@12.0.0?target=deno';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') || '', {
  httpClient: Stripe.createFetchHttpClient(),
});

const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET') || '';

const supabase = createClient(supabaseUrl, supabaseServiceKey);

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
  const signature = req.headers.get('stripe-signature');
  if (!signature) {
    return new Response('No signature', { status: 400 });
  }

  try {
    const body = await req.text();
    const event = stripe.webhooks.constructEvent(body, signature, webhookSecret);

    console.log('Webhook event:', event.type);

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        // client_reference_id is the user_id we passed from create-checkout
        const userId = session.client_reference_id || session.metadata?.user_id;
        const customerId = session.customer;
        const subscriptionId = session.subscription;

        if (!userId) {
          console.error('No user_id found in session');
          return new Response('No user_id', { status: 400 });
        }

        const subscription = await stripe.subscriptions.retrieve(subscriptionId as string);
        const period = getSubscriptionPeriod(subscription);

        const { error } = await supabase
          .from('subscriptions')
          .upsert({
            user_id: userId,
            stripe_customer_id: customerId as string,
            stripe_subscription_id: subscriptionId as string,
            status: subscription.status || 'trialing',
            plan: session.metadata?.plan || 'yearly',
            current_period_start: period.start,
            current_period_end: period.end,
            trial_end: dateFromStripeTimestamp(subscription.trial_end),
            cancel_at_period_end: subscription.cancel_at_period_end,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }, { onConflict: 'user_id' });

        if (error) {
          console.error('Error saving subscription:', error);
          return new Response('Database error', { status: 500 });
        }
        console.log('Subscription saved for user:', userId);
        break;
      }

      case 'invoice.paid': {
        const invoice = event.data.object;
        const subscriptionId = invoice.subscription;

        if (!subscriptionId) break;
        const subscription = await stripe.subscriptions.retrieve(subscriptionId as string);
        const period = getSubscriptionPeriod(subscription);

        const { error } = await supabase
          .from('subscriptions')
          .update({
            status: subscription.status || 'active',
            current_period_start: period.start,
            current_period_end: period.end,
            updated_at: new Date().toISOString(),
          })
          .eq('stripe_subscription_id', subscriptionId);

        if (error) {
          console.error('Error updating subscription:', error);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const subscriptionId = invoice.subscription;

        if (!subscriptionId) break;

        const { error } = await supabase
          .from('subscriptions')
          .update({
            status: 'past_due',
            updated_at: new Date().toISOString(),
          })
          .eq('stripe_subscription_id', subscriptionId);

        if (error) {
          console.error('Error updating subscription:', error);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;

        const { error } = await supabase
          .from('subscriptions')
          .update({
            status: 'canceled',
            updated_at: new Date().toISOString(),
          })
          .eq('stripe_subscription_id', subscription.id);

        if (error) {
          console.error('Error canceling subscription:', error);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const period = getSubscriptionPeriod(subscription);

        const { error } = await supabase
          .from('subscriptions')
          .update({
            status: subscription.status,
            current_period_start: period.start,
            current_period_end: period.end,
            trial_end: dateFromStripeTimestamp(subscription.trial_end),
            cancel_at_period_end: subscription.cancel_at_period_end,
            updated_at: new Date().toISOString(),
          })
          .eq('stripe_subscription_id', subscription.id);

        if (error) {
          console.error('Error updating subscription:', error);
        }
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Webhook error:', error);
    return new Response(`Webhook Error: ${error.message}`, { status: 400 });
  }
});
