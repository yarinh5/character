# Master Engineering Plan V2

מסמך זה מתרגם את תוכנית המוצר V2 לתוכנית הנדסית שמתאימה למימוש הקיים בפרויקט.
המסמך הוא מקור אמת הנדסי לפני כתיבת קוד, migrations או שינויי UI.

## החלטות ארכיטקטורה מאושרות

1. אין Rewrite. משמרים את המערכת הקיימת ומרחיבים אותה בשלבים קטנים.
2. `assigned_operator_id` נשאר metadata legacy ותאימות לאחור. אחריות V2 תנוהל בטבלאות NEW/task חדשות.
3. NEW ייבנה כמודל עצמאי של work items / handling cycles עם claim/release אטומיים.
4. Unlocks קיימים של paid images נשמרים כ-grandfathered access. מודל V2 החדש יחייב כל פתיחה חדשה בנפרד ל-7 שניות.
5. מדיה תעבור למודל tags באמצעות שכבת `media_tags`; כל asset קיים יקבל tag ברירת מחדל לפי הדמות.
6. Onboarding חובה: שם, תאריך לידה, גיל מחושב, עיר, תמונת פרופיל, bio קצר, interests והעדפות בסיסיות. שדות כמו עישון וסטטוס אישי נשמרים כחלק מהמודל, ורמת החובה שלהם תיקבע בולידציה.
7. ONLINE יתחיל עם מגבלת spam שמרנית: פנייה יזומה אחת לכל operator-client-character ב-24 שעות, ולא אם קיימת שיחה שממתינה ב-NEW.
8. חסימת לקוח ברמת עובד מונעת הקצאה ויזימה לאותו עובד ומסתירה ממנו NEW, אבל אינה חוסמת עובדים אחרים או אדמין.
9. Stickers הם המודל היחיד לפריטים ויזואליים חינמיים/בתשלום בצ'אט: מחיר, חיוב, payout וקרדיטי עובד נשארים לפי המימוש שאושר.
10. לפני V2 חייבים להכריע את ה-worktree והמיגרציות הלא סגורות, כולל שינויי operator credits קיימים.

## עקרונות ביצוע

- כל Phase חייב להיות ניתן לבדיקה ו-commit עצמאי.
- לא מתחילים UI שתלוי במבנה נתונים שעדיין לא הוגדר ונבדק.
- כל פעולה רגישה עוברת RPC או Server Function עם audit, ולא direct frontend write.
- כל migration הוא additive כברירת מחדל. Drop/rename רק אחרי תקופת תאימות.
- Supabase types נוצרים מחדש אחרי migrations ומאומתים מול build.
- Realtime ו-cache invalidation מוגדרים כחלק מה-Phase, לא כתוספת בסוף.

## מצב קיים רלוונטי

- Routes קיימים: `src/routeTree.gen.ts`, כולל `/app/characters`, `/app/favorites`, `/app/conversations`, `/operator/conversations`, `/operator/chat/$conversationId`, `/admin/stickers`, `/admin/credits`.
- אין routes ל-NEW, ONLINE או `/app/characters/$characterId`.
- Roles, profiles, operators, characters, assignments, conversations, messages, reports קיימים במיגרציה הבסיסית.
- Chat RPCs קיימים: `start_or_get_conversation`, `send_client_message`, `send_operator_message`, `mark_conversation_read`.
- Shared Inbox כבר הועבר לגישת assigned character ולא רק `assigned_operator_id`.
- Open/Warning/Lock קיימים באמצעות `conversation_locks`.
- Discovery/favorites/cycles קיימים חלקית.
- Media inventory/reservations/locked images קיימים חלקית.
- Stickers קיימים וכוללים paid flow מאושר: לקוח משלם בכל שליחת מדבקה בתשלום, אותו סכום נכנס לעובד המטפל, ועובד/אדמין שולחים ללא חיוב או payout.
- קרדיטי עובד קיימים ומאושרים: הודעת לקוח מזכה את העובד המטפל ב-1 קרדיט, והודעות עובד מזכות עד 3 קרדיטים בכל מחזור מאז הודעת הלקוח האחרונה. אין לפתוח מחדש את המודל הזה במסגרת V2 אלא רק לחבר אותו לאחריות NEW.
- Notifications/SLA/Analytics קיימים חלקית.

---

## Phase 0.1 - Freeze, Baseline And Worktree Decision

### מטרה
לקבע נקודת התחלה בטוחה ל-V2 לפני כל שינוי פונקציונלי.

### מצב קיים
יש worktree לא נקי ושינויים קיימים שאינם חלק מתוכנית V2 הרשמית. קיימת היסטוריית migrations שמסומנת legacy-aligned ולא ודאית לפי timestamp.

### השינוי המבוקש
להחליט מה נכנס ל-main לפני V2 ומה נדחה. לתעד baseline של קוד, DB, migrations ו-types.

### טבלאות ומבנה נתונים
אין שינוי מבני.

### RPCs ו-Server Functions
אין שינוי.

### RLS והרשאות
אין שינוי.

### קבצי Frontend
אין שינוי. רק תיעוד מצב קיים של routes ו-flow.

### Realtime ו-Cache invalidation
אין שינוי.

### Migration ו-Backfill
אין migration. יש להכריע אם מיגרציות WIP, למשל operator credit management, נכנסות ל-chain.

### בדיקות
`git status`, `npx tsc --noEmit`, `npm run build`, בדיקת secrets, סקירת migration list מול schema.

### תנאי קבלה
worktree נקי או מתועד; build ו-TypeScript עוברים; ידוע איזה migration chain הוא authoritative.

### סיכונים
המשך עבודה על בסיס לא נקי יגרום ל-conflicts ול-types לא אמינים.

### Rollback
אין שינויי קוד. אם נמצא WIP לא רצוי, מחליטים ידנית אם לשמור, להעביר לענף, או להסיר לפי בקשת בעל השינוי.

### מחוץ ל-Scope
כל שינוי business logic, UI, DB schema או RLS.

