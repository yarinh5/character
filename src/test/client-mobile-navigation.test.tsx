import { forwardRef, type AnchorHTMLAttributes, type ReactNode } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  clientId: null as string | null,
  activity: vi.fn(),
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
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    signOut: io.signOut,
    role: io.clientId ? "client" : null,
    user: io.clientId ? { id: io.clientId } : null,
    session: io.clientId ? { user: { id: io.clientId } } : null,
  }),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: io.activity } }));

import { ClientLayout } from "@/components/client/ClientLayout";

beforeEach(() => {
  io.clientId = null;
  io.activity.mockReset().mockResolvedValue({ error: null });
});

describe("client mobile navigation", () => {
  it("reports only foreground client activity, retries no failed writes and stops on unmount", () => {
    io.clientId = "client-a";
    io.activity.mockResolvedValueOnce({ error: { code: "42501" } });
    const time = vi.spyOn(Date, "now").mockReturnValue(50_000);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try {
      const view = render(<ClientLayout>תוכן לקוח</ClientLayout>);
      expect(io.activity).not.toHaveBeenCalled();
      fireEvent.keyDown(document, { key: "Tab" });
      expect(io.activity).not.toHaveBeenCalled();
      visibility.mockReturnValue("visible");
      fireEvent.keyDown(document, { key: "Tab" });
      fireEvent.pointerDown(document);
      expect(io.activity).toHaveBeenCalledExactlyOnceWith("record_client_app_activity");
      time.mockReturnValue(95_000);
      expect(io.activity).toHaveBeenCalledTimes(1);
      fireEvent.pointerDown(document);
      expect(io.activity).toHaveBeenCalledTimes(2);
      view.unmount();
      time.mockReturnValue(141_000);
      fireEvent.keyDown(document, { key: "Tab" });
      expect(io.activity).toHaveBeenCalledTimes(2);
    } finally {
      time.mockRestore();
      visibility.mockRestore();
    }
  });

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
