# Character Chat OS — תוכנית MVP

מערכת SaaS בעברית RTL לצ'אט בין לקוחות לדמויות פיקטיביות, כשמאחורי כל דמות יש עובד אמיתי. שלושה roles: client, operator, admin. ללא AI, ללא תשלומים, ללא אוטומציות בשלב זה.

הבנייה גדולה מאוד (DB מלא, RLS, 3 פאנלים, realtime, ~25 routes). אני מציע לבנות בשלבים ולא בבת אחת — כך נשמור על איכות, נוכל לבדוק כל שלב, ולהימנע מבאגים שנערמים.

## שלב 0 — תשתיות (טרום-בנייה)
- הפעלת Lovable Cloud (Supabase)
- הגדרת RTL מלא ב-`__root.tsx` (`<html lang="he" dir="rtl">`)
- מערכת עיצוב פרימיום: tokens ב-`styles.css` (oklch), פלטה כחול עמוק/אפור/לבן, fonts עבריים (Heebo/Assistant)
- Layout shells: `ClientLayout`, `OperatorLayout`, `AdminLayout`
- Route guards לפי role (`_authenticated`, `_admin`, `_operator`)

## שלב 1 — Database & Security (Migration אחת מקיפה)
- כל הטבלאות: `profiles`, `client_profiles`, `operators`, `characters`, `character_operator_assignments`, `conversations`, `messages`, `internal_notes`, `reports`, `system_settings`
- ENUM: `app_role` (client/operator/admin) — נשמר בטבלה נפרדת `user_roles` כדי למנוע privilege escalation (חריגה מהמפרט שלך אבל קריטית לאבטחה — `role` ב-`profiles` יוסר)
- Helper functions SECURITY DEFINER: `has_role`, `get_my_role`, `is_admin`, `is_operator`, `get_my_operator_id`, `is_conversation_client`, `is_conversation_operator`, `operator_can_access_character`
- RLS על כל הטבלאות לפי המפרט
- Trigger `handle_new_user` ליצירת profile + role=client אוטומטית
- Trigger לעדכון `last_message_at`/`last_message_preview`/unread counts בהוספת message
- הפעלת Realtime על `conversations`, `messages`, `internal_notes`
- Storage buckets: `character-avatars` (public), `user-avatars` (public)

## שלב 2 — Auth + Public Pages
- Landing (`/`), Login, Register, Forgot Password, Reset Password
- Terms, Privacy, Service Statement (placeholder משפטי)
- Checkbox אישור תנאים + גיל בהרשמה
- Redirect לפי role אחרי login

## שלב 3 — Client Area
- Onboarding (`/app/onboarding`)
- Characters grid (`/app/characters`) — רק active+visible
- Conversations list (`/app/conversations`)
- Chat screen (`/app/chat/:id`) עם Realtime, בועות, אינדיקציה, דיווח
- Profile (`/app/profile`)
- Logic: `start_conversation(character_id)` RPC — מחזיר/יוצר שיחה ומשייך operator עם הכי מעט שיחות פתוחות

## שלב 4 — Operator Panel
- Dashboard עם KPI אישי + שינוי availability
- Conversations list (רק שלו) + פילטרים
- Chat screen עם פאנל פרטי לקוח + internal notes
- Settings

## שלב 5 — Admin Panel
- Dashboard עם KPI גלובליים + charts (recharts)
- Manage Clients (חיפוש, חסימה, צפייה בשיחות)
- Manage Operators (יצירה via Supabase Admin API ב-edge function, שיוך לדמויות, הפעלה/השבתה)
- Manage Characters (CRUD מלא + העלאת תמונות + gallery + שיוך operators)
- Manage Conversations (כל השיחות, העברה לעובד אחר, סגירה)
- Reports management
- System settings (minimum_age, require_age_confirmation)

## שלב 6 — QA & Polish
- בדיקת כל הזרימות
- אימות RLS (בדיקת isolation בין users)
- סיכום QA

## פרטים טכניים

**Stack:** TanStack Start + React + TS + Tailwind + shadcn + lucide + Lovable Cloud (Supabase)

**הבדל מהמפרט (מומלץ אבטחתית):**
- `role` יישמר ב-`user_roles` נפרדת ולא ב-`profiles`. כל ה-RLS תשתמש ב-`has_role(auth.uid(), 'admin')` וכו'. זה מונע privilege escalation דרך עדכון profile עצמי.

**יצירת operators ע"י admin:** דורש Supabase Service Role — ייעשה דרך edge function מאובטחת `admin-create-operator` שמוודאת שהקורא הוא admin.

**Assignment logic:** RPC `start_or_get_conversation(p_character_id)` שעושה את כל הלוגיקה atomically.

**Realtime:** subscriptions ב-hooks ייעודיים (`useConversationMessages`, `useConversationsList`).

## שאלה אחת לפני שמתחילים

הבנייה הזו עצומה (עשרות קבצים, מיגרציה גדולה, 3 פאנלים מלאים). אני מציע **לבנות אותה בכמה הודעות נפרדות לפי השלבים למעלה**, כי:
1. הודעה אחת ענקית = סיכון גבוה לטעויות וקושי לדבג
2. תוכל לאשר כל שלב ולתת פידבק
3. נוכל לבדוק RLS וזרימות בכל שלב

**אם תאשר**, אתחיל עכשיו בשלבים 0+1+2 (תשתית + DB + auth + landing) בהודעה הזו, ובהודעה הבאה נמשיך לשלב 3 (client area), וכן הלאה.

**אם תרצה הכל בבת אחת** — אבנה, אבל זה ייקח זמן רב, יהיו יותר באגים שנצטרך לתקן בסבבים נוספים, ואיכות העיצוב של הפאנלים תהיה פחותה. אני ממליץ בחום על הגישה המדורגת.

מה מעדיף?