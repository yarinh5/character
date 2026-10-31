import type { ComponentType, ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Reply = { data: Record<string, unknown> | null; error: unknown };
const io = vi.hoisted(() => ({
  user: { id: "client-a", email: "a@example.test" } as { id: string; email: string } | null,
  read: vi.fn<(table: string, userId: string) => Promise<Reply>>(),
  write:
    vi.fn<(table: string, values: Record<string, unknown>, userId: string) => Promise<Reply>>(),
  rpc: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  avatarChange: null as ((url: string | null) => void) | null,
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: io.user, role: "client" }) }));
vi.mock("sonner", () => ({ toast: { success: io.success, error: io.error } }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: io.rpc,
    from: (table: string) => {
      let userId = "";
      let values: Record<string, unknown> | undefined;
      const execute = () =>
        values === undefined ? io.read(table, userId) : io.write(table, values, userId);
      const query = {
        select: () => query,
        update: (payload: Record<string, unknown>) => {
          values = payload;
          return query;
        },
        eq: (_column: string, value: string) => {
          userId = value;
          return query;
        },
        maybeSingle: () => execute(),
        then: (resolve: (value: Reply) => unknown, reject: (error: unknown) => unknown) =>
          Promise.resolve().then(execute).then(resolve, reject),
      };
      return query;
    },
  },
}));
vi.mock("@/components/common/AvatarUpload", () => ({
  AvatarUpload: ({ onChange }: { onChange: (url: string | null) => void }) => {
    io.avatarChange = onChange;
    return (
      <button type="button" onClick={() => onChange("demo-avatar.webp")}>
        עדכון תמונה לבדיקה
      </button>
    );
  },
}));
vi.mock("@/components/account/AccountSettingsShared", () => ({
  AccountSummaryCard: () => <div>סיכום חשבון</div>,
  AccountSecurityCard: () => <div>אבטחת חשבון</div>,
}));
vi.mock("@/components/account/NotificationSettingsCard", () => ({
  NotificationSettingsCard: () => <div>התראות</div>,
}));

import { Route } from "@/routes/app.profile";
const Page = (Route as unknown as { component: ComponentType }).component;

