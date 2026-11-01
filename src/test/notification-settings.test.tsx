import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Role = "client" | "operator" | "admin";
type Settings = {
  user_id: string;
  in_app_enabled: boolean;
  email_enabled: boolean;
  new_message_enabled: boolean;
  new_report_enabled: boolean;
  credits_enabled: boolean;
  assignment_enabled: boolean;
  lock_enabled: boolean;
  system_enabled: boolean;
};
type Reply<T> = { data: T; error: unknown };

const io = vi.hoisted(() => ({
  auth: {
    loading: false,
    userId: "user-a" as string | null,
    sessionUserId: "user-a" as string | null,
    role: "client" as Role | null,
    users: {} as Record<string, { id: string }>,
    sessions: {} as Record<string, { user: { id: string } }>,
  },
  readSettings: vi.fn(),
  writeSettings: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    loading: io.auth.loading,
    user: io.auth.userId ? (io.auth.users[io.auth.userId] ??= { id: io.auth.userId }) : null,
    session: io.auth.sessionUserId
      ? (io.auth.sessions[io.auth.sessionUserId] ??= {
          user: { id: io.auth.sessionUserId },
        })
      : null,
    role: io.auth.role,
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: io.toastSuccess, error: io.toastError },
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      if (table !== "notification_settings") throw new Error(`Unexpected table: ${table}`);
      let operation: "read" | "write" = "read";
      let payload: Record<string, unknown> = {};
      let userId = "";
      let executed: Promise<Reply<Settings | null>> | null = null;
      const execute = () => {
        if (!executed) {
          executed = Promise.resolve().then(() =>
            operation === "read"
              ? io.readSettings(userId)
              : io.writeSettings({ payload, onConflict: "user_id" }),
          );
        }
        return executed;
      };
      const query = {
        select: vi.fn(() => query),
        eq: vi.fn((column: string, value: string) => {
          if (column === "user_id") userId = value;
          return query;
        }),
        maybeSingle: vi.fn(() => execute()),
        single: vi.fn(() => execute()),
        upsert: vi.fn((values: Record<string, unknown>) => {
          operation = "write";
          payload = values;
          return query;
        }),
        then: (
          resolve: (value: Reply<Settings | null>) => unknown,
          reject: (reason: unknown) => unknown,
        ) => execute().then(resolve, reject),
      };
      return query;
    },
  },
}));

import { NotificationSettingsCard } from "@/components/account/NotificationSettingsCard";

const settingsA: Settings = {
  user_id: "user-a",
  in_app_enabled: true,
  email_enabled: false,
  new_message_enabled: true,
  new_report_enabled: true,
  credits_enabled: true,
  assignment_enabled: true,
  lock_enabled: true,
  system_enabled: true,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  io.auth.loading = false;
  io.auth.userId = "user-a";
  io.auth.sessionUserId = "user-a";
  io.auth.role = "client";
  io.readSettings.mockReset().mockResolvedValue({ data: settingsA, error: null });
  io.writeSettings
    .mockReset()
    .mockImplementation(({ payload }: { payload: Record<string, unknown> }) =>
      Promise.resolve({
        data: { ...settingsA, ...payload },
        error: null,
      }),
    );
  io.toastSuccess.mockReset();
  io.toastError.mockReset();
});

