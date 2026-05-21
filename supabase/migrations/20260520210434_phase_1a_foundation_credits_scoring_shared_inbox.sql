-- Phase 1A: foundation tables only.
-- This migration intentionally does not change the current chat write path.

-- =========================
-- CREDIT FOUNDATION
-- =========================
CREATE TABLE public.credit_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  credits INTEGER NOT NULL CHECK (credits > 0),
  price NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
  currency TEXT NOT NULL DEFAULT 'ILS' CHECK (char_length(currency) BETWEEN 3 AND 8),
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.credit_wallets (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  lifetime_earned INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_earned >= 0),
  lifetime_spent INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_spent >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.credit_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  type TEXT NOT NULL CHECK (
    type IN (
      'signup_bonus',
      'message_spend',
      'admin_adjustment',
      'package_purchase',
      'reset_grant',
      'migration_backfill'
    )
  ),
  reason TEXT,
  message_id UUID REFERENCES public.messages(id) ON DELETE SET NULL,
  package_id UUID REFERENCES public.credit_packages(id) ON DELETE SET NULL,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =========================
-- CLIENT-SIDE SOFT DELETE
-- =========================
CREATE TABLE public.client_conversation_deletions (
  client_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, conversation_id)
);

-- =========================
-- OPERATOR SCORING FOUNDATION
-- =========================
CREATE TABLE public.operator_score_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id UUID NOT NULL REFERENCES public.operators(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  message_id UUID REFERENCES public.messages(id) ON DELETE SET NULL,
  points INTEGER NOT NULL DEFAULT 1 CHECK (points >= 0),
  period_month DATE NOT NULL,
  streak_position INTEGER CHECK (streak_position IS NULL OR streak_position > 0),
  limit_applied INTEGER CHECK (limit_applied IS NULL OR limit_applied > 0),
  reason TEXT NOT NULL DEFAULT 'operator_message',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.operator_monthly_scores (
  operator_id UUID NOT NULL REFERENCES public.operators(id) ON DELETE CASCADE,
  period_month DATE NOT NULL,
  points INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
  message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (operator_id, period_month)
);

-- =========================
-- INTERNAL CRM FOUNDATION
-- =========================
CREATE TABLE public.customer_info_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
  operator_id UUID NOT NULL REFERENCES public.operators(id) ON DELETE CASCADE,
  created_by_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 2000),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =========================