---

## Phase 0.2 - Technical Stabilization

### מטרה
להביא את התשתית למצב שבו כל שינוי V2 נבדק מול build/types יציבים.

### מצב קיים
`tsc --noEmit` עובר. `build` לא נבדק במסגרת audit כי הוא עלול לכתוב artifacts. `.env` מוחרג ב-gitignore. Pagination בצ'אט קיים דרך `src/lib/messagePagination.ts`.

### השינוי המבוקש
להריץ build אחרי freeze, לתקן שגיאות blocking בלבד, ולוודא שאין regression בצ'אט, קרדיטים, קרדיטי עובד והרשאות.

### טבלאות ומבנה נתונים
אין שינוי.

### RPCs ו-Server Functions
אין שינוי.

### RLS והרשאות
אין שינוי. רק סקירת advisory/security.

### קבצי Frontend
`package.json`, `src/lib/messagePagination.ts`, קבצי chat קיימים לצורך verification בלבד.

### Realtime ו-Cache invalidation
לוודא שה-subscriptions הקיימים ל-`messages`, `conversation_locks`, `internal_notes`, `customer_info_entries` לא נשברים.

### Migration ו-Backfill
אין.

### בדיקות
`npx tsc --noEmit`, `npm run build`, smoke test ידני לצ'אט לקוח/עובד/אדמין, שליחת הודעה עם קרדיט, שליחת הודעת עובד, pagination older messages.

### תנאי קבלה
build עובר ואין שינוי behavior.

### סיכונים
נגיעה רחבה מדי ב-lint/format עלולה לערבב שינויי V2 עם formatting.

### Rollback
להחזיר רק את תיקוני stabilization של אותו commit.

### מחוץ ל-Scope
פיצ'רים חדשים.

---

## Phase 1.1 - V2 Data Architecture ADR

### מטרה
לתעד סופית את מודלי הנתונים החדשים לפני migrations.

### מצב קיים
יש טבלאות ל-chat, media, stickers, credits, analytics. חסרות טבלאות NEW, online presence גלובלי, media tags, media open sessions, operator-client blocks.

### השינוי המבוקש
לכתוב ADR הנדסי עם ERD, שמות טבלאות, קשרים, lifecycle, idempotency keys, הרשאות ו-backfill.

### טבלאות ומבנה נתונים
תכנון בלבד עבור:
- `conversation_work_items`
- `conversation_handling_cycles`
- `operator_presence`
- `operator_capacity_settings`
- `operator_client_blocks`
- `media_tags`
- `media_open_sessions`
- הרחבות `client_profiles`
- הרחבות `discovery_cities`

### RPCs ו-Server Functions
תכנון חתימות בלבד.

### RLS והרשאות
תכנון מדיניות: client owns, operator assigned-to-character, admin all, service role only for media processing.

### קבצי Frontend
אין שינוי. תכנון השפעה על routes/components.

### Realtime ו-Cache invalidation
להגדיר channels/invalidations לפני UI.

### Migration ו-Backfill
תכנון backfill בלבד.

### בדיקות
סקירת ADR מול תוכנית מוצר וקוד קיים.

### תנאי קבלה
ADR מאושר; אין שאלה פתוחה שחוסמת DB.

### סיכונים
תכנון חסר יחייב migration נוסף מסוכן.

### Rollback
ADR בלבד; אין rollback טכני.

### מחוץ ל-Scope
כתיבת migrations או UI.

---

## Phase 1.2 - NEW Database Foundation

### מטרה
להוסיף את בסיס הנתונים של NEW בלי לשנות את UI הקיים.

### מצב קיים
שיחות ממתינות מיוצגות דרך `conversations.status = waiting` ו-unread counts. אין task/work item נפרד.

### השינוי המבוקש
להוסיף work item לכל מחזור טיפול: הודעת לקוח חדשה פותחת/מעדכנת item אחד לשיחה, item יכול להיות pending/claimed/completed/expired/cancelled.

### טבלאות ומבנה נתונים
להוסיף:
- `conversation_work_items`
- `conversation_handling_cycles`
- indexes לפי `status`, `character_id`, `waiting_since`, `claimed_by_operator_id`
- `system_settings.max_active_work_items_per_operator`

לשמר:
- `conversations.assigned_operator_id` כ-legacy metadata.
- `conversations.status` לצורכי תאימות UI קיימת.

### RPCs ו-Server Functions
עדיין לא claim מלא. בשלב זה רק helper פנימי ליצירת/סגירת work item מתוך message trigger.

### RLS והרשאות
RLS enabled. Operators יכולים select רק work items של דמויות משויכות. Admin הכל. Clients לא ניגשים לטבלאות NEW.

### קבצי Frontend
אין שינוי.

### Realtime ו-Cache invalidation
להוסיף publication/realtime ל-work items רק אם נדרש; בשלב זה ניתן לבדוק DB בלבד.

### Migration ו-Backfill
Backfill אופציונלי: ליצור pending work item לשיחות קיימות שה-last message שלהן מהלקוח ועדיין ממתינות.

### בדיקות
SQL tests: הודעת לקוח יוצרת work item אחד; כמה הודעות רצופות לא יוצרות כפילות; הודעת עובד סוגרת item.

### תנאי קבלה
DB מייצר NEW state ללא השפעה על UI קיים.

### סיכונים
Trigger כפול על messages יכול ליצור race מול status/unread.

### Rollback
Disable trigger/helper החדש, להשאיר טבלאות ללא שימוש.

### מחוץ ל-Scope
מסך NEW, claim UI, ONLINE.

---

## Phase 1.3 - NEW Allocation RPCs And Capacity

### מטרה
לאפשר claim/release/complete אטומיים ל-work items.

### מצב קיים
אין allocation אמיתי; dashboard מציג שיחות ממתינות לפי unread/status.

### השינוי המבוקש
RPCs:
- `get_new_work_items`
- `claim_next_work_item`
- `claim_work_item`
- `complete_work_item`
- `release_work_item`
- `heartbeat_operator_presence`
- `set_operator_capacity`

