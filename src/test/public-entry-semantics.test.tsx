import type { ComponentType, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  navigate: vi.fn(),
  rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useNavigate: () => io.navigate,
}));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: null, role: null, loading: false }),
  rolePath: () => "/",
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: io.rpc,
    auth: { signInWithPassword: vi.fn() },
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { Route as LandingRoute } from "@/routes/index";
import { Route as LoginRoute } from "@/routes/login";

const LandingPage = (LandingRoute as unknown as { component: ComponentType }).component;
const LoginPage = (LoginRoute as unknown as { component: ComponentType }).component;

function primaryGradientDeclarations() {
  const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
  const match = css.match(/\.bg-gradient-primary\s*\{([^}]*)\}/);
  expect(match, "the shared primary-gradient utility must exist").not.toBeNull();

  const style = document.createElement("div").style;
  style.cssText = match?.[1] ?? "";
  return style;
}

describe("public entry-page semantics", () => {
  it("keeps the hero gradient compatible with clipped transparent text", () => {
    render(<LandingPage />);

    const gradientText = screen.getByText("שמרגישות אמיתיות");
    expect(gradientText).toHaveClass("bg-gradient-primary", "bg-clip-text", "text-transparent");

    const gradient = primaryGradientDeclarations();
    expect(gradient.getPropertyValue("background-image")).toContain("var(--gradient-primary)");
    expect(gradient.getPropertyValue("background")).toBe("");
  });

  it("exposes a level-one login heading and stable autofill field identities", () => {
    render(<LoginPage />);

    expect(screen.getByRole("heading", { level: 1, name: "התחברות" })).toBeInTheDocument();
    expect(screen.getByLabelText("אימייל")).toHaveAttribute("name", "email");
    expect(screen.getByLabelText("אימייל")).toHaveAttribute("autocomplete", "email");
    expect(screen.getByLabelText("סיסמה")).toHaveAttribute("name", "password");
    expect(screen.getByLabelText("סיסמה")).toHaveAttribute("autocomplete", "current-password");
  });

  it("does not permit a native credential submission before hydration", () => {
    const markup = renderToStaticMarkup(<LoginPage />);
    const root = document.createElement("div");
    root.innerHTML = markup;

    expect(root.querySelector('input[name="email"]')).toBeDisabled();
    expect(root.querySelector('input[name="password"]')).toBeDisabled();
    expect(root.querySelector('button[type="submit"]')).toBeDisabled();
  });

  it("preserves mobile-sized entry controls on home and login", () => {
    render(<LandingPage />);
    for (const label of ["התחברות", "התחל עכשיו", "התחברות לחשבון קיים", "צור חשבון בחינם"]) {
      for (const link of screen.getAllByRole("link", { name: label })) {
        expect(link).toHaveClass("min-h-11");
      }
    }
    for (const label of ["תנאי שימוש", "מדיניות פרטיות", "הצהרת שירות"]) {
      expect(screen.getByRole("link", { name: label })).toHaveClass("min-h-11");
    }

    render(<LoginPage />);
    expect(screen.getByLabelText("אימייל")).toHaveClass("min-h-11");
    expect(screen.getByLabelText("סיסמה")).toHaveClass("min-h-11");
    expect(screen.getByRole("button", { name: "התחבר" })).toHaveClass("min-h-11");
    for (const label of ["שכחת סיסמה?", "הרשמה"]) {
      expect(screen.getByRole("link", { name: label })).toHaveClass("min-h-11");
    }
  });

  it.each([
    ["home", LandingPage],
    ["login", LoginPage],
  ])("provides a keyboard skip target on the %s page", (_name, Page) => {
    render(<Page />);
    expect(screen.getByRole("link", { name: "דלג לתוכן הראשי" })).toHaveAttribute(
      "href",
      "#main-content",
    );
    expect(document.getElementById("main-content")).toMatchObject({
      tagName: "MAIN",
      tabIndex: -1,
    });
  });

  it("connects the shared skip link to each protected workspace landmark", () => {
    for (const layout of ["client/ClientLayout", "operator/OperatorLayout", "admin/AdminLayout"]) {
      const source = readFileSync(resolve(process.cwd(), `src/components/${layout}.tsx`), "utf8");
      expect(source).toContain("<SkipLink />");
      expect(source).toMatch(/<main\s+id="main-content"\s+tabIndex=\{-1\}/);
    }
  });
});
