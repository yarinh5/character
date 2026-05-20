import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/terms")({
  head: () => ({ meta: [{ title: "תנאי שימוש" }] }),
  component: () => <LegalPage title="תנאי שימוש" />,
});

export function LegalPage({ title }: { title: string }) {
  return (
    <div className="min-h-screen bg-background py-16">
      <div className="container mx-auto max-w-3xl px-4">
        <Link to="/" className="text-sm text-primary hover:underline">→ חזרה לדף הבית</Link>
        <h1 className="mt-6 text-4xl font-bold">{title}</h1>
        <div className="mt-4 rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm text-warning-foreground">
          התוכן בעמוד זה אינו ייעוץ משפטי ויש להתאים אותו מול עורך דין לפני עלייה לאוויר.
        </div>
        <div className="prose prose-neutral mt-8 max-w-none text-muted-foreground">
          <p>זהו עמוד placeholder. כאן יוצב הנוסח המלא לאחר אישור משפטי.</p>
          <h2 className="mt-6 text-xl font-semibold text-foreground">כללי</h2>
          <p>השימוש בשירות מותנה בקבלת תנאים אלה במלואם. השירות מיועד לבני 18 ומעלה.</p>
          <h2 className="mt-6 text-xl font-semibold text-foreground">תוכן ושיחות</h2>
          <p>כל השיחות מתבצעות בין משתמשים לבין דמויות פיקטיביות שמופעלות ע"י נציגים אנושיים. אין להתייחס לתוכן כייעוץ מקצועי.</p>
          <h2 className="mt-6 text-xl font-semibold text-foreground">פרטיות</h2>
          <p>ראו את <Link to="/privacy" className="text-primary hover:underline">מדיניות הפרטיות</Link>.</p>
        </div>
      </div>
    </div>
  );
}