### טבלאות ומבנה נתונים
להרחיב `conversation_work_items` עם `claimed_at`, `claim_expires_at`, `claim_token`, `completed_at`, `release_reason`.
להוסיף `operator_presence` או להרחיב מודל presence גלובלי נפרד מ-`user_active_conversations`.

### RPCs ו-Server Functions
כל claim חייב `FOR UPDATE SKIP LOCKED` או מנגנון מקביל למניעת הקצאה כפולה.

### RLS והרשאות
Operators יכולים claim רק דמויות משויכות ורק כשפעילים/זמינים/לא חסומים מול לקוח. Admin יכול release/transfer.

### קבצי Frontend
אין UI מלא. אפשר להוסיף lib/hook רק אם נדרש לבדיקה טכנית, אבל עדיף DB tests קודם.

### Realtime ו-Cache invalidation
Realtime על `conversation_work_items` עבור `status/claimed_by_operator_id`. Cache keys עתידיים: `operator-new-items`, `operator-capacity`.

### Migration ו-Backfill
אין backfill נוסף מעבר ל-Phase 1.2.

### בדיקות
שני operators מנסים claim במקביל; רק אחד מצליח. disconnect/expired claim חוזר לתור. capacity מונע claim מעבר למקסימום.

### תנאי קבלה
Allocation עובד DB-first ללא UI.

### סיכונים
גבוה: concurrency, RLS ו-lock starvation.

### Rollback
Feature flag `new_queue_enabled = false`; UI קיים ממשיך לעבוד על conversations.

### מחוץ ל-Scope
מסך NEW.

---

## Phase 2.1 - Client Profile Schema And Backfill

### מטרה
להרחיב את `client_profiles` לדרישות onboarding/profile V2.

### מצב קיים
`client_profiles` כולל `age`, `gender`, `interests`, `conversation_preferences` בלבד. `profiles` כולל display/email/avatar/status.

### השינוי המבוקש
להוסיף שדות profile/onboarding בלי לחסום משתמשים קיימים עד Phase 2.2.

### טבלאות ומבנה נתונים
להוסיף ל-`client_profiles`:
- `first_name`, `last_name`
- `date_of_birth`, `computed_age`
- `city_id`
- `bio`
- `relationship_status`
- `smoking_status`
- `preferred_min_age`, `preferred_max_age`
- `preferred_distance_km`
- `content_preferences`
- `character_preferences`
- `onboarding_step`, `onboarding_completed_at`
- `profile_image_url`, `profile_image_urls`

להרחיב `discovery_cities` עם coordinates אם חסר.

### RPCs ו-Server Functions
לשקול `save_client_onboarding_step` ו-`complete_client_onboarding` כדי לרכז validation server-side.

### RLS והרשאות
Client update own profile; admin read/update; operators read only clients in assigned conversations/ONLINE בהתאם למדיניות.

### קבצי Frontend
אין UI עדיין. רק types regeneration אחרי migration.

### Realtime ו-Cache invalidation
אין Realtime. Cache: `profile`, `client-profile`.

### Migration ו-Backfill
Backfill:
- לפרק `profiles.display_name` ל-first/last best effort.
- `computed_age` מתוך `age` זמני אם אין DOB.
- `profile_image_url` מתוך `profiles.avatar_url`.
- `onboarding_completed_at` רק למי שעומד בתנאי legacy מינימליים.

### בדיקות
Migration test על משתמשים עם/בלי age/avatar/interests. RLS update/select.

### תנאי קבלה
כל המשתמשים הקיימים נשארים פעילים; types מעודכנים; אין שבירת profile/registration.

### סיכונים
PII ו-backfill שגוי ל-DOB/computed age.

### Rollback
להשאיר שדות לא בשימוש. לא למחוק.

### מחוץ ל-Scope
UI onboarding.

---

## Phase 2.2 - Mandatory Onboarding UI And Guard

### מטרה
להפוך onboarding לחובה לפי V2.

### מצב קיים
`app.index.tsx` מפנה ל-onboarding רק בכניסה ל-`/app`; ניתן לדלג בכפתור ישיר ל-characters. `ClientLayout` לא אוכף guard גלובלי.

### השינוי המבוקש
לבנות onboarding רב-שלבי עם שמירת התקדמות, validation ותמונות, ולחסום כל route לקוח עד השלמה.

### טבלאות ומבנה נתונים
משתמש ב-Phase 2.1.

### RPCs ו-Server Functions
`save_client_onboarding_step`, `complete_client_onboarding`, אולי upload intent לתמונות profile נוספות.

### RLS והרשאות
Client רשאי לערוך רק עצמו. Operators לא רואים PII שלא נדרש.

### קבצי Frontend
`src/routes/app.onboarding.tsx`, `src/routes/app.profile.tsx`, `src/routes/app.index.tsx`, `src/components/client/ClientLayout.tsx`, `src/components/common/AvatarUpload.tsx`.

### Realtime ו-Cache invalidation
Invalidate `client-profile`, `auth/profile`, `analytics-events` לאחר complete.

### Migration ו-Backfill
אין migration. משתמש בנתוני Phase 2.1.

### בדיקות
לקוח חדש לא נכנס ל-app לפני השלמה. לקוח legacy עם completed flag ממשיך. תמונה לא חוקית נדחית.

### תנאי קבלה
אין skip; direct URL חסום; profile editable אחרי onboarding.

### סיכונים
חסימת לקוחות קיימים בטעות.

### Rollback
Feature flag `mandatory_onboarding_enabled = false`.

### מחוץ ל-Scope
Discovery distance UI מתקדם.

---

## Phase 3.1 - Discovery Filters And Character Profile Route

### מטרה
להשלים discovery/profile ללא שינוי מודל chat.

### מצב קיים
יש swipe card, favorites, city/age filters. אין profile route מלא, distance, interests/favorites/show-all filters.