const profile = {
  display_name: "לקוח הדגמה",
  avatar_url: null,
  email: "a@example.test",
  status: "active",
};
const client = {
  interests: ["מוזיקה", "טיולים"],
  conversation_preferences: "שיחה רגועה",
  bio: "תיאור קיים של לקוח",
  relationship_status: "single",
  smoking_status: "never",
  age: 31,
  city_id: "city-a",
  date_of_birth: "1995-01-01",
  onboarding_step: 3,
  onboarding_completed_at: "2026-01-01",
  profile_image_urls: ["kept.webp"],
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
async function loaded() {
  return screen.findByLabelText("שם תצוגה");
}
function submit() {
  fireEvent.submit(screen.getByLabelText("שם תצוגה").closest("form")!);
}
function loadReply(table: string, userId: string): Reply {
  return {
    data:
      table === "profiles"
        ? { ...profile, display_name: userId === "client-b" ? "לקוח חדש" : profile.display_name }
        : table === "client_profiles"
          ? { ...client }
          : { balance: 20 },
    error: null,
  };
}
const scrollIntoView = HTMLElement.prototype.scrollIntoView;
beforeAll(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterAll(() => {
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
});
beforeEach(() => {
  io.user = { id: "client-a", email: "a@example.test" };
  io.read.mockReset().mockImplementation(async (table, userId) => loadReply(table, userId));
  io.write.mockReset().mockImplementation(async (_table, _values, userId) => ({
    data: { user_id: userId },
    error: null,
  }));
  io.rpc.mockReset();
  io.success.mockReset();
  io.error.mockReset();
  io.avatarChange = null;
});

describe("client profile editing", () => {
  it("loads existing fields and the three onboarding fields with the existing account UI", async () => {
    render(<Page />);
    expect(screen.getByRole("status", { name: "טוען פרופיל" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "שמירה" })).not.toBeInTheDocument();
    await loaded();
    expect(screen.getByLabelText("ספר/י על עצמך")).toHaveValue(client.bio);
    expect(screen.getByLabelText("ספר/י על עצמך")).toHaveAttribute("maxlength", "1000");
    expect(screen.getByRole("combobox", { name: "סטטוס זוגי" })).toHaveTextContent("רווק/ה");
    expect(screen.getByRole("combobox", { name: "עישון" })).toHaveTextContent("לא מעשנ/ת");
    expect(screen.getByText("אבטחת חשבון")).toBeInTheDocument();
    expect(screen.getByText("התראות")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "צפה בחבילות" })).toHaveAttribute(
      "href",
      "/app/packages",
    );
  });

  it("edits the existing onboarding options and sends only the allowed payloads for the signed-in user", async () => {
    render(<Page />);
    await loaded();
    fireEvent.change(screen.getByLabelText("ספר/י על עצמך"), {
      target: { value: "תיאור אישי מעודכן" },
    });
    fireEvent.keyDown(screen.getByRole("combobox", { name: "סטטוס זוגי" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "בזוגיות" }));
    fireEvent.keyDown(screen.getByRole("combobox", { name: "עישון" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "לפעמים" }));
    submit();
    await waitFor(() => expect(io.success).toHaveBeenCalledWith("נשמר"));
    expect(io.write).toHaveBeenCalledWith(
      "profiles",
      { display_name: profile.display_name, avatar_url: null },
      "client-a",
    );
    expect(io.write).toHaveBeenCalledWith(
      "client_profiles",
      {
        interests: client.interests,
        conversation_preferences: client.conversation_preferences,
        bio: "תיאור אישי מעודכן",
        relationship_status: "in_relationship",
        smoking_status: "sometimes",
      },
      "client-a",
    );
    expect(io.rpc).not.toHaveBeenCalled();
  });

  it.each([
    {
      bio: null,
      relationship_status: null,
      smoking_status: null,
      interests: null,
      conversation_preferences: null,
    },
    {
      bio: "  תיאור ישן  ",
      relationship_status: "legacy_relationship",
      smoking_status: "legacy_smoking",
      interests: ["ישן"],
      conversation_preferences: "  ישן  ",
    },
    {
      bio: "",
      relationship_status: "",
      smoking_status: "",
      interests: [],
      conversation_preferences: "",
    },
  ])("preserves untouched null/legacy values: %j", async (legacy) => {
    io.read.mockImplementation(async (table, userId) =>
      table === "client_profiles"
        ? { data: { ...client, ...legacy }, error: null }
        : loadReply(table, userId),
    );
    render(<Page />);
    await loaded();
    fireEvent.change(screen.getByLabelText("שם תצוגה"), { target: { value: "שם מעודכן" } });
    submit();
    await waitFor(() => expect(io.success).toHaveBeenCalled());
    expect(io.write).toHaveBeenCalledWith("client_profiles", legacy, "client-a");
  });

  it.each(["profiles", "client_profiles", "credit_wallets"])(
    "blocks saving after a %s read error and can retry",
    async (failedTable) => {
      io.read.mockImplementation(async (table, userId) =>
        table === failedTable
          ? { data: null, error: { message: "private raw server detail" } }
          : loadReply(table, userId),
      );
      render(<Page />);
      expect(await screen.findByRole("alert")).toHaveTextContent("לא ניתן לטעון את הפרופיל כרגע");
      expect(screen.queryByText(/private raw/)).not.toBeInTheDocument();
      expect(screen.queryByLabelText("שם תצוגה")).not.toBeInTheDocument();
      expect(io.write).not.toHaveBeenCalled();
      io.read.mockImplementation(async (table, userId) => loadReply(table, userId));
      fireEvent.click(screen.getByRole("button", { name: "נסה שוב" }));
      await loaded();
      expect(screen.getByRole("button", { name: "שמירה" })).toBeEnabled();
    },
  );

  it.each(["profiles", "client_profiles"])(
    "treats a missing required %s row as a read failure",
    async (missingTable) => {
      io.read.mockImplementation(async (table, userId) =>
        table === missingTable ? { data: null, error: null } : loadReply(table, userId),
      );
      render(<Page />);
      expect(await screen.findByRole("alert")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "שמירה" })).not.toBeInTheDocument();
    },
  );

  it("recovers from a thrown read without exposing a writable empty form", async () => {
    io.read.mockRejectedValue(new Error("private network failure"));
    render(<Page />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(io.write).not.toHaveBeenCalled();
  });

  it.each(["partial", "zero rows", "wrong row", "exception"])(
    "keeps input and unlocks save after %s without claiming success",
    async (failure) => {
      io.write.mockImplementation(async (table, _values, userId) => {
        if (table === "profiles") return { data: { user_id: userId }, error: null };
        if (failure === "exception") throw new Error("private write failure");
        return {
          data:
            failure === "zero rows"
              ? null
              : { user_id: failure === "wrong row" ? "someone-else" : userId },
          error: failure === "partial" ? { message: "raw failure" } : null,
        };
      });
      render(<Page />);
      await loaded();
      fireEvent.change(screen.getByLabelText("ספר/י על עצמך"), {
        target: { value: "קלט שלא יימחק" },
      });
      submit();
      await waitFor(() => expect(io.error).toHaveBeenCalled());
      expect(io.success).not.toHaveBeenCalled();
      expect(screen.getByLabelText("ספר/י על עצמך")).toHaveValue("קלט שלא יימחק");
      expect(screen.getByRole("button", { name: "שמירה" })).toBeEnabled();
    },
  );

  it("prevents duplicate submits and waits for both requests even if one rejects early", async () => {
    const delayed = deferred<Reply>();
    io.write.mockImplementation((table) =>
      table === "profiles" ? Promise.reject(new Error("failed")) : delayed.promise,
    );
    render(<Page />);
    await loaded();
    submit();
    submit();
    await waitFor(() => expect(io.write).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "שומר..." })).toBeDisabled();
    await act(async () => {
      delayed.resolve({ data: { user_id: "client-a" }, error: null });
    });
    expect(screen.getByRole("button", { name: "שמירה" })).toBeEnabled();
    expect(io.success).not.toHaveBeenCalled();
  });

  it("rejects newly entered bio longer than 1000 characters without truncating it", async () => {
    render(<Page />);
    await loaded();
    const value = "א".repeat(1001);
    fireEvent.change(screen.getByLabelText("ספר/י על עצמך"), { target: { value } });
    submit();
    expect(io.write).not.toHaveBeenCalled();
    expect(io.error).toHaveBeenCalledWith("התיאור יכול להכיל עד 1000 תווים");
    expect(screen.getByLabelText("ספר/י על עצמך")).toHaveValue(value);
  });

  it("preserves an untouched legacy bio beyond the current input limit", async () => {
    const bio = "א".repeat(1001);
    io.read.mockImplementation(async (table, userId) =>
      table === "client_profiles"
        ? { data: { ...client, bio }, error: null }
        : loadReply(table, userId),
    );
    render(<Page />);
    await loaded();
    submit();
    await waitFor(() => expect(io.success).toHaveBeenCalledWith("נשמר"));
    expect(io.write).toHaveBeenCalledWith(
      "client_profiles",
      expect.objectContaining({ bio }),
      "client-a",
    );
  });

  it("preserves the avatar update path and verifies the updated row", async () => {
    render(<Page />);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "עדכון תמונה לבדיקה" }));
    await waitFor(() =>
      expect(io.write).toHaveBeenCalledWith(
        "profiles",
        { avatar_url: "demo-avatar.webp" },
        "client-a",
      ),
    );
    await waitFor(() => expect(io.success).toHaveBeenCalledWith("תמונת הפרופיל עודכנה"));
  });

  it("persists an avatar completion that arrives while both profile writes are pending", async () => {
    const profileSave = deferred<Reply>();
    const clientSave = deferred<Reply>();
    io.write.mockImplementation((table, values) => {
      if ("avatar_url" in values && Object.keys(values).length === 1) {
        return Promise.resolve({ data: { user_id: "client-a" }, error: null });
      }
      return table === "profiles" ? profileSave.promise : clientSave.promise;
    });
    render(<Page />);
    await loaded();
    submit();
    await waitFor(() => expect(io.write).toHaveBeenCalledTimes(2));

    act(() => io.avatarChange?.("late-avatar.webp"));
    expect(io.write).toHaveBeenCalledTimes(2);

    await act(async () => {
      profileSave.resolve({ data: { user_id: "client-a" }, error: null });
      clientSave.resolve({ data: { user_id: "client-a" }, error: null });
    });

    await waitFor(() =>
      expect(io.write).toHaveBeenCalledWith(
        "profiles",
        { avatar_url: "late-avatar.webp" },
        "client-a",
      ),
    );
  });

  it("does not lose a pending avatar when the active form save partially fails", async () => {
    const profileSave = deferred<Reply>();
    const clientSave = deferred<Reply>();
    io.write.mockImplementation((table, values) => {
      if ("avatar_url" in values && Object.keys(values).length === 1) {
        return Promise.resolve({ data: { user_id: "client-a" }, error: null });
      }
      return table === "profiles" ? profileSave.promise : clientSave.promise;
    });
    render(<Page />);
    await loaded();
    submit();
    await waitFor(() => expect(io.write).toHaveBeenCalledTimes(2));
    act(() => io.avatarChange?.("kept-after-partial.webp"));

    await act(async () => {
      profileSave.resolve({ data: { user_id: "client-a" }, error: null });
      clientSave.resolve({ data: null, error: { message: "partial failure" } });
    });

    await waitFor(() =>
      expect(io.write).toHaveBeenCalledWith(
        "profiles",
        { avatar_url: "kept-after-partial.webp" },
        "client-a",
      ),
    );
    expect(io.error).toHaveBeenCalledWith("לא כל השינויים נשמרו. הקלט נשמר, אפשר לנסות שוב.");
  });

  it("treats a pending null avatar as a removal request", async () => {
    const profileSave = deferred<Reply>();
    const clientSave = deferred<Reply>();
    io.write.mockImplementation((table, values) => {
      if ("avatar_url" in values && Object.keys(values).length === 1) {
        return Promise.resolve({ data: { user_id: "client-a" }, error: null });
      }
      return table === "profiles" ? profileSave.promise : clientSave.promise;
    });
    render(<Page />);
    await loaded();
    submit();
    await waitFor(() => expect(io.write).toHaveBeenCalledTimes(2));
    act(() => io.avatarChange?.(null));

    await act(async () => {
      profileSave.resolve({ data: { user_id: "client-a" }, error: null });
      clientSave.resolve({ data: { user_id: "client-a" }, error: null });
    });

    await waitFor(() =>
      expect(io.write).toHaveBeenCalledWith("profiles", { avatar_url: null }, "client-a"),
    );
    expect(io.success).toHaveBeenCalledWith("תמונת הפרופיל הוסרה");
  });

  it("persists only the last avatar choice queued during an active save", async () => {
    const profileSave = deferred<Reply>();
    const clientSave = deferred<Reply>();
    io.write.mockImplementation((table, values) => {
      if ("avatar_url" in values && Object.keys(values).length === 1) {
        return Promise.resolve({ data: { user_id: "client-a" }, error: null });
      }
      return table === "profiles" ? profileSave.promise : clientSave.promise;
    });
    render(<Page />);
    await loaded();
    submit();
    await waitFor(() => expect(io.write).toHaveBeenCalledTimes(2));
    act(() => {
      io.avatarChange?.("first-pending.webp");
      io.avatarChange?.("last-pending.webp");
    });

    await act(async () => {
      profileSave.resolve({ data: { user_id: "client-a" }, error: null });
      clientSave.resolve({ data: { user_id: "client-a" }, error: null });
    });

    await waitFor(() =>
      expect(io.write).toHaveBeenCalledWith(
        "profiles",
        { avatar_url: "last-pending.webp" },
        "client-a",
      ),
    );
    expect(io.write).not.toHaveBeenCalledWith(
      "profiles",
      { avatar_url: "first-pending.webp" },
      "client-a",
    );
  });

  it.each(["switch", "logout"])(
    "cancels a queued avatar before processing after %s",
    async (change) => {
      const profileSave = deferred<Reply>();
      const clientSave = deferred<Reply>();
      io.write.mockImplementation((table) =>
        table === "profiles" ? profileSave.promise : clientSave.promise,
      );
      const view = render(<Page />);
      await loaded();
      submit();
      await waitFor(() => expect(io.write).toHaveBeenCalledTimes(2));
      act(() => io.avatarChange?.("stale-avatar.webp"));

      io.user = change === "logout" ? null : { id: "client-b", email: "b@example.test" };
      view.rerender(<Page />);
      if (change === "switch") await loaded();
      await act(async () => {
        profileSave.resolve({ data: { user_id: "client-a" }, error: null });
        clientSave.resolve({ data: { user_id: "client-a" }, error: null });
      });

      expect(io.write).not.toHaveBeenCalledWith(
        "profiles",
        { avatar_url: "stale-avatar.webp" },
        expect.any(String),
      );
      expect(io.success).not.toHaveBeenCalled();
      expect(io.error).not.toHaveBeenCalled();
    },
  );

  it("reports a queued avatar failure, unlocks, and retries only on request", async () => {
    const profileSave = deferred<Reply>();
    const clientSave = deferred<Reply>();
    let failAvatar = true;
    io.write.mockImplementation((table, values) => {
      if ("avatar_url" in values && Object.keys(values).length === 1) {
        return Promise.resolve(
          failAvatar
            ? { data: null, error: { message: "avatar failure" } }
            : { data: { user_id: "client-a" }, error: null },
        );
      }
      return table === "profiles" ? profileSave.promise : clientSave.promise;
    });
    render(<Page />);
    await loaded();
    submit();
    await waitFor(() => expect(io.write).toHaveBeenCalledTimes(2));
    act(() => io.avatarChange?.("retry-avatar.webp"));
    await act(async () => {
      profileSave.resolve({ data: { user_id: "client-a" }, error: null });
      clientSave.resolve({ data: { user_id: "client-a" }, error: null });
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("שמירת תמונת הפרופיל נכשלה");
    expect(io.error).toHaveBeenCalledWith("שמירת תמונת הפרופיל נכשלה");
    expect(io.success).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "שמירה" })).toBeEnabled();
    const retry = screen.getByRole("button", { name: "נסה לשמור שוב" });
    expect(retry).toBeEnabled();

    failAvatar = false;
    fireEvent.click(retry);
    await waitFor(() => expect(io.success).toHaveBeenCalledWith("תמונת הפרופיל עודכנה"));
    expect(io.write).toHaveBeenLastCalledWith(
      "profiles",
      { avatar_url: "retry-avatar.webp" },
      "client-a",
    );
  });

  it("does not let a late load replace a different user's form", async () => {
    const oldRead = deferred<Reply>();
    io.read.mockImplementation((table, userId) =>
      userId === "client-a" && table === "profiles"
        ? oldRead.promise
        : Promise.resolve(loadReply(table, userId)),
    );
    const view = render(<Page />);
    io.user = { id: "client-b", email: "b@example.test" };
    view.rerender(<Page />);
    expect(await loaded()).toHaveValue("לקוח חדש");
    await act(async () => {
      oldRead.resolve(loadReply("profiles", "client-a"));
    });
    expect(screen.getByLabelText("שם תצוגה")).toHaveValue("לקוח חדש");
  });

  it("ignores a late load after logout", async () => {
    const oldRead = deferred<Reply>();
    io.read.mockReturnValue(oldRead.promise);
    const view = render(<Page />);
    io.user = null;
    view.rerender(<Page />);
    await act(async () => {
      oldRead.resolve(loadReply("profiles", "client-a"));
    });
    expect(screen.queryByLabelText("שם תצוגה")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["switch", "logout"])("ignores late save responses after %s", async (change) => {
    const oldSave = deferred<Reply>();
    io.write.mockReturnValue(oldSave.promise);
    const view = render(<Page />);
    await loaded();
    submit();
    await waitFor(() => expect(io.write).toHaveBeenCalledTimes(2));
    io.user = change === "logout" ? null : { id: "client-b", email: "b@example.test" };
    view.rerender(<Page />);
    if (change === "switch") await loaded();
    await act(async () => {
      oldSave.resolve({ data: { user_id: "client-a" }, error: null });
    });
    expect(io.success).not.toHaveBeenCalled();
    expect(io.error).not.toHaveBeenCalled();
    if (change === "switch") expect(screen.getByLabelText("שם תצוגה")).toHaveValue("לקוח חדש");
    else expect(screen.queryByLabelText("שם תצוגה")).not.toBeInTheDocument();
  });
});
