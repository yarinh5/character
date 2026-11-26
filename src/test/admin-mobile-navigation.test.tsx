import type { AnchorHTMLAttributes, ReactNode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const route = vi.hoisted(() => ({ pathname: "/admin/users" }));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    children,
    onClick,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a
      href={to}
      onClick={(event) => {
        event.preventDefault();
        onClick?.(event);
      }}
      {...props}
    >
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => string }) =>
    select({ location: { pathname: route.pathname } }),
}));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    loading: false,
    session: { access_token: "local-test" },
    role: "admin",
    user: { email: "admin@example.invalid" },
    signOut: vi.fn(),
  }),
}));
vi.mock("@/components/common/NotificationBell", () => ({ NotificationBell: () => null }));
vi.mock("@/components/common/ImpersonationBanner", () => ({ ImpersonationBanner: () => null }));

import { RequireAdmin } from "@/components/admin/AdminLayout";

function mount(children: ReactNode = <div>תוכן</div>) {
  return render(<RequireAdmin>{children}</RequireAdmin>);
}

beforeEach(() => {
  route.pathname = "/admin/users";
});

describe("admin mobile navigation", () => {
  it("keeps four primary destinations visible and exposes every other destination in More", async () => {
    mount();

    const mobile = screen.getByRole("navigation", { name: "ניווט ניהול במובייל" });
    expect(within(mobile).getAllByRole("link")).toHaveLength(4);
    expect(within(mobile).getByRole("link", { name: "משתמשים" })).toHaveAttribute(
      "href",
      "/admin/users",
    );

    fireEvent.click(within(mobile).getByRole("button", { name: "עוד יעדים" }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getAllByRole("link")).toHaveLength(11);
    expect(within(sheet).getByRole("link", { name: "תמיכה ואירועים" })).toHaveAttribute(
      "href",
      "/admin/support",
    );

    fireEvent.click(within(sheet).getByRole("link", { name: "תמיכה ואירועים" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("identifies the selected destination when it is in More", () => {
    route.pathname = "/admin/support";
    mount();

    const mobile = screen.getByRole("navigation", { name: "ניווט ניהול במובייל" });
    expect(
      within(mobile).getByRole("button", { name: "עוד יעדים, נבחר תמיכה ואירועים" }),
    ).toHaveAttribute("data-active", "true");
  });
});