### השינוי המבוקש
להוסיף route לפרופיל דמות מלא ולהרחיב filters.

### טבלאות ומבנה נתונים
להרחיב `discovery_cities` ל-lat/lng אם חסר. אולי להוסיף preference filters נשמרים ל-client profile.

### RPCs ו-Server Functions
להרחיב `get_discovery_characters(_filters jsonb)` לתמוך ב-distance/interests/show_all/favorites.
להוסיף `get_character_profile(_character_id)` אם direct select אינו מספיק.

### RLS והרשאות
Public/client רואים רק active/visible characters. Operators/admin לפי הרשאות קיימות.

### קבצי Frontend
`src/routes/app.characters.tsx`, route חדש `src/routes/app.characters.$characterId.tsx`, `DiscoveryFilters`, `DiscoveryCard`, `DiscoveryActionBar`, `FavoriteCard`.

### Realtime ו-Cache invalidation
Cache keys: `discovery-card`, `favorites`, `character-profile`. Invalidate after favorite/swipe.

### Migration ו-Backfill
Backfill city coordinates. אין שינוי לשיחות.

### בדיקות
Like לא יוצר שיחה. X מסתיר בסבב. exhaustion יוצר cycle חדש. profile מציג continue chat כשקיימת שיחה.

### תנאי קבלה
כל דרישות Phase 3-4 עובדות בלי פגיעה בצ'אט.

### סיכונים
Filter hash/cycle logic עלול לשבור recycling.

### Rollback
להחזיר UI ל-card קיים; להשאיר DB fields.

### מחוץ ל-Scope
NEW, ONLINE, media V2.

---

## Phase 4.1 - Conversation Responsibility Integration

### מטרה
לחבר את מודל הצ'אט הקיים לאחריות NEW בלי לשבור הודעות קיימות.

### מצב קיים
`send_client_message` מחייב קרדיט ומזכה את העובד המטפל. `send_operator_message` יכול לזכות את העובד השולח לפי מגבלת הרצף. אין handling cycle רשמי.

### השינוי המבוקש
כאשר לקוח שולח הודעה: לפתוח/לעדכן work item ולשמר את זיכוי העובד המטפל. כאשר עובד עונה: לסגור cycle ולשייך קרדיטי עובד/מדבקות לעובד האחראי.

### טבלאות ומבנה נתונים
`conversation_work_items`, `conversation_handling_cycles`, קשר ל-`messages`, optional `responsible_operator_id` snapshot.

### RPCs ו-Server Functions
לעדכן:
- `send_client_message`
- `send_operator_message`
- private credit/payout helpers

### RLS והרשאות
Operator send עדיין רק assigned character. ב-Lock רק holder. ב-Open/Warning שולחים מורשים, אבל responsible נשאר מי שנקבע ב-NEW.

### קבצי Frontend
מעט או ללא שינוי UI. `operator.chat.$conversationId.tsx` יקבל responsibility state לקריאה בלבד.

### Realtime ו-Cache invalidation
Invalidate `operator-new-items`, `conversation`, `operator-performance`.

### Migration ו-Backfill
Backfill work item לשיחות waiting בלבד.

### בדיקות
הודעת לקוח עולה קרדיט פעם אחת ופותחת NEW. הודעת עובד סוגרת cycle. payout הולך לעובד האחראי.

### תנאי קבלה
הצ'אט הישן עדיין עובד; NEW state עקבי.

### סיכונים
גבוה: כפילות חיוב/קרדיטי עובד או סגירת cycle לא נכונה.

### Rollback
Feature flag ל-disable responsibility; חזרה לפתרון assigned/lock/latest.

### מחוץ ל-Scope
מסך NEW מלא.

---

## Phase 4.2 - Open / Warning / Lock With NEW

### מטרה
להתאים את מנגנון concurrency הקיים לאחריות NEW.

### מצב קיים
Open/Warning/Lock קיימים ב-`conversation_locks` וב-UI operator chat. Lock לא נוצר מתוך NEW.

### השינוי המבוקש
ב-Lock: claim של work item יוצר/מחזיק lock. ב-Warning/Open: עובדים אחרים יכולים לענות לפי הכללים, אך responsibility לא משתנה אלא דרך RPC מפורש.

### טבלאות ומבנה נתונים
להוסיף קשר בין `conversation_locks` ל-work item או לשמור `work_item_id` ב-lock metadata.

### RPCs ו-Server Functions
להרחיב `acquire_conversation_lock`, `release_conversation_lock`, `claim_work_item`, `complete_work_item`.

### RLS והרשאות
Admin release/transfer; operator release own; no direct frontend update ל-lock/task.

### קבצי Frontend
`src/routes/operator.chat.$conversationId.tsx`, `src/routes/admin.conversations.$conversationId.tsx`.

### Realtime ו-Cache invalidation
Subscriptions קיימים ל-`conversation_locks`; להוסיף work item invalidation.

### Migration ו-Backfill
אין backfill.

### בדיקות
Open מאפשר תשובה; Warning מציג אזהרה; Lock חוסם אחרים; release/timeout מחזיר task.

### תנאי קבלה
שלושת המצבים עובדים גם דרך NEW.

### סיכונים
Deadlocks בין task claim ל-lock claim.

### Rollback
להשאיר lock mode קיים ולנתק אותו מ-NEW flag.

### מחוץ ל-Scope
ONLINE ומדיה.

---

## Phase 5.1 - Operator NEW Screen

### מטרה
להוסיף מסך עובד חדש לטיפול בשיחות ממתינות.

### מצב קיים
Operator dashboard מציג "שיחות שממתינות למענה" לפי `status/unread`, אבל אין תור משימות.

### השינוי המבוקש
Route `/operator/new` עם רשימת משימות, claim next, active task, release/complete, priority לפי waiting time.

### טבלאות ומבנה נתונים
משתמש ב-NEW tables.

### RPCs ו-Server Functions
`get_new_work_items`, `claim_next_work_item`, `release_work_item`, `complete_work_item`.

