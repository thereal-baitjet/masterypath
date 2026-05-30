import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'https://esm.sh/stripe@14?target=deno';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-04-10',
  httpClient: Stripe.createFetchHttpClient(),
});

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SB_SERVICE_ROLE_KEY')!,
);

// Map Stripe price IDs → plan names
const PRICE_TO_PLAN: Record<string, string> = {
  'price_1TcaNVDyN7ZsSI75GQxaeGxE': 'pro',    // Pro $9/mo
  'price_1TcaNjDyN7ZsSI75CCzaokbt': 'coach',  // Coach $49/mo
};

Deno.serve(async (req) => {
  // Only accept POST
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const body = await req.text();
  const sig  = req.headers.get('stripe-signature')!;
  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')!;

  // Verify signature
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err);
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  console.log(`Event received: ${event.type}`);

  // Handle checkout completion
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;

    const email          = session.customer_details?.email ?? session.customer_email;
    const customerId     = session.customer as string;
    const subscriptionId = session.subscription as string;

    if (!email) {
      console.warn('No email found in session');
      return new Response('No email', { status: 200 });
    }

    // Determine plan from subscription's price
    let plan = 'pro';
    if (subscriptionId) {
      try {
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const priceId = subscription.items.data[0]?.price.id;
        plan = PRICE_TO_PLAN[priceId] ?? 'pro';
      } catch (e) {
        console.warn('Could not retrieve subscription:', e);
      }
    }

    // Upsert subscriber
    const { error } = await supabase.from('subscribers').upsert(
      {
        email,
        plan,
        stripe_customer_id:    customerId,
        stripe_subscription_id: subscriptionId,
        is_pro:   true,
        is_coach: plan === 'coach',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'email' },
    );

    if (error) {
      console.error('Supabase upsert error:', error);
      return new Response('DB error', { status: 500 });
    }

    console.log(`✅ Subscriber unlocked: ${email} → ${plan}`);
  }

  // Handle subscription cancellation
  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object as Stripe.Subscription;
    const customerId   = subscription.customer as string;

    const { error } = await supabase
      .from('subscribers')
      .update({ is_pro: false, is_coach: false, plan: 'free', updated_at: new Date().toISOString() })
      .eq('stripe_customer_id', customerId);

    if (error) console.error('Cancel update error:', error);
    else console.log(`❌ Subscription cancelled for customer: ${customerId}`);
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { 'Content-Type': 'application/json' },
    status: 200,
  });
});
