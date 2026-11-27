# AC01-AC34 acceptance ledger

As of 2026-11-27. Source of truth: `Product Specification and Work Plan 2026-10-06.md`, section 10.2. AC16 has two separately testable parts, so the 34 numbered criteria occupy 35 rows. This is a completion list, not a new work plan.

The current product-code tree is `a27f4bd` on `codex/product-acceptance-573-135`; later commits through `043b00c` changed progress documentation only. The F: integrated stage was exported from `44c1797`, then given the byte-identical `acc4770` lock update; its generated route tree is byte-identical to `a27f4bd`. Thus current local DB/HTTP results are relevant to this code tree, but they are not a signed, single Product-mode run. Older scoped reports remain historical evidence, not automatic proof of the current revision.

Evidence shorthand: **R27** = `F:/project love/character/.codex-task/product-local-integrated-20261127-01/REPORT.md` (DB twice, 42 files and 1415/1415 each; five concurrency suites; HTTP twice, eight files and 53/53 each; 17 unauthenticated Edge routes; 851/851 Vitest; registration admission and local login/logout). **P12** = `docs/progress/wp12-acceptance-status.md` (links to older scoped reports). A named test file is evidence that its assertions exist; only R27 or a linked execution report establishes that it ran. `מקומי` means relevant local checks passed but the full row's required layers are not established. `חלקי` means some required behavior has narrower evidence. `פתוח` means the specified integrated/operational result is not demonstrated. None is marked formal PASS.