### RLS והרשאות
רק דמויות משויכות. Respect operator-client blocks. Respect capacity.

### קבצי Frontend
`OperatorLayout`, route חדש `operator.new.tsx`, hooks חדשים `useNewWorkItems`, `useClaimWorkItem`.

### Realtime ו-Cache invalidation
Realtime on work items. Invalidate on claim/release/message sent. Query keys by operator id/status.

### Migration ו-Backfill
אין migration.

### בדיקות
עובד רואה רק assigned characters; אין הקצאה כפולה; disconnect מחזיר לתור; capacity נאכף.

### תנאי קבלה
NEW עובד end-to-end בלי לשבור `/operator/conversations`.

### סיכונים
Race conditions ב-claim ו-cache stale.

### Rollback
להסתיר nav דרך feature flag.

### מחוץ ל-Scope
ONLINE, media V2.

---

## Phase 6.1 - ONLINE Backend Foundation

### מטרה
להוסיף יכולת לזהות לקוחות פעילים וליזום פנייה מבוקרת.

### מצב קיים
יש `user_active_conversations` לנוכחות בתוך שיחה בלבד. אין last_seen גלובלי ללקוח.

### השינוי המבוקש
מעקב `client_presence/last_seen_at`, חיפוש לקוחות אונליין, RPC ייזום שיחה/הודעה לפי דמות משויכת.

### טבלאות ומבנה נתונים
להוסיף או להרחיב:
- `client_presence`
- `operator_outreach_attempts`
- indexes לפי `last_seen_at`, `city_id`, `age`

### RPCs ו-Server Functions
- `touch_client_presence`
- `get_online_clients`
- `operator_start_outreach`

### RLS והרשאות
Operator רואה לקוחות לפי הרשאות מוגבלות ויכול לבחור רק דמות משויכת. Admin unrestricted.

### קבצי Frontend
אין UI מלא.

### Realtime ו-Cache invalidation
Presence update לא חייב realtime מלא; אפשר polling/cache קצר.

### Migration ו-Backfill
Backfill `last_seen_at` מתוך analytics או `profiles.updated_at` אם קיים, אחרת null.

### בדיקות
Operator לא יכול לפנות בשם דמות לא משויכת. Rate limit 24h נאכף. Reply נכנס ל-NEW.

### תנאי קבלה
RPCs עוברים בדיקות בלי UI.

### סיכונים
חשיפת PII רחבה מדי לעובדים.

### Rollback
Disable `online_enabled`.

### מחוץ ל-Scope
מסך ONLINE.

---

## Phase 6.2 - ONLINE Operator UI

### מטרה
להוסיף מסך `/operator/online`.

### מצב קיים
אין route/nav.

### השינוי המבוקש
רשימת לקוחות מחוברים/last seen, חיפוש לפי שם/עיר/גיל, צפייה בפרופיל, ייזום הודעה.

### טבלאות ומבנה נתונים
משתמש ב-Phase 6.1.

### RPCs ו-Server Functions
`get_online_clients`, `operator_start_outreach`.

### RLS והרשאות
UI אינו מחליף בדיקות RPC.

### קבצי Frontend
`OperatorLayout`, route חדש `operator.online.tsx`, profile preview component.

### Realtime ו-Cache invalidation
Query interval קצר או realtime presence אם יציב. Invalidate conversations ו-NEW לאחר outreach/reply.

### Migration ו-Backfill
אין.

### בדיקות
חיפוש, ייזום, rate limit, admin bypass.

### תנאי קבלה
עובד לא יכול spam ולא יכול לבחור דמות לא משויכת.

### סיכונים
ביצועים ברשימות לקוחות גדולות.

### Rollback
להסתיר nav/feature flag.

### מחוץ ל-Scope
מדיה, onboarding.

---

## Phase 7.1 - Media Tags And Inventory Migration

### מטרה
להעביר מדיה למודל tag כללי/פרטי בלי לאבד inventory קיים.

### מצב קיים
`character_media_assets` קשור ישירות ל-`character_id`. אין tags/global pool.

### השינוי המבוקש
להוסיף `media_tags` ו-`media_tag_id`, ליצור tag ברירת מחדל לכל דמות ו-tag כללי.

### טבלאות ומבנה נתונים
להוסיף:
- `media_tags(id, character_id nullable, scope global/character, name, internal_description, is_active, sort_order)`
- `character_media_assets.media_tag_id`
- constraints: asset belongs to exactly one tag.

### RPCs ו-Server Functions
לעדכן admin upload intent/process להתחשב ב-tag. לעדכן catalog RPC.

### RLS והרשאות
Admin manage tags/assets; operator select catalog only assigned character + global; client no direct access.

### קבצי Frontend
אין UI מלא בשלב ראשון.

### Realtime ו-Cache invalidation
Invalidate media catalog/admin media after tag/asset changes.

### Migration ו-Backfill
Backfill כל asset קיים ל-default character tag. Global tag נוצר ריק.

### בדיקות
Catalog מציג asset קיים אחרי migration. Operator לא רואה tags של דמות לא משויכת.

### תנאי קבלה
אין media asset orphan; שליחה קיימת ממשיכה לעבוד.

### סיכונים
Data loss במדיה אם backfill שגוי.

### Rollback
להמשיך להשתמש ב-`character_id`; לא למחוק אותו.

### מחוץ ל-Scope
View-once/paid open sessions.

---

## Phase 7.2 - Media Admin And Picker By Tags

### מטרה
לעדכן את ניהול המדיה וה-picker לפי tags.

### מצב קיים
Admin media dialog ו-operator picker קיימים, אך אינם מקובצים לפי tags ואין internal description.

### השינוי המבוקש
Admin יוצר tags, מעלה אליהם תמונות, קובע מחיר/סטטוס. Operator רואה global tag + tags של הדמות.

### טבלאות ומבנה נתונים
משתמש ב-Phase 7.1.

