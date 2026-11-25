import { forwardRef, type AnchorHTMLAttributes, type ReactNode } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  navigate: vi.fn(),
  signOut: vi.fn(async () => undefined),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: forwardRef<
    HTMLAnchorElement,
    AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode }
  >(({ to, children, ...props }, ref) => (
    <a ref={ref} href={to} {...props}>
      {children}
    </a>
  )),
  useRouterState: ({
    select,
  }: {
    select: (state: { location: { pathname: string } }) => unknown;
  }) => select({ location: { pathname: "/app/characters" } }),
  useNavigate: () => io.navigate,
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ signOut: io.signOut }) }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { ClientLayout } from "@/components/client/ClientLayout";

describe("client mobile navigation", () => {
  it("keeps one row of primary destinations and exposes secondary actions in More", async () => {
    render(<ClientLayout>תוכן לקוח</ClientLayout>);
    const nav = screen.getByRole("navigation", { name: "ניווט לקוח במובייל" });
    expect(nav.firstElementChild).toHaveClass("grid-cols-5");
    expect(nav.firstElementChild?.children).toHaveLength(5);
    expect(within(nav).getAllByRole("link")).toHaveLength(4);
    expect(within(nav).getByRole("link", { name: "דמויות" })).toHaveAttribute(
      "href",
      "/app/characters",
    );
    await userEvent.click(within(nav).getByRole("button", { name: "עוד" }));
    expect(await screen.findByRole("menuitem", { name: "חבילות" })).toHaveAttribute(
      "href",
      "/app/packages",
    );
    expect(screen.getByRole("menuitem", { name: "תמיכה" })).toHaveAttribute("href", "/app/support");
    await userEvent.click(screen.getByRole("menuitem", { name: "יציאה" }));
    expect(io.signOut).toHaveBeenCalledTimes(1);
    expect(io.navigate).toHaveBeenCalledWith({ to: "/login" });
  });
});