| AC | סטטוס | ראיה קיימת | גרסת Git | נותר להשלמה |
| --- | --- | --- | --- | --- |
| AC01 | מקומי | R27: `claim-concurrency.mjs`, `wp02_handling_allocation.test.sql`, `active_new_responsibility_send.integration.test.ts` | `a27f4bd` | להראות שני עובדים ו־UI/HTTP באותו מרוץ חי; בעל טיפול ושולח יחיד. |
| AC02 | חלקי | R27: `authorized_read_access_revocation.test.sql`, HTTP revocation/media; P12: operator read-only browser | `a27f4bd` | להשלים צפיית ONLINE במדיה לעובד מורשה, דחיית שליחה וחשיפה אפס ללא שיוך דרך UI/Edge חי. |
| AC03 | חלקי | R27: `read-access-revocation-concurrency.mjs`; P12: operator chat outage/browser | `a27f4bd` | שני דפדפנים עם Realtime פתוח בזמן העברת בעלות והסרת שיוך; לוודא עצירת תוכן וחידוש URL. |
| AC04 | חלקי | R27: `admin_operations_snapshot.test.sql` ו־HTTP; P12: admin exception browser | `a27f4bd` | לבצע במסך אדמין צפייה ולקיחה/העברה חיה, audit ואובדן הרשאת שליחה אצל הבעלים הקודם. |
| AC05 | מקומי | R27: `cycle_bound_operator_send.test.sql`, `handling_shadow_foundation.test.sql`, cycle/handling concurrency | `a27f4bd` | מסלול UI ושעון נשלט/עומס לרצף Client/Operator ולחלון 180 שניות. |
| AC06 | מקומי | R27: `wp02_handling_allocation.test.sql`, cycle SQL; P12: P05 presence/SLA checks | `a27f4bd` | job ושעון נשלט עם timeout/Next/Done, והוכחת אירועים שאינם עסקיים במסלול UI. |
| AC07 | מקומי | R27: handling/cycle concurrency, `active_new_responsibility_send.integration.test.ts` | `a27f4bd` | לשלב מרוצי Client/Operator/timeout/Next עם HTTP ו־UI בזמן אמת, לרבות היעדר כפילות. |
| AC08 | חלקי | `operator-online-routing.test.tsx`; `docs/progress/wp03-online-ui.md`; R27 Vitest | `a27f4bd` | ניווט חי לשיחות/ONLINE, בלי outreach פעיל או נתיב עוקף בעלות. |
| AC09 | חלקי | R27: `p06a_registration_eligibility.test.sql`, Auth admission/hook, login/logout והפניה ממסך מוגן; `client-onboarding-gate.test.tsx` | `a27f4bd` | אימות דוא"ל אמיתי, גיל/הסכמה/onboarding דרך דפדפן ושרת, לקוח קיים ושימור נתונים. Local Auth autoconfirm אינו מוכיח זאת. |
| AC10 | חלקי | R27: `wp04_profile_discovery_leads.test.sql`; `docs/progress/wp04-profile-discovery-ui.md` | `a27f4bd` | מסע Like/Lead חי באדמין ובעובד, exhaustion, עיר ללא קואורדינטות ומרחק בממשק. |
| AC11 | חלקי | R27: `wp04_profile_discovery_leads.test.sql`; P12: scoped hide/reconnect route | `a27f4bd` | הסתרה וחידוש קשר באותו חשבון בדפדפן עם אימות היסטוריה ושיחה/יתרה יחידות. |
| AC12 | מקומי | R27: `wp05_media_delivery.test.sql` ו־`media_authorization.integration.test.ts` (שני לקוחות) | `a27f4bd` | קטלוג ומסירה דרך UI מלא, תוך שמירת הנכס הגלובלי. |
| AC13 | מקומי | R27: media HTTP כולל לקוח שני, אותה תמונה מדמות אחרת, retry ו־reserve/send מתחרים | `a27f4bd` | מסע UI והוכחת התנהגות בגרסת Product המשולבת. |
| AC14 | חלקי | R27: media ACL/HTTP, העלאה אמיתית ל־Storage, Edge מורשה ודחיית גישה זרה | `a27f4bd` | להוכיח קובץ פסול/גדול, path ושיחה זרים והיעדר חיוב בכל מקרי הדחייה במסלול חי אחד. |
| AC15 | חלקי | R27: `wp06_client_media_uploads.test.sql`, media HTTP עם finalize/replay והעלאת Storage; orchestration Vitest | `a27f4bd` | ניתוק וחוסר יתרה במסע UI/Edge/DB אחד עם חיוב והודעה בדיוק פעם אחת. |
| AC16-A | חלקי | R27: media SQL/HTTP כולל expiry; regular-media policy tests; WP06 report | `a27f4bd` | חלון 24 שעות נשלט, URL סמוך לתפוגה ו־placeholder ב־UI; אין להסיק מחיקה פיזית מהפקיעה. |
| AC16-B | חלקי | R27: WP06-B SQL ו־media HTTP מפעילים cleanup מול Storage ומאמתים היעלמות; orchestration Vitest | `a27f4bd` | כשל Storage/retry, נגזרות ויתומים היסטוריים, לג backlog והיעדר פגיעה בנכסי דמות תחת fault injection חי. |
| AC17 | חלקי | R27: `wp07_wp08_gift_points.test.sql`, `wp07_wp11_completion.test.sql`, paid HTTP | `a27f4bd` | מסע הרשמה/טקסט/תמונה/Gift וגבולות 50/10/10/מחיר ב־UI/HTTP/DB אחד; אימות דוא"ל נפרד. |
| AC18 | חלקי | R27: `paid_sticker_idempotency.test.sql`, `paid_sticker.integration.test.ts` | `a27f4bd` | Gift שגוי/יקר יותר מול Edge/UI ו־DB עם היעדר פתיחה וחיוב. |
| AC19 | חלקי | R27: `paid_sticker_idempotency.test.sql`; `gift-attachment-flow.test.tsx` | `a27f4bd` | בחירה בין שתי תמונות עם אותו Gift דרך UI/Edge חי; רק הנבחרת נפתחת. |
| AC20 | חלקי | R27: `paid_sticker_idempotency.test.sql` ו־`paid_sticker.integration.test.ts` | `a27f4bd` | retry והרכישה החדשה באותו מסע UI/Edge עם הוכחת session חדש וחיוב יחיד לכל רכישה. |
| AC21 | מקומי | R27: `wp07_wp08_gift_points.test.sql`, handling/cycle SQL ו־concurrency | `a27f4bd` | מרוץ מרובה עובדים וסוגי הודעות עם תגובות 1–4 ושמירת cycle במעבר Product משולב. |
| AC22 | חלקי | R27: `wp07_wp08_gift_points.test.sql` ב־DBx2; P12: gift-points evidence | `a27f4bd` | שניים/ארבעה מחוברים, multi-tab ואפס זכאים בזמן אמת עם conservation ו־retry במעבר משולב; סוויטות ה־concurrency הכלליות אינן הוכחה לתחרות Gift. |
| AC23 | חלקי | R27: `wp07_wp08_gift_points.test.sql`; P12: historical upgrade and operator performance UI | `a27f4bd` | שדרוג עם נתוני עבר ונקודות, חשיפת עמיתים דרך HTTP/UI, מניעת כפל והיעדר יחס כספי. |
| AC24 | חלקי | R27: `wp09_client_levels_migration.offline.test.mjs`/DB chain; `client-level-card.test.tsx` | `a27f4bd` | גבולות הספירה, retry/backfill והתראה יחידה במערכת חיה עם UI; ללא הטבה לא־מוגדרת. |
| AC25 | חלקי | R27: `wp10_account_deletion_cancellation_window.test.sql`, client PII HTTP | `a27f4bd` | Auth/HTTP חי לאישור חסר, פג, מנוצל או של חשבון אחר; session מחובר אינו מספיק. |
| AC26 | חלקי | R27: `wp10_deletion_retention.test.sql`; `deletion-storage-verification.test.ts`; recovery tests | `a27f4bd` | הזרקת כשל DB/Auth/Storage, חידוש בטוח וניקוי פיזי לפי מדיניות בסביבה מבודדת. |
| AC27 | חלקי | R27: `wp11_operator_report_moderation.test.sql`; P12: scoped report/admin browser | `a27f4bd` | חסימה מקומית, דיווח וסגירה גלובלית עם התראות ו־audit במסע שני עובדים ואדמין. |
| AC28 | מקומי | R27: `wp11_server_analytics.test.sql`, `p05_sla_presence_alerts.test.sql` | `a27f4bd` | אנליטיקה וספירת SLA בפועל תחת הודעות חוזרות ו־cycle פעיל, כולל גבולות caps ישנים. |
| AC29 | פתוח | P12: 113→183 historical/paid upgrade rehearsals, clean-chain rehearsal; R27: 183 migrations and DBx2 | `a27f4bd` | להשלים grant/RLS/RPC על שני המסלולים בגרסה אחת; לפתור כשל TAP לא־ריק ב־handling_shadow בלי לשכתב fixture/היסטוריה; זכויות Storage והיעדר אובדן. |
| AC30 | פתוח | R27: DBx2 1415/1415, HTTPx2 53/53 (כולל Edge/Storage מדיה מורשה), five concurrency suites, Edge 17×401; 851/851 Vitest | `a27f4bd` | admission/ראיות Product חתומות לגרסה הפעילה, כיסוי מורשה לנתיבי Edge הנותרים ודגלים, skips מתועדים; לא להסיק PASS מ־401 בלבד. |
| AC31 | פתוח | P12: mobile public Worker, scoped client/operator/admin journeys; R27: 375px register and local login/logout | `a27f4bd` | להשלים כל מסע מרכזי בדפדפן בנוי, כולל שני עובדים/אדמין, מקלדת/focus, שגיאה/ניתוק, מדיה וחיוב. |
| AC32 | פתוח | P12: isolated recovery probe, recovery-control pgTAP, restore-data diagnostic | `a27f4bd` | תרגיל שחזור מלא DB/Auth/Storage, ledger/deletion replay, התראות לבעלים, RTO≤4h/RPO DB≤15m ו־rollback תפעולי. |
| AC33 | חלקי | R27: `paid_sticker_idempotency.test.sql`; regular-media window tests and paid HTTP | `a27f4bd` | שעון נשלט ב־Edge/HTTP/UI ל־60 שניות, retry, URL חדש ופתיחה חדשה; שימור legacy. |
| AC34 | חלקי | R27: `wp10_deletion_retention.test.sql`, `client_pii_archive.test.sql`/HTTP; `admin-conversation-deletion.test.tsx` | `a27f4bd` | מחיקת שיחה אמיתית עם כל סוגי התוכן ב־Storage/jobs/UI, retry, שמירת ledger וקטלוג משותף. |

The next work should close demonstrated gaps only. Prioritize an exact-current-source AC29/AC30 integrated acceptance, then the remaining AC31 authenticated journeys and AC32 operational restore; run narrower probes only when they resolve a specific open row. P06 launch dependencies (approved legal content, bot/provider, alert destination and support owner/channel/hours) are external decisions and cannot be marked closed by local code checks. Do not rerun passing suites merely to populate this ledger.