### RPCs ו-Server Functions
`get_operator_media_catalog` מחזיר groups/counts/tags. Admin RPCs ל-create/update tags.

### RLS והרשאות
עובד לא משנה מחיר/tag; admin בלבד.

### קבצי Frontend
`CharacterMediaDialog`, `OperatorMediaPicker`, `admin.characters.tsx`.

### Realtime ו-Cache invalidation
Invalidate `operator-media-catalog`, `admin-character-media`, `media-tags`.

### Migration ו-Backfill
אין.

### בדיקות
Global tag זמין לכל דמות; private tag רק לדמות שלה; reservation נשאר אטומי.

### תנאי קבלה
Picker מציג counts, previews, free/price, tag groups.

### סיכונים
UI מורכב מול reservation state.

### Rollback
להציג flat catalog fallback.

### מחוץ ל-Scope
7-second viewing.

---

## Phase 8.1 - Free View Once Images

### מטרה
להוסיף תמונה חינמית קבועה או חד-פעמית ל-7 שניות.

### מצב קיים
Standard image נשמרת וזמינה לצפייה חוזרת.

### השינוי המבוקש
בעת שליחה העובד בוחר `permanent` או `view_once`. View once נפתח פעם אחת בלבד ומציג "נצפה" לאחר מכן.

### טבלאות ומבנה נתונים
להוסיף ל-`message_attachments`: `view_mode`, `view_once_opened_at`, `view_once_completed_at`.
ייתכן טבלת sessions עבור open events.

### RPCs ו-Server Functions
`open_free_view_once_attachment` או הרחבת media view URL resolver עם session.

### RLS והרשאות
Client יכול לפתוח רק attachment בשיחה שלו ורק אם לא נפתח. Operators/admin לפי הרשאות צפייה פנימיות.

### קבצי Frontend
`OperatorMediaPicker`, `MessageAttachment`, hooks ל-attachment URL/access.

### Realtime ו-Cache invalidation
Invalidate attachment access אחרי פתיחה/סיום. אפשר broadcast מקומי למניעת פתיחה כפולה.

### Migration ו-Backfill
כל attachments קיימים מקבלים `view_mode = permanent`.

### בדיקות
פתיחה מתחילה אחרי load מלא; refresh/leave מסיים; אין פתיחה חוזרת.

### תנאי קבלה
View once עובד ללא חיוב קרדיטים.

### סיכונים
סנכרון timer מול signed URL ו-refresh.

### Rollback
להשבית view_once flag; attachments קיימים permanent.

### מחוץ ל-Scope
Paid repeated opens.

---

## Phase 8.2 - Paid Image Open Sessions

### מטרה
להחליף את מודל unlock הקבוע במודל פתיחה בתשלום לכל צפייה חדשה.

### מצב קיים
`message_attachment_unlocks` נותן גישה קבועה; יש unique transaction לכל attachment/client.

### השינוי המבוקש
כל פתיחה בתשלום יוצרת transaction ו-session ל-7 שניות. Unlocks קיימים נשארים grandfathered.

### טבלאות ומבנה נתונים
להוסיף:
- `message_attachment_open_sessions`
- `expires_at`, `loaded_at`, `completed_at`, `device/session metadata`
- `charged_transaction_id`

לשמר:
- `message_attachment_unlocks` לקריאה legacy בלבד.

### RPCs ו-Server Functions
- `open_paid_message_attachment`
- `complete_paid_message_attachment_session`
- לעדכן `get_message_attachment_access`
- לעדכן `media-view-url` resolver.

### RLS והרשאות
Client only own conversation. No direct insert to sessions/transactions.

### קבצי Frontend
`MessageAttachment`, `useMessageAttachmentAccessMap`, `useMessageAttachmentUrl`, `useMediaViewUrl`.

### Realtime ו-Cache invalidation
Invalidate access/session after charge/open/expire.

### Migration ו-Backfill
Backfill none. Existing unlocks remain valid and do not require new payment.

### בדיקות
כל פתיחה חדשה מחייבת שוב; idempotency מונעת double-click double charge; device אחר לא ממשיך session.

### תנאי קבלה
אין double charge; אין free access לתמונה paid; grandfather works.

### סיכונים
גבוה מאוד: חיוב כפול, תלונות לקוחות, race בין signed URLs ו-session expiry.

### Rollback
Feature flag `paid_open_sessions_enabled = false`; fallback ל-unlock legacy.

### מחוץ ל-Scope
שינוי מחירי מדיה ו-tags admin.

---

## Phase 9.1 - Stickers Responsibility Alignment

### מטרה
לשמר Stickers הקיים ולחבר payout ל-responsible worker של NEW.

### מצב קיים
Stickers כוללים free/paid, price, spend/payout. Payout resolver משתמש assigned/lock/latest.

### השינוי המבוקש
Paid sticker payout יבחר עובד אחראי לפי active handling cycle. אם אין cycle, fallback ל-legacy לפי החלטה מתועדת.

### טבלאות ומבנה נתונים
להוסיף reference optional מ-`message_stickers` ל-`conversation_work_items` או `conversation_handling_cycles`.

### RPCs ו-Server Functions
לעדכן private resolver של paid sticker payout ואת send sticker RPCs.

### RLS והרשאות
אין שינוי גישה ישירה. ממשיכים RPC-only.

### קבצי Frontend
לרוב אין שינוי. `StickerPicker` נשאר.

### Realtime ו-Cache invalidation
Invalidate messages, operator performance, credits wallet.

### Migration ו-Backfill
אין תיקון היסטורי אוטומטי אלא אם הוחלט אחרת.

### בדיקות
Paid sticker מחייב לקוח, מוסיף payout לעובד responsible, ולא מכפיל קרדיטי עובד.

### תנאי קבלה
מודל Stickers הקיים עובד כמודל היחיד לפריטים ויזואליים חינמיים/בתשלום בצ'אט.

### סיכונים
שינוי payout היסטורי בטעות.

### Rollback
Fallback resolver ל-legacy.

