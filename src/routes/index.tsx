import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import {
  MessageCircle, Sparkles, Users, Clock, Shield, Heart,
  ArrowLeft, Check
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { useAuth, rolePath } from "@/lib/auth";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Character Chat OS — שיחות אישיות עם דמויות שמרגישות אמיתיות" },
      { name: "description", content: "פלטפורמת SaaS לשיחות אישיות עם דמויות. בחרו דמות, התחילו שיחה והמשיכו את החוויה בכל זמן." },
    ],
  }),
  component: LandingPage,
});

function LandingPage() {
  const { user, role, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && user && role) {
      navigate({ to: rolePath(role) });
    }
  }, [user, role, loading, navigate]);

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <Hero />
      <HowItWorks />
      <Features />
      <FAQ />
      <CTA />
      <Footer />
    </div>
  );
}

function Header() {
  return (
    <header className="sticky top-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-lg">
      <div className="container mx-auto flex h-16 items-center justify-between px-4">
        <Link to="/" className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-primary shadow-soft">
            <MessageCircle className="h-5 w-5 text-primary-foreground" />
          </div>
          <span className="text-lg font-bold tracking-tight">Character Chat</span>
        </Link>
        <nav className="flex items-center gap-2">
          <Button variant="ghost" asChild>
            <Link to="/login">התחברות</Link>
          </Button>
          <Button asChild>
            <Link to="/register">התחל עכשיו</Link>
          </Button>
        </nav>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden bg-gradient-hero py-20 md:py-32">
      <div className="absolute inset-0 -z-10 opacity-30">
        <div className="absolute right-1/4 top-1/4 h-72 w-72 rounded-full bg-primary/30 blur-3xl" />
        <div className="absolute bottom-1/4 left-1/4 h-72 w-72 rounded-full bg-primary-glow/30 blur-3xl" />
      </div>
      <div className="container mx-auto px-4">
        <div className="mx-auto max-w-3xl text-center">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-border/60 bg-card/60 px-4 py-1.5 text-sm font-medium text-muted-foreground backdrop-blur">
            <Sparkles className="h-4 w-4 text-primary" />
            פלטפורמה חדשה לשיחות אישיות
          </div>
          <h1 className="text-4xl font-bold tracking-tight md:text-6xl">
            שיחות אישיות עם דמויות
            <span className="block bg-gradient-primary bg-clip-text text-transparent">
              שמרגישות אמיתיות
            </span>
          </h1>
          <p className="mt-6 text-lg text-muted-foreground md:text-xl">
            בחרו דמות, התחילו שיחה, והמשיכו את החוויה בכל זמן.
          </p>
          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button size="lg" asChild className="bg-gradient-primary shadow-elegant hover:shadow-glow transition-shadow text-base">
              <Link to="/register">
                התחל עכשיו
                <ArrowLeft className="mr-1 h-4 w-4" />
              </Link>
            </Button>
            <Button size="lg" variant="outline" asChild className="text-base">
              <Link to="/login">התחברות לחשבון קיים</Link>
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  const steps = [
    { n: "01", title: "נרשמים", desc: "צרו חשבון בחינם תוך דקה" },
    { n: "02", title: "בוחרים דמות", desc: "מתוך מגוון דמויות עם אישיות ייחודית" },
    { n: "03", title: "מתחילים שיחה", desc: "פתחו שיחה ושוחחו בקצב שלכם" },
    { n: "04", title: "ממשיכים בכל זמן", desc: "השיחה נשמרת ותמיד תוכלו לחזור אליה" },
  ];
  return (
    <section className="py-20">
      <div className="container mx-auto px-4">
        <div className="mx-auto mb-12 max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight md:text-4xl">איך זה עובד</h2>
          <p className="mt-3 text-muted-foreground">ארבעה צעדים פשוטים לחוויה אישית מלאה</p>
        </div>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {steps.map((s) => (
            <Card key={s.n} className="bg-gradient-card p-6 shadow-soft transition-all hover:shadow-elegant">
              <div className="mb-3 text-2xl font-bold text-primary/40">{s.n}</div>
              <h3 className="text-lg font-semibold">{s.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{s.desc}</p>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}

function Features() {
  const features = [
    { icon: Users, title: "מגוון דמויות", desc: "דמויות עם אישיויות וסגנונות שונים" },
    { icon: Clock, title: "זמינות 24/7", desc: "שיחות מתי שמתאים לכם, בכל שעה" },
    { icon: Shield, title: "פרטיות מלאה", desc: "השיחות שלכם פרטיות ומוגנות" },
    { icon: Heart, title: "חוויה אישית", desc: "שיחות שזורמות באופן טבעי וקצב משלכם" },
  ];
  return (
    <section className="bg-muted/30 py-20">
      <div className="container mx-auto px-4">
        <div className="mx-auto mb-12 max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight md:text-4xl">למה דווקא אצלנו</h2>
        </div>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {features.map((f) => (
            <div key={f.title} className="rounded-2xl bg-card p-6 shadow-soft">
              <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10">
                <f.icon className="h-5 w-5 text-primary" />
              </div>
              <h3 className="font-semibold">{f.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{f.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function FAQ() {
  const items = [
    { q: "האם השירות בתשלום?", a: "כרגע השירות בשלב בטא וניתן להתנסות בו ללא עלות." },
    { q: "האם השיחות שלי פרטיות?", a: "כן. הגישה לשיחות שלך מוגבלת לך בלבד, וצוות התמיכה רואה רק שיחות שדווחו." },
    { q: "מה גיל המינימום?", a: "השירות מיועד לבני 18 ומעלה." },
    { q: "האם אני יכול למחוק את החשבון שלי?", a: "כן, מתוך הגדרות הפרופיל." },
  ];
  return (
    <section className="py-20">
      <div className="container mx-auto px-4">
        <div className="mx-auto max-w-2xl">
          <h2 className="mb-8 text-center text-3xl font-bold tracking-tight md:text-4xl">שאלות נפוצות</h2>
          <Accordion type="single" collapsible className="rounded-2xl bg-card shadow-soft">
            {items.map((item, i) => (
              <AccordionItem key={i} value={`item-${i}`} className="px-6">
                <AccordionTrigger className="text-right">{item.q}</AccordionTrigger>
                <AccordionContent className="text-muted-foreground">{item.a}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </div>
    </section>
  );
}

function CTA() {
  return (
    <section className="py-20">
      <div className="container mx-auto px-4">
        <div className="mx-auto max-w-3xl rounded-3xl bg-gradient-primary p-10 text-center shadow-elegant md:p-16">
          <h2 className="text-3xl font-bold tracking-tight text-primary-foreground md:text-4xl">
            מוכנים להתחיל?
          </h2>
          <p className="mt-3 text-primary-foreground/80">
            יצירת חשבון לוקחת פחות מדקה
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button size="lg" variant="secondary" asChild>
              <Link to="/register">צור חשבון בחינם</Link>
            </Button>
          </div>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-4 text-sm text-primary-foreground/80">
            <span className="inline-flex items-center gap-1.5"><Check className="h-4 w-4" /> ללא כרטיס אשראי</span>
            <span className="inline-flex items-center gap-1.5"><Check className="h-4 w-4" /> ביטול בכל עת</span>
          </div>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-border/50 py-10">
      <div className="container mx-auto flex flex-col items-center justify-between gap-4 px-4 text-sm text-muted-foreground md:flex-row">
        <p>© {new Date().getFullYear()} Character Chat OS</p>
        <nav className="flex flex-wrap items-center gap-4">
          <Link to="/terms" className="hover:text-foreground">תנאי שימוש</Link>
          <Link to="/privacy" className="hover:text-foreground">מדיניות פרטיות</Link>
          <Link to="/service" className="hover:text-foreground">הצהרת שירות</Link>
        </nav>
      </div>
    </footer>
  );
}