-- READ STATE / LOCK FOUNDATION
-- =========================
CREATE TABLE public.conversation_read_states (
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  last_read_message_id UUID REFERENCES public.messages(id) ON DELETE SET NULL,
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE public.conversation_locks (
  conversation_id UUID PRIMARY KEY REFERENCES public.conversations(id) ON DELETE CASCADE,
  locked_by_operator_id UUID NOT NULL REFERENCES public.operators(id) ON DELETE CASCADE,
  locked_by_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  locked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  released_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  release_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CHECK (expires_at > locked_at)
);

-- =========================
-- INDEXES
-- =========================
CREATE INDEX idx_credit_packages_active_sort ON public.credit_packages(is_active, sort_order);
CREATE INDEX idx_credit_transactions_user_created ON public.credit_transactions(user_id, created_at DESC);
CREATE INDEX idx_credit_transactions_message ON public.credit_transactions(message_id);
CREATE INDEX idx_credit_transactions_package ON public.credit_transactions(package_id);

CREATE INDEX idx_client_conversation_deletions_conversation ON public.client_conversation_deletions(conversation_id);

CREATE INDEX idx_operator_score_events_operator_month ON public.operator_score_events(operator_id, period_month);
CREATE INDEX idx_operator_score_events_conversation_created ON public.operator_score_events(conversation_id, created_at);
CREATE INDEX idx_operator_score_events_message ON public.operator_score_events(message_id);
CREATE INDEX idx_operator_monthly_scores_month_points ON public.operator_monthly_scores(period_month, points DESC);

CREATE INDEX idx_customer_info_entries_client_created ON public.customer_info_entries(client_id, created_at DESC);
CREATE INDEX idx_customer_info_entries_conversation_created ON public.customer_info_entries(conversation_id, created_at DESC);
CREATE INDEX idx_customer_info_entries_operator_created ON public.customer_info_entries(operator_id, created_at DESC);

CREATE INDEX idx_conversation_read_states_user ON public.conversation_read_states(user_id, last_read_at DESC);
CREATE INDEX idx_conversation_locks_operator ON public.conversation_locks(locked_by_operator_id, expires_at);
CREATE INDEX idx_conversation_locks_expires ON public.conversation_locks(expires_at) WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_character_operator_assignments_operator_character
  ON public.character_operator_assignments(operator_id, character_id);
CREATE INDEX IF NOT EXISTS idx_character_operator_assignments_character_operator
  ON public.character_operator_assignments(character_id, operator_id);

-- =========================
-- UPDATED_AT TRIGGERS
-- =========================
CREATE TRIGGER set_credit_packages_updated_at
  BEFORE UPDATE ON public.credit_packages
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER set_credit_wallets_updated_at
  BEFORE UPDATE ON public.credit_wallets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER set_customer_info_entries_updated_at
  BEFORE UPDATE ON public.customer_info_entries
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =========================
-- SETTINGS DEFAULTS
-- =========================
INSERT INTO public.system_settings (key, value) VALUES
  ('credits_enabled', 'true'::jsonb),
  ('free_credits_on_signup', '10'::jsonb),
  ('free_credits_reset_mode', '"none"'::jsonb),
  ('free_credits_reset_amount', '0'::jsonb),
  ('scoring_enabled', 'true'::jsonb),
  ('consecutive_message_limit', '3'::jsonb),
  ('scoring_reset_mode', '"monthly"'::jsonb),
  ('concurrency_mode', '"open"'::jsonb),
  ('lock_timeout_minutes', '10'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- =========================
-- BACKFILL
-- =========================
INSERT INTO public.credit_wallets (user_id, balance, lifetime_earned, lifetime_spent)
SELECT DISTINCT ur.user_id, 0, 0, 0
FROM public.user_roles ur
WHERE ur.role = 'client'
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO public.credit_transactions (user_id, amount, balance_after, type, reason)
SELECT cw.user_id, 0, cw.balance, 'migration_backfill', 'Phase 1A wallet creation'
FROM public.credit_wallets cw
WHERE NOT EXISTS (
  SELECT 1
  FROM public.credit_transactions ct
  WHERE ct.user_id = cw.user_id
    AND ct.type = 'migration_backfill'
);

-- =========================
-- RLS
-- =========================
ALTER TABLE public.credit_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_conversation_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operator_score_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operator_monthly_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_info_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_read_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_locks ENABLE ROW LEVEL SECURITY;

-- credit_packages
CREATE POLICY "Anyone can view active credit packages"
  ON public.credit_packages FOR SELECT
  USING (is_active = true);

CREATE POLICY "Admins manage credit packages"
  ON public.credit_packages FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- credit_wallets
CREATE POLICY "Users view own credit wallet"
  ON public.credit_wallets FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Admins manage credit wallets"
  ON public.credit_wallets FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- credit_transactions
CREATE POLICY "Users view own credit transactions"
  ON public.credit_transactions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Admins view all credit transactions"
  ON public.credit_transactions FOR SELECT
  USING (public.is_admin());

CREATE POLICY "Admins insert credit transactions"
  ON public.credit_transactions FOR INSERT
  WITH CHECK (public.is_admin());

-- client_conversation_deletions
CREATE POLICY "Clients view own deleted conversations"
  ON public.client_conversation_deletions FOR SELECT
  USING (auth.uid() = client_id);

CREATE POLICY "Clients soft delete own conversations"
  ON public.client_conversation_deletions FOR INSERT
  WITH CHECK (
    auth.uid() = client_id
    AND EXISTS (
      SELECT 1
      FROM public.conversations c
      WHERE c.id = conversation_id
        AND c.client_id = auth.uid()
    )
  );

CREATE POLICY "Admins view all deleted conversations"
  ON public.client_conversation_deletions FOR SELECT
  USING (public.is_admin());

-- operator_score_events
CREATE POLICY "Operators view own score events"
  ON public.operator_score_events FOR SELECT
  USING (operator_id = public.get_my_operator_id());

CREATE POLICY "Admins view all score events"
  ON public.operator_score_events FOR SELECT
  USING (public.is_admin());

CREATE POLICY "Admins insert score events"
  ON public.operator_score_events FOR INSERT
  WITH CHECK (public.is_admin());

-- operator_monthly_scores
CREATE POLICY "Operators view own monthly score"
  ON public.operator_monthly_scores FOR SELECT
  USING (operator_id = public.get_my_operator_id());

CREATE POLICY "Admins manage monthly scores"
  ON public.operator_monthly_scores FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- customer_info_entries
CREATE POLICY "Operators view customer info for assigned characters"
  ON public.customer_info_entries FOR SELECT
  USING (
    operator_id = public.get_my_operator_id()
    OR public.is_admin()
    OR EXISTS (
      SELECT 1
      FROM public.conversations c
      JOIN public.character_operator_assignments coa
        ON coa.character_id = c.character_id
      WHERE c.client_id = customer_info_entries.client_id
        AND coa.operator_id = public.get_my_operator_id()
        AND (
          customer_info_entries.conversation_id IS NULL
          OR customer_info_entries.conversation_id = c.id
        )
    )
  );

CREATE POLICY "Operators create customer info for assigned characters"
  ON public.customer_info_entries FOR INSERT
  WITH CHECK (
    created_by_user_id = auth.uid()
    AND operator_id = public.get_my_operator_id()
    AND EXISTS (
      SELECT 1
      FROM public.conversations c
      JOIN public.character_operator_assignments coa
        ON coa.character_id = c.character_id
      WHERE c.client_id = customer_info_entries.client_id
        AND coa.operator_id = operator_id
        AND (
          customer_info_entries.conversation_id IS NULL
          OR customer_info_entries.conversation_id = c.id
        )
    )
  );

CREATE POLICY "Admins manage customer info"
  ON public.customer_info_entries FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- conversation_read_states
CREATE POLICY "Users view own conversation read states"
  ON public.conversation_read_states FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users create own conversation read states"
  ON public.conversation_read_states FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own conversation read states"
  ON public.conversation_read_states FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Admins view all conversation read states"
  ON public.conversation_read_states FOR SELECT
  USING (public.is_admin());

-- conversation_locks
CREATE POLICY "Operators view locks for assigned characters"
  ON public.conversation_locks FOR SELECT
  USING (
    public.is_admin()
    OR EXISTS (
      SELECT 1
      FROM public.conversations c
      JOIN public.character_operator_assignments coa
        ON coa.character_id = c.character_id
      WHERE c.id = conversation_locks.conversation_id
        AND coa.operator_id = public.get_my_operator_id()
    )
  );

CREATE POLICY "Operators create own locks for assigned characters"
  ON public.conversation_locks FOR INSERT
  WITH CHECK (
    locked_by_user_id = auth.uid()
    AND locked_by_operator_id = public.get_my_operator_id()
    AND EXISTS (
      SELECT 1
      FROM public.conversations c
      JOIN public.character_operator_assignments coa
        ON coa.character_id = c.character_id
      WHERE c.id = conversation_locks.conversation_id
        AND coa.operator_id = locked_by_operator_id
    )
  );

CREATE POLICY "Operators update own active locks"
  ON public.conversation_locks FOR UPDATE
  USING (
    locked_by_user_id = auth.uid()
    OR public.is_admin()
  )
  WITH CHECK (
    locked_by_user_id = auth.uid()
    OR public.is_admin()
  );

CREATE POLICY "Admins manage conversation locks"
  ON public.conversation_locks FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());
