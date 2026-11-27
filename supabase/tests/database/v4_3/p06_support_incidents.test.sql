BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;
SELECT no_plan();

SELECT has_table('public', 'support_tickets', 'P06 support tickets exist');
SELECT has_table('public', 'support_ticket_messages', 'P06 separates ticket messages');
SELECT has_table('public', 'support_incidents', 'P06 critical incidents exist');
SELECT has_function('public', 'create_support_ticket', ARRAY['text','text','text','uuid'], 'clients open tickets through the canonical RPC');
SELECT has_function('public', 'admin_update_support_ticket', ARRAY['uuid','integer','text','uuid'], 'admins update with an observed version');
SELECT ok(NOT has_table_privilege('authenticated', 'public.support_tickets', 'INSERT'), 'authenticated users cannot bypass the ticket RPC');
SELECT ok(NOT has_table_privilege('authenticated', 'public.support_ticket_messages', 'INSERT'), 'authenticated users cannot bypass message visibility');

INSERT INTO auth.users(id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) VALUES
 ('00000000-0000-4000-8000-000000086001','authenticated','authenticated','support-client-a@example.invalid','x',now(),'{}','{}',now(),now()),
 ('00000000-0000-4000-8000-000000086002','authenticated','authenticated','support-client-b@example.invalid','x',now(),'{}','{}',now(),now()),
 ('00000000-0000-4000-8000-000000086003','authenticated','authenticated','support-admin@example.invalid','x',now(),'{}','{}',now(),now());
INSERT INTO public.user_roles(user_id, role) VALUES
 ('00000000-0000-4000-8000-000000086001','client'),
 ('00000000-0000-4000-8000-000000086002','client'),
 ('00000000-0000-4000-8000-000000086003','admin')
ON CONFLICT DO NOTHING;

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000086001';
SELECT lives_ok($$SELECT public.create_support_ticket('כניסה לחשבון','account','איני מצליח להיכנס לחשבון שלי','00000000-0000-4000-8000-000000086101')$$, 'client can create a bounded support ticket');
SELECT lives_ok($$SELECT public.create_support_ticket('כניסה לחשבון','account','retry payload is ignored authoritatively','00000000-0000-4000-8000-000000086101')$$, 'ticket create retry is idempotent');
SELECT is((SELECT count(*) FROM public.support_tickets WHERE client_id = auth.uid()), 1::bigint, 'ticket retry creates one row');
SELECT is((SELECT count(*) FROM public.support_tickets), 1::bigint, 'client RLS sees only its own ticket');
SELECT lives_ok(format($q$SELECT public.add_support_ticket_message(%L,'מידע נוסף לפנייה','00000000-0000-4000-8000-000000086102')$q$, (SELECT id FROM public.support_tickets WHERE client_id=auth.uid())), 'client adds public information');
SELECT lives_ok(format($q$SELECT public.add_support_ticket_message(%L,'מידע נוסף לפנייה','00000000-0000-4000-8000-000000086102')$q$, (SELECT id FROM public.support_tickets WHERE client_id=auth.uid())), 'message retry is idempotent');
SELECT is((SELECT count(*) FROM public.support_ticket_messages), 1::bigint, 'message retry creates one row');

SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000086002';
SELECT is((SELECT count(*) FROM public.support_tickets), 0::bigint, 'another client cannot read the ticket');
SELECT throws_ok($$SELECT public.add_support_ticket_message((SELECT id FROM public.support_tickets LIMIT 1),'אסור','00000000-0000-4000-8000-000000086103')$$, 'support_ticket_not_found', 'another client cannot mutate the ticket');

RESET ROLE;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000086003';
SELECT lives_ok(format($q$SELECT public.admin_add_support_ticket_message(%L,'תשובה ללקוח','client','00000000-0000-4000-8000-000000086104')$q$, (SELECT id FROM public.support_tickets LIMIT 1)), 'admin reply is stored');
SELECT lives_ok(format($q$SELECT public.admin_add_support_ticket_message(%L,'הערה פנימית','internal','00000000-0000-4000-8000-000000086105')$q$, (SELECT id FROM public.support_tickets LIMIT 1)), 'admin internal note is stored separately');
SELECT is((SELECT count(*) FROM public.support_ticket_messages WHERE visibility='internal'), 1::bigint, 'one internal note exists');
SELECT ok(EXISTS(SELECT 1 FROM public.audit_logs WHERE action='support.ticket.internal_note_added'), 'internal note is audited without exposing its body');
SELECT lives_ok(format($q$SELECT public.admin_update_support_ticket(%L,%s,'closed','00000000-0000-4000-8000-000000086003')$q$, (SELECT id FROM public.support_tickets LIMIT 1), (SELECT version FROM public.support_tickets LIMIT 1)), 'admin closes with the observed version');
SELECT throws_ok(format($q$SELECT public.admin_update_support_ticket(%L,1,'closed',NULL)$q$, (SELECT id FROM public.support_tickets LIMIT 1)), 'expected_version_mismatch', 'stale admin update is rejected');
SELECT lives_ok($$SELECT public.admin_create_support_incident('outage','critical','השבתת שירות','השירות אינו זמין ונדרש בירור מיידי',NULL,ARRAY[(SELECT id FROM public.support_tickets LIMIT 1)],'00000000-0000-4000-8000-000000086106')$$, 'admin opens and links a critical incident');
SELECT lives_ok($$SELECT public.admin_create_support_incident('outage','critical','השבתת שירות','retry does not duplicate the incident',NULL,ARRAY[]::uuid[],'00000000-0000-4000-8000-000000086106')$$, 'incident retry is idempotent');
SELECT is((SELECT count(*) FROM public.support_incidents), 1::bigint, 'incident retry creates one row');
SELECT is((SELECT escalation_status FROM public.support_incidents LIMIT 1), 'pending_configuration', 'missing outbound configuration is reported truthfully');
SELECT ok(EXISTS(SELECT 1 FROM public.notifications WHERE user_id='00000000-0000-4000-8000-000000086003' AND type='support_incident_opened'), 'the existing in-app channel receives the incident');
SELECT ok(EXISTS(SELECT 1 FROM public.audit_logs WHERE action='support.incident.opened'), 'incident opening is audited');
RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000086001';
SELECT is((SELECT count(*) FROM public.support_ticket_messages), 2::bigint, 'client sees its own public messages but not the internal note');
SELECT is((SELECT count(*) FROM public.support_incidents), 0::bigint, 'clients cannot read incidents');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