### מחוץ ל-Scope
שינוי קטלוג Stickers מעבר לאחריות payout.

---

## Phase 10.1 - Admin Sensitive Actions RPC Hardening

### מטרה
להעביר פעולות רגישות שנותרו ב-frontend direct writes ל-RPC/Server Functions עם reason/audit.

### מצב קיים
חלק מהפעולות כבר audited, אך יש direct writes ב-admin reports, conversations, packages/status.

### השינוי המבוקש
RPC/Server Functions לפעולות:
- report status update
- global client block
- conversation status change
- assignment metadata change
- package create/update אם מוגדר רגיש
- lock release/transfer
- media restore

### טבלאות ומבנה נתונים
אין בהכרח שינוי. ייתכן הרחבת `audit_logs.metadata`.

### RPCs ו-Server Functions
להוסיף `admin_*` functions עם `reason`.

### RLS והרשאות
לצמצם direct policies אם RPC מחליף direct mutation. Admin select נשאר.

### קבצי Frontend
`admin.reports.tsx`, `admin.conversations.$conversationId.tsx`, `admin.credits.tsx`, `admin.clients.tsx`, `admin.operators.tsx`, `CharacterMediaDialog`.

### Realtime ו-Cache invalidation
Invalidate admin lists, conversation detail, reports, credits.

### Migration ו-Backfill
אין backfill.

### בדיקות
כל פעולה רגישה דורשת reason ונרשמת ב-audit.

### תנאי קבלה
אין direct frontend mutation לנתונים רגישים.

### סיכונים
שבירת מסכי admin קיימים.

### Rollback
להשאיר policies זמניות עד שה-RPC יציב; להסיר בהדרגה.

### מחוץ ל-Scope
NEW UI או media sessions.

---

## Phase 11.1 - Operator-Level Client Blocks And Reports

### מטרה
לאפשר לעובד לחסום/לדווח לקוח עבור עצמו בלבד.

### מצב קיים
Client reports קיימים; admin global block קיים; אין block פר-עובד.

### השינוי המבוקש
עובד מדווח/חוסם לקוח עם סיבה. NEW/ONLINE לא יקצו לו את הלקוח. עובדים אחרים ממשיכים.

### טבלאות ומבנה נתונים
להוסיף:
- `operator_client_blocks`
- `operator_client_reports` או הרחבת `reports` עם `reporter_operator_id`, `target_client_id`, `scope`

### RPCs ו-Server Functions
- `operator_report_client`
- `operator_block_client`
- `operator_unblock_client` אם מותר
- admin review/resolve

### RLS והרשאות
Operator manage own blocks only. Admin all. Client לא רואה.

### קבצי Frontend
`operator.chat.$conversationId.tsx`, admin reports, admin client detail.

### Realtime ו-Cache invalidation
Invalidate NEW/ONLINE queues after block.

### Migration ו-Backfill
אין.

### בדיקות
Blocked client לא מוקצה לאותו עובד, כן לאחרים; admin רואה סיבה.

### תנאי קבלה
אין block בשם עובד אחר.

### סיכונים
הסתרת שיחות קיימות יותר מדי או פחות מדי.

### Rollback
Disable block enforcement ב-allocator.

### מחוץ ל-Scope
Global admin block redesign.

---

## Phase 12.1 - Client Archive And PII Anonymization

### מטרה
להשלים מחיקה/ארכוב לפי V2 בלי למחוק היסטוריה עסקית.

### מצב קיים
יש `profiles.deleted_at`, auth ban, archive/restore. אין anonymization מלא.

### השינוי המבוקש
להוסיף policy/RPC לאנונימיזציה של PII שאינו נדרש.

### טבלאות ומבנה נתונים
ייתכן הרחבת `profiles`/`client_profiles` עם `anonymized_at`, `archive_reason`.

### RPCs ו-Server Functions
`admin_archive_client_with_reason`, `admin_anonymize_client_pii`, `admin_restore_client`.

### RLS והרשאות
Admin בלבד. Service role אם נדרש auth update.

### קבצי Frontend
`admin.clients.tsx`, `admin-clients.functions.ts`.

### Realtime ו-Cache invalidation
Invalidate client lists/details/conversations.

### Migration ו-Backfill
Backfill none. Existing archived clients may be anonymized manually/batch after approval.

### בדיקות
Archived client cannot login; conversations/transactions/audit remain; PII hidden from UI.

### תנאי קבלה
אין data loss עסקי; אין הצגת PII לא נחוץ.

### סיכונים
משפטי/תפעולי: מחיקת PII שאולי נדרש לשימור.

### Rollback
Anonymization קשה ל-rollback; לכן לבצע רק אחרי אישור policy ולוג audit מלא.

### מחוץ ל-Scope
Legal policy drafting.

---

## Phase 13.1 - Notifications, SLA And Analytics V2

### מטרה
להרחיב מדדים והתראות ל-NEW, media, stickers ו-ONLINE.

### מצב קיים
יש notifications, notification settings, SLA RPC, analytics events חלקיים.

### השינוי המבוקש
להוסיף אירועים והתראות:
- new task assigned
- task expired/released
- media inventory low
- paid media opened/reopened
- sticker paid send/payout
- online outreach sent/replied

### טבלאות ומבנה נתונים
להרחיב event names/metadata. ייתכן materialized summaries בעתיד, לא בשלב ראשון.

### RPCs ו-Server Functions
Triggers/notifications helpers חדשים או הרחבת קיימים.

### RLS והרשאות
Users see own notifications. Admin sees analytics. Operators see own performance.

### קבצי Frontend
`NotificationBell`, `NotificationSettingsCard`, `admin.analytics.tsx`, `operator.analytics.tsx`, analytics functions.

### Realtime ו-Cache invalidation
Realtime notifications קיים. Invalidate analytics לפי date range לאחר events משמעותיים.

### Migration ו-Backfill
אין backfill מלא. אפשר לסמן historical metrics כ-legacy.

### בדיקות
כל event נוצר פעם אחת. Notification dedupe עובד. Analytics לא סופר כפול.