describe("NotificationSettingsCard", () => {
  it("waits for initialized matching auth and rejects a missing or mismatched role without admin fallback", async () => {
    io.auth.loading = true;
    const view = render(<NotificationSettingsCard role="client" />);
    expect(io.readSettings).not.toHaveBeenCalled();

    io.auth.loading = false;
    io.auth.sessionUserId = "other-user";
    view.rerender(<NotificationSettingsCard role="client" />);
    expect(io.readSettings).not.toHaveBeenCalled();

    io.auth.sessionUserId = "user-a";
    io.auth.role = null;
    view.rerender(<NotificationSettingsCard role={null} />);
    expect(screen.getByRole("status")).toHaveTextContent("נדרש חיבור מאומת");
    expect(screen.queryByText("דיווחים חדשים")).not.toBeInTheDocument();
    expect(io.readSettings).not.toHaveBeenCalled();

    io.auth.role = "operator";
    view.rerender(<NotificationSettingsCard role="admin" />);
    expect(screen.queryByText("דיווחים חדשים")).not.toBeInTheDocument();
    expect(io.readSettings).not.toHaveBeenCalled();
  });

  it("blocks switches after a read error and retries before exposing verified settings", async () => {
    io.readSettings
      .mockResolvedValueOnce({ data: null, error: { message: "offline" } })
      .mockResolvedValueOnce({ data: settingsA, error: null });
    render(<NotificationSettingsCard role="client" />);

    expect(await screen.findByRole("alert")).toHaveTextContent("טעינת הגדרות ההתראות נכשלה");
    expect(screen.queryByRole("switch", { name: "התראות בתוך המערכת" })).not.toBeInTheDocument();
    expect(io.writeSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "נסה שוב" }));
    expect(await screen.findByRole("switch", { name: "התראות בתוך המערכת" })).toBeEnabled();
  });

  it("separates an unavailable table from a confirmed missing row and never auto-upserts defaults", async () => {
    io.readSettings
      .mockResolvedValueOnce({
        data: null,
        error: { code: "42P01", message: "relation does not exist" },
      })
      .mockResolvedValueOnce({ data: null, error: null });
    render(<NotificationSettingsCard role="client" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("הגדרות ההתראות אינן זמינות כרגע");
    expect(screen.queryByText(/migration|SQL|Supabase/i)).not.toBeInTheDocument();
    expect(io.writeSettings).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "נסה שוב" }));
    expect(await screen.findByRole("switch", { name: "התראות בתוך המערכת" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "קרדיטים" })).toBeChecked();
    expect(io.writeSettings).not.toHaveBeenCalled();
  });

  it.each([
    ["client", "קרדיטים", "דיווחים חדשים"],
    ["operator", "שיוכים לדמויות", "דיווחים חדשים"],
    ["admin", "דיווחים חדשים", "קרדיטים"],
  ] as const)("uses only the approved %s option mapping", async (role, visible, hidden) => {
    io.auth.role = role;
    render(<NotificationSettingsCard role={role} />);
    expect(await screen.findByText(visible)).toBeInTheDocument();
    expect(screen.queryByText(hidden)).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "התראות אימייל" })).toBeDisabled();
  });

  it("writes only the explicitly changed field and adopts the verified returned row", async () => {
    io.writeSettings.mockResolvedValue({
      data: { ...settingsA, in_app_enabled: false, credits_enabled: false },
      error: null,
    });
    render(<NotificationSettingsCard role="client" />);
    const master = await screen.findByRole("switch", { name: "התראות בתוך המערכת" });
    fireEvent.click(master);

    await waitFor(() => expect(io.writeSettings).toHaveBeenCalledTimes(1));
    const { payload } = io.writeSettings.mock.calls[0][0] as { payload: Record<string, unknown> };
    expect(payload).toMatchObject({ user_id: "user-a", in_app_enabled: false });
    expect(Object.keys(payload).sort()).toEqual(["in_app_enabled", "updated_at", "user_id"]);
    expect(await screen.findByRole("switch", { name: "קרדיטים" })).not.toBeChecked();
    expect(io.toastSuccess).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["returned error", () => Promise.resolve({ data: null, error: { message: "denied" } })],
    ["rejection", () => Promise.reject(new Error("network"))],
    ["malformed row", () => Promise.resolve({ data: null, error: null })],
    [
      "wrong identity",
      () => Promise.resolve({ data: { ...settingsA, user_id: "other-user" }, error: null }),
    ],
  ])("rolls back and offers read-only recovery after %s", async (_label, result) => {
    io.writeSettings.mockImplementation(result);
    render(<NotificationSettingsCard role="client" />);
    const credits = await screen.findByRole("switch", { name: "קרדיטים" });
    fireEvent.click(credits);

    expect(await screen.findByRole("alert")).toHaveTextContent("שמירת הגדרות ההתראות נכשלה");
    expect(screen.getByRole("switch", { name: "קרדיטים" })).toBeChecked();
    expect(screen.getByRole("button", { name: "טען מחדש" })).toBeEnabled();
    expect(io.toastSuccess).not.toHaveBeenCalled();
    expect(io.toastError).toHaveBeenCalledTimes(1);
    expect(io.writeSettings).toHaveBeenCalledTimes(1);
  });

  it("guards two same-tick toggles and releases the interface after a failed save", async () => {
    const pending = deferred<Reply<Settings | null>>();
    io.writeSettings.mockReturnValue(pending.promise);
    render(<NotificationSettingsCard role="client" />);
    const credits = await screen.findByRole("switch", { name: "קרדיטים" });
    const system = screen.getByRole("switch", { name: "מערכת" });
    fireEvent.click(credits);
    fireEvent.click(system);
    await waitFor(() => expect(io.writeSettings).toHaveBeenCalledTimes(1));
    expect(system).toBeDisabled();

    await act(async () => pending.resolve({ data: null, error: { message: "failed" } }));
    expect(await screen.findByRole("button", { name: "טען מחדש" })).toBeEnabled();
  });

  it("hides A during a session mismatch and ignores its late save and toast after B takes over", async () => {
    const lateA = deferred<Reply<Settings | null>>();
    io.writeSettings.mockReturnValueOnce(lateA.promise);
    const view = render(<NotificationSettingsCard role="client" />);
    fireEvent.click(await screen.findByRole("switch", { name: "קרדיטים" }));

    io.auth.sessionUserId = "other-user";
    view.rerender(<NotificationSettingsCard role="client" />);
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    await act(async () =>
      lateA.resolve({ data: { ...settingsA, credits_enabled: false }, error: null }),
    );
    expect(io.toastSuccess).not.toHaveBeenCalled();
    expect(io.toastError).not.toHaveBeenCalled();

    io.auth.userId = "user-b";
    io.auth.sessionUserId = "user-b";
    io.readSettings.mockResolvedValueOnce({
      data: { ...settingsA, user_id: "user-b", credits_enabled: true },
      error: null,
    });
    view.rerender(<NotificationSettingsCard role="client" />);
    expect(await screen.findByRole("switch", { name: "קרדיטים" })).toBeChecked();
    expect(io.readSettings).toHaveBeenLastCalledWith("user-b");
  });

  it("filters the obsolete StrictMode read for the same identity", async () => {
    const obsolete = deferred<Reply<Settings | null>>();
    const current = deferred<Reply<Settings | null>>();
    io.readSettings.mockReturnValueOnce(obsolete.promise).mockReturnValueOnce(current.promise);
    render(
      <StrictMode>
        <NotificationSettingsCard role="client" />
      </StrictMode>,
    );
    await waitFor(() => expect(io.readSettings).toHaveBeenCalledTimes(2));
    await act(async () =>
      current.resolve({ data: { ...settingsA, credits_enabled: false }, error: null }),
    );
    expect(await screen.findByRole("switch", { name: "קרדיטים" })).not.toBeChecked();
    await act(async () => obsolete.resolve({ data: settingsA, error: null }));
    expect(screen.getByRole("switch", { name: "קרדיטים" })).not.toBeChecked();
  });
});
