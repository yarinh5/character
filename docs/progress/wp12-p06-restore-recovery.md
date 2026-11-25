# WP12 / P06 — שער התאוששות לאחר שחזור

## מצב: IMPLEMENTED OFFLINE — 2026-11-11

המימוש מכין שער fail-closed לאירוע שחזור מזוהה. הוא אינו מבצע שחזור, אינו משנה
יתרות, אינו מפעיל מחיקות ואינו מוכיח RTO/RPO. אירוע חדש מתחיל חסום ומקושר
לזהות נעילה חיצונית, authority חיצוני, snapshot, בעלים וגרסה. restart או timeout
אינם פותחים אותו.

### תנאי פתיחה

- מקור חיצוני חתום ועדכני חייב להוכיח את זהות האירוע, שרשרת manifests וכיסוי
  מחיקות. ה־DB המשוחזר לבדו אינו מקור סמכות לנעילה או לרשימת המחיקות.
- reconciliation נפרד נדרש ל־credit ledger, רכישות Gift ובקשות קרדיט. `matched`
  מתקבל רק ללא gap וללא unknown; לא נוצרות תנועות איזון, חיובים או הענקות.
- מחיקות שהושלמו נקליטות באופן אידמפוטנטי מול
  `private.deletion_completion_ledger`. replay משתמש ב־claim/lease/fencing, אך
  `recovery_deletion_replay_enabled` כבוי כברירת מחדל ודורש אישור הפעלה נפרד.
- hold, reference חסר, coverage חסר, כשל חלקי או ראיה לא עדכנית משאירים את
  האירוע חסום. בדיקת מידע אישי ואישור אדמין קשורים לאירוע ולגרסה הנוכחיים.
- גם אחרי אישור אדמין הסטטוס הוא `approved_pending_external_release`; פתיחה
  מתבצעת רק בגבול server חתום שמשחרר את הנעילה החיצונית המתאימה.

### גבולות פעילות ומסכים

`private.recovery_business_open`, `private.ensure_active_client`, Auth admission,
טריגרים על הודעות/קרדיטים/Gifts/תמיכה ומדיניות RLS מגבילים פעילות וקריאת PII
רגילה. לקוח ועובד רואים מצב תחזוקה כללי בלבד. במסך התמיכה של האדמין מוצגים
אירוע, גרסה, תנאים וחסמים; אין כפתור שמדלג על reconciliation או deletion replay.

### תלויות הפעלה וידוע כלא מאומת

- יש להעמיד לפני restore מקור נעילה/manifest חיצוני מוגן, HMAC, sequence/hash
  chain וכיסוי עדכני. נקודת הקליטה קיימת; בחירת השירות, שמירת המפתח והרצת
  הנוהל הן תלויות Operations/Provider ולא הוכחו.
- נדרש מחבר תפעולי למקורות עסקאות חיצוניים. ledger ויתרה ששוחזרו יחד אינם
  הוכחה שלא אבדו עסקאות.
- sessions, Realtime ו־Signed URLs שכבר הונפקו אינם מתבטלים מיד בגלל flag ב־DB;
  ביטול/פקיעה שלהם הוא תנאי תפעולי נפרד לפני פתיחה.
- replay בלתי הפיך, restore rehearsal, Storage/Auth/DB חיים, עומס ו־RTO/RPO הם
  **NOT VERIFIED LIVE**. גיבויים ופקיעת מידע בהם נשארים מסלול נפרד.

### חיבור תצורה — 2026-11-12

ה־worker דורש כעת התאמה מפורשת של lock ID, authority ID וגרסת חוזה בנוסף
למפתח HMAC. הוא מחזיר למסך אדמין רק מצבי readiness ללא ערכי סוד. Import,
Release ו־Replay נשארים כבויים כברירת מחדל, ומילוי השדות אינו פותח מערכת,
אינו מחליף reconciliation ואינו מוכיח מקור authority חי. מקור חיצוני,
מקור עסקאות והפעלה חיה נשארים תלויות Operations/Provider.

### אימות Offline

בדיקות היחידה מכסות מצב חסר, lock חסר, ledger gap/unknown, deletion replay חסר,
מידע אישי לא מאומת ואישור ישן. בדיקת orchestration מכסה אימות envelope לפני
mutation, staging בלבד ושימור primary failure. בדיקת חוזה Offline מאמתת את
גבולות SQL/Edge/UI. pgTAP נכתב אך לא הורץ משום שלא הופעל DB.
