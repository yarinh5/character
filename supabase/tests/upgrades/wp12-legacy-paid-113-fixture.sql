BEGIN;
INSERT INTO public.character_media_assets (
  id, character_id, source_path, preview_path, preview_generated_at, content_type, ingest_status, status,
  locked_price_credits, locked_teaser_path, locked_delivery_path, locked_derivatives_generated_at,
  locked_derivative_status
) VALUES (
  '00000000-0000-4000-8000-0000000b0501', '00000000-0000-4000-8000-0000000b0031',
  'wp12-rehearsal/legacy-source.png', 'wp12-rehearsal/legacy-preview.png', '2026-10-01T10:04:00Z',
  'image/png', 'ready', 'sent',
  10, 'wp12-rehearsal/legacy-teaser.png', 'wp12-rehearsal/legacy-delivery.png', '2026-10-01T10:04:00Z',
  'ready'
);

INSERT INTO public.character_media_reservations (
  id, media_asset_id, conversation_id, operator_id, reserved_by_user_id, previous_asset_status,
  state, intended_access_mode, created_at, expires_at, ended_at
) VALUES (
  '00000000-0000-4000-8000-0000000b0502', '00000000-0000-4000-8000-0000000b0501',
  '00000000-0000-4000-8000-0000000b0102', '00000000-0000-4000-8000-0000000b0021',
  '00000000-0000-4000-8000-0000000b0011', 'available',
  'consumed', 'locked', '2026-10-01T10:03:00Z', '2026-10-01T10:13:00Z', '2026-10-01T10:05:00Z'
);

INSERT INTO public.message_attachments (
  id, message_id, media_asset_id, reservation_id, kind, access_mode, view_mode,
  price_credits_snapshot, created_at
) VALUES (
  '00000000-0000-4000-8000-0000000b0503', '00000000-0000-4000-8000-0000000b0303',
  '00000000-0000-4000-8000-0000000b0501', '00000000-0000-4000-8000-0000000b0502',
  'image', 'locked', 'permanent', 10, '2026-10-01T10:05:00Z'
);

INSERT INTO public.credit_wallets (user_id)
VALUES ('00000000-0000-4000-8000-0000000b0002')
ON CONFLICT (user_id) DO NOTHING;

WITH funded AS (
  UPDATE public.credit_wallets
  SET balance = balance + 100, lifetime_earned = lifetime_earned + 100
  WHERE user_id = '00000000-0000-4000-8000-0000000b0002'
  RETURNING user_id, balance
)
INSERT INTO public.credit_transactions (id, user_id, amount, balance_after, type, reason, created_at)
SELECT '00000000-0000-4000-8000-0000000b0504', user_id, 100, balance, 'admin_adjustment',
  'wp12_synthetic_legacy_funding', '2026-10-01T10:02:00Z'
FROM funded;

WITH charged AS (
  UPDATE public.credit_wallets
  SET balance = balance - 10, lifetime_spent = lifetime_spent + 10
  WHERE user_id = '00000000-0000-4000-8000-0000000b0002'
  RETURNING user_id, balance
)
INSERT INTO public.credit_transactions (
  id, user_id, amount, balance_after, type, reason, message_id, message_attachment_id, created_at
)
SELECT '00000000-0000-4000-8000-0000000b0505', user_id, -10, balance,
  'locked_image_unlock', 'wp12_synthetic_legacy_charge', '00000000-0000-4000-8000-0000000b0303',
  '00000000-0000-4000-8000-0000000b0503', '2026-10-01T10:06:00Z'
FROM charged;

INSERT INTO public.message_attachment_unlocks (
  id, attachment_id, client_id, charged_transaction_id, unlocked_at, created_at
) VALUES (
  '00000000-0000-4000-8000-0000000b0506', '00000000-0000-4000-8000-0000000b0503',
  '00000000-0000-4000-8000-0000000b0002', '00000000-0000-4000-8000-0000000b0505',
  '2026-10-01T10:06:00Z', '2026-10-01T10:06:00Z'
);
\if :commit_fixture
COMMIT;
\else
ROLLBACK;
\endif