### תנאי קבלה
Admin יכול לראות metrics V2 בסיסיים; operators מקבלים התראות רלוונטיות.

### סיכונים
רעש התראות ו-query performance.

### Rollback
Disable notification types/settings.

### מחוץ ל-Scope
Email/push/salika analytics.

---

## Phase 14.1 - QA, Security And Performance Gate

### מטרה
לסגור V2 עם בדיקות חובה לפני הפעלה רחבה.

### מצב קיים
אין test suite מלאה לכל flows; RLS קיים אך צריך audit אחרי כל הטבלאות החדשות.

### השינוי המבוקש
לבנות checklist/tests ל-DB/RPC/RLS/UI smoke/load.

### טבלאות ומבנה נתונים
אין שינוי.

### RPCs ו-Server Functions
בדיקות לכל RPC רגיש.

### RLS והרשאות
בדיקות IDOR/BOLA: client אחר, operator לא משויך, operator חסום, admin.

### קבצי Frontend
Playwright/manual smoke flows לפי הצורך.

### Realtime ו-Cache invalidation
בדיקות multi-tab/multi-operator ל-NEW, chat, lock, media open.

### Migration ו-Backfill
אימות שאין orphan data ואין invalid references.

### בדיקות
TypeScript, build, Supabase advisors, RLS matrix, load tests ל-NEW/chat/realtime, mobile/RTL.

### תנאי קבלה
כל תרחישי V2 הקריטיים עוברים, ואין regression בצ'אט/קרדיטים/מדיה/סטיקרים.

### סיכונים
בעיות ביצועים ב-NEW וב-realtime יתגלו מאוחר אם לא נבדוק עומס.

### Rollback
Feature flags לפי תחום: NEW, ONLINE, media V2, paid sessions, mandatory onboarding.

### מחוץ ל-Scope
פיצ'רים חדשים.

---

## אסטרטגיית מעבר כוללת

1. Freeze ו-baseline לפני כל migration.
2. Additive migrations בלבד בשלבים הראשונים.
3. Feature flags לכל תחום חדש.
4. Backfill ללא מחיקה: profile fields, media default tags, NEW pending items.
5. תאימות לצ'אט קיים: `conversations`, `messages`, `assigned_operator_id`, `conversation_status` נשמרים.
6. Paid image legacy unlocks נשמרים ולא מחויבים מחדש.
7. Stickers וקרדיטי עובד נשמרים כפי שאושרו; אחרי NEW מעדכנים רק את בחירת העובד האחראי ל-payout, ללא redesign של המחיר, החיוב או ה-UI הקיים.
8. Admin direct writes עוברים ל-RPC בהדרגה, עם תקופת תאימות קצרה.
9. Realtime מתווסף בשלבים: קודם DB/RPC, אחר כך UI.
10. Rollout מדורג: internal/admin, operators נבחרים, ואז כלל המשתמשים.

## סיכוני מערכת מרכזיים

- Data Loss: בעיקר במדיה, paid image unlocks ו-PII anonymization.
- RLS/IDOR: NEW ו-ONLINE חושפים מידע חדש לעובדים ולכן דורשים בדיקות קפדניות.
- Realtime: claim/release ו-lock updates עלולים לגרום stale UI.
- Concurrency: הודעות לקוח, claim, paid open ו-sticker payout חייבים להיות אטומיים.
- Cache: React Query invalidation לא מדויק יגרום לתורים לא מעודכנים.
- ביצועים: NEW דורש indexes חזקים לפי status/waiting/character/operator.
- תאימות לאחור: אסור לשבור שיחות, קרדיטים, שיוכי עובדים, מדיה קיימת או היסטוריית תשלומים.

## מחוץ ל-Scope של V2 הנוכחי

- סליקה אמיתית, Apple Pay, Google Pay, webhooks וחשבוניות.
- תרגום מלא/i18n.
- מערכת רמות.
- וידאו.
- Rewrite של האפליקציה.

---

## V2 Closeout Status

### Completed Modules

- NEW queue, handling cycles, release/timeout, and SLA indicators.
- ONLINE operator outreach foundation and UI.
- Client profile and controlled mandatory-onboarding foundation.
- Discovery filters and character profile routes.
- Media tags, admin tag management, and operator media filtering.
- Free View Once media and Paid Image Open Sessions.
- Paid Sticker responsibility alignment with handling cycles.
- Operator-level client blocks and reports.
- Admin sensitive-action RPC hardening and client PII archive.
- Notifications and analytics events foundation, plus QA/security/release gates.

### Deferred Or Not Enabled

- Production app deployment remains deferred by product decision.
- SLA critical scheduling via pg_cron is deferred; critical notifications require an explicit authorized RPC call.
- SLA warning Bell notifications and `media-inventory-low` notifications are deferred.
- `mandatory_onboarding_enabled` remains controlled and disabled unless product explicitly enables it.
- Environment-specific runtime QA requires isolated Admin, Operator A, Operator B, and Client QA sessions when rerun.

### Product Source Of Truth

- Gifts are removed from the product. Stickers remain the monetized gift-like mechanic.
- Credits, stickers, and payout rules are closed; changes require explicit product approval.
- NEW and ONLINE responsibility rules are the current conversation-routing source of truth.
- Paid Image Open Sessions charge per open and are not permanent unlocks.

### Release State

- Source is pushed to `origin/main` at `c9aa3f9759c7b79ecd0f091dc926c39c356621e9`.
- Production app deployment has not been executed.
- QA-only V2-33 notification migrations were applied to the confirmed QA runtime; no scheduler/cron is enabled.
- Relevant Edge Function sources were deployed only where separately approved; no additional deployment is implied by this closeout.
- Known local-only ignored change: `supabase/.temp/cli-latest`.

### Next Planning

- V3 starts from this closeout and the current V2 product contracts.
- New work proceeds one phase at a time using `Loop Type: Phase`, `QA`, `Regression`, or `Release`.
