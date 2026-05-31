-- Create subscriptions table for Stripe integration
CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT UNIQUE,
  status TEXT CHECK (status IN ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused')),
  plan TEXT DEFAULT 'yearly',
  current_period_start TIMESTAMP WITH TIME ZONE,
  current_period_end TIMESTAMP WITH TIME ZONE,
  trial_end TIMESTAMP WITH TIME ZONE,
  cancel_at_period_end BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

-- Users can only read their own subscription
CREATE POLICY "Users can read own subscription" ON subscriptions
  FOR SELECT USING (auth.uid() = user_id);

-- Only service role can insert/update
CREATE POLICY "Service role can manage subscriptions" ON subscriptions
  FOR ALL USING (false) WITH CHECK (false);

-- Create function to check if user has active subscription
CREATE OR REPLACE FUNCTION public.has_active_subscription(user_uuid UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM subscriptions
    WHERE user_id = user_uuid
    AND status IN ('trialing', 'active')
    AND current_period_end > NOW()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Update profiles table to add onboarding preferences
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS rating TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS color_preference TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS goal TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS commitment TEXT;
