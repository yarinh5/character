import type { ComponentType, ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Reply = {
  data: Record<string, unknown> | Array<Record<string, unknown>> | null;
  error: unknown;
};
const io = vi.hoisted(() => ({
  user: { id: "client-a", email: "a@example.test" } as { id: string; email: string } | null,
  read: vi.fn<(table: string, selector: string) => Promise<Reply>>(),
  write:
    vi.fn<(table: string, values: Record<string, unknown>, userId: string) => Promise<Reply>>(),
  rpc: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  avatarChange: null as ((images: string[], primary: string | null) => void) | null,
  savedClient: {} as Record<string, unknown>,
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
        eq: (_column: string, value: string | boolean) => {
          userId = String(value);
          return query;
        },
        order: () => execute(),
        maybeSingle: () => execute(),
        then: (resolve: (value: Reply) => unknown, reject: (error: unknown) => unknown) =>
          Promise.resolve().then(execute).then(resolve, reject),
      };
      return query;
    },
  },
}));
vi.mock("@/components/profile/ProfileImageManager", () => ({
  ProfileImageManager: ({
    onChange,
    images,
  }: {
    onChange: (images: string[], primary: string | null) => void;
    images: string[];
  }) => {
    io.avatarChange = onChange;
    return (
      <button
        type="button"
        onClick={() => onChange(["demo-avatar.webp", ...images], "demo-avatar.webp")}
      >
        עדכון תמונה לבדיקה
      </button>
    );
  },
}));
vi.mock("@/components/account/AccountSettingsShared", () => ({
  AccountSummaryCard: () => <div>סיכום חשבון</div>,
  AccountSecurityCard: () => <div>אבטחת חשבון</div>,
  ClientLevelCard: () => <div>רמת לקוח</div>,
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
  profile_image_url: null,
  profile_image_urls: ["kept.webp"],
  first_name: "לקוח",
  last_name: "הדגמה",
  computed_age: 31,
  preferred_min_age: 25,
  preferred_max_age: 40,
  preferred_distance_km: 50,
  content_preferences: ["casual_chat"],
  character_preferences: ["female"],
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
          : table === "discovery_cities"
            ? [
                { id: "city-a", display_name_he: "תל אביב" },
                { id: "city-b", display_name_he: "חיפה" },
              ]
            : { balance: 20 },
    error: null,
  };
}
function successfulWrite(table: string, values: Record<string, unknown>, userId: string): Reply {
  if (table === "client_profiles" && userId === io.user?.id) {
    Object.assign(io.savedClient, values);
  }
  return { data: { user_id: userId }, error: null };
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
  io.savedClient = { ...client };
  io.read.mockReset().mockImplementation(async (table, userId) => loadReply(table, userId));
  io.write
    .mockReset()
    .mockImplementation(async (table, values, userId) => successfulWrite(table, values, userId));
  io.rpc.mockReset().mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (name === "save_client_onboarding_step") {
      const payload = args._payload as {
        date_of_birth: string;
        profile_image_url: string | null;
        profile_image_urls: string[];
      };
      const dateOfBirth = payload.date_of_birth;
      Object.assign(io.savedClient, {
        date_of_birth: dateOfBirth,
        computed_age: new Date().getUTCFullYear() - Number(dateOfBirth.slice(0, 4)),
        age: new Date().getUTCFullYear() - Number(dateOfBirth.slice(0, 4)),
        profile_image_url: payload.profile_image_url,
        profile_image_urls:
          payload.profile_image_urls ??
          (payload.profile_image_url
            ? [payload.profile_image_url]
            : io.savedClient.profile_image_urls),
      });
      return { data: { onboarding_step: 3 }, error: null };
    }
    if (name !== "update_client_profile_images") throw new Error(`Unexpected RPC: ${name}`);
    return {
      data: [
        {
          profile_image_url: args._profile_image_url,
          profile_image_urls: args._profile_image_urls,
        },
      ],
      error: null,
    };
  });
  io.success.mockReset();
  io.error.mockReset();
  io.avatarChange = null;
});
afterEach(() => {
  for (const [table, values] of io.write.mock.calls) {
    if (table === "client_profiles") {
      expect(values).not.toHaveProperty("date_of_birth");
      expect(values).not.toHaveProperty("computed_age");
      expect(values).not.toHaveProperty("age");
    }
  }
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
    expect(screen.getByLabelText("שם פרטי")).toHaveValue("לקוח");
    expect(screen.getByLabelText("שם משפחה")).toHaveValue("הדגמה");
    expect(screen.getByLabelText("תאריך לידה")).toHaveValue("1995-01-01");
    expect(screen.getByRole("combobox", { name: "עיר" })).toHaveTextContent("תל אביב");
    expect(screen.getByLabelText("גיל מינימלי מועדף")).toHaveValue(25);
    expect(screen.getByLabelText("גיל מקסימלי מועדף")).toHaveValue(40);
    expect(screen.getByLabelText("מרחק מרבי בקילומטרים")).toHaveValue(50);
    expect(screen.getByRole("checkbox", { name: "שיחות קלילות" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "דמויות נשיות" })).toBeChecked();
    expect(screen.getByText("אבטחת חשבון")).toBeInTheDocument();
    expect(screen.getByText("התראות")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "צפה בחבילות" })).toHaveAttribute(
      "href",
      "/app/packages",
    );
  });

  it("updates the approved profile and discovery preferences without changing identity", async () => {
    render(<Page />);
    await loaded();
    const dateOfBirth = `${new Date().getUTCFullYear() - 36}-01-01`;

    fireEvent.change(screen.getByLabelText("שם פרטי"), { target: { value: "נועה" } });
    fireEvent.change(screen.getByLabelText("שם משפחה"), { target: { value: "כהן" } });
    fireEvent.change(screen.getByLabelText("תאריך לידה"), { target: { value: dateOfBirth } });
    fireEvent.keyDown(screen.getByRole("combobox", { name: "עיר" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "חיפה" }));
    fireEvent.change(screen.getByLabelText("גיל מינימלי מועדף"), { target: { value: "30" } });
    fireEvent.change(screen.getByLabelText("גיל מקסימלי מועדף"), { target: { value: "45" } });
    fireEvent.change(screen.getByLabelText("מרחק מרבי בקילומטרים"), {
      target: { value: "75" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "רומנטיקה" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "דמויות גבריות" }));
    submit();

    await waitFor(() => expect(io.success).toHaveBeenCalledWith("נשמר"));
    expect(io.write).toHaveBeenCalledWith(
      "client_profiles",
      expect.objectContaining({
        first_name: "נועה",
        last_name: "כהן",
        city_id: "city-b",
        preferred_min_age: 30,
        preferred_max_age: 45,
        preferred_distance_km: 75,
        content_preferences: ["casual_chat", "romance"],
        character_preferences: ["female", "male"],
      }),
      "client-a",
    );
    expect(io.rpc).toHaveBeenCalledWith("save_client_onboarding_step", {
      _payload: {
        date_of_birth: dateOfBirth,
        profile_image_url: client.profile_image_url,
        profile_image_urls: client.profile_image_urls,
      },
    });
    expect(io.rpc.mock.invocationCallOrder[0]).toBeLessThan(io.write.mock.invocationCallOrder[0]);
  });

  it("preserves the confirmed image order and primary during a DOB-only save", async () => {
    const imageProfile = {
      ...client,
      profile_image_url: "primary.webp",
      profile_image_urls: ["second.webp", "primary.webp"],
    };
    io.savedClient = { ...imageProfile };
    io.read.mockImplementation(async (table, userId) =>
      table === "client_profiles"
        ? { data: { ...imageProfile }, error: null }
        : loadReply(table, userId),
    );
    render(<Page />);
    await loaded();
    fireEvent.change(screen.getByLabelText("תאריך לידה"), {
      target: { value: "1990-01-01" },
    });
    submit();

    await waitFor(() => expect(io.success).toHaveBeenCalledWith("נשמר"));
    expect(io.rpc).toHaveBeenCalledTimes(1);
    expect(io.rpc).toHaveBeenCalledWith("save_client_onboarding_step", {
      _payload: {
        date_of_birth: "1990-01-01",
        profile_image_url: "primary.webp",
        profile_image_urls: ["second.webp", "primary.webp"],
      },
    });
    expect(io.savedClient).toMatchObject({
      profile_image_url: "primary.webp",
      profile_image_urls: ["second.webp", "primary.webp"],
    });
    const clientWrites = io.write.mock.calls.filter(([table]) => table === "client_profiles");
    expect(clientWrites).toHaveLength(1);
    expect(clientWrites[0]?.[1]).not.toHaveProperty("profile_image_url");
    expect(clientWrites[0]?.[1]).not.toHaveProperty("profile_image_urls");
  });

  it("saves a queued avatar after a DOB RPC without sending it as confirmed image state", async () => {
    const dobSave = deferred<Reply>();
    io.rpc.mockImplementation((name: string, args: Record<string, unknown>) =>
      name === "save_client_onboarding_step"
        ? dobSave.promise
        : Promise.resolve({
            data: [
              {
                profile_image_url: args._profile_image_url,
                profile_image_urls: args._profile_image_urls,
              },
            ],
            error: null,
          }),
    );
    render(<Page />);
    await loaded();
    fireEvent.change(screen.getByLabelText("תאריך לידה"), {
      target: { value: "1990-01-01" },
    });
    submit();
    await waitFor(() => expect(io.rpc).toHaveBeenCalledTimes(1));
    act(() => io.avatarChange?.(["new.webp", "kept.webp"], "new.webp"));
    expect(io.rpc).toHaveBeenCalledTimes(1);
    expect(io.rpc).toHaveBeenNthCalledWith(1, "save_client_onboarding_step", {
      _payload: {
        date_of_birth: "1990-01-01",
        profile_image_url: null,
        profile_image_urls: ["kept.webp"],
      },
    });

    await act(async () => {
      dobSave.resolve({ data: { onboarding_step: 3 }, error: null });
    });
    await waitFor(() => expect(io.rpc).toHaveBeenCalledTimes(2));
    expect(io.rpc).toHaveBeenNthCalledWith(2, "update_client_profile_images", {
      _profile_image_url: "new.webp",
      _profile_image_urls: ["new.webp", "kept.webp"],
    });
    expect(io.success).toHaveBeenCalledWith("נשמר");
  });

  it("does not start ordinary writes when the DOB RPC fails, then retries the DOB", async () => {
    const dateOfBirth = "1990-01-01";
    let failOnce = true;
    io.rpc.mockImplementation(async (name: string) => {
      expect(name).toBe("save_client_onboarding_step");
      if (failOnce) {
        failOnce = false;
        return { data: null, error: { message: "invalid_onboarding_age" } };
      }
      io.savedClient.date_of_birth = dateOfBirth;
      return { data: { onboarding_step: 3 }, error: null };
    });
    render(<Page />);
    await loaded();
    fireEvent.change(screen.getByLabelText("תאריך לידה"), { target: { value: dateOfBirth } });
    submit();
    await waitFor(() => expect(io.error).toHaveBeenCalled());
    expect(io.write).not.toHaveBeenCalled();
    expect(io.savedClient.date_of_birth).toBe(client.date_of_birth);
    expect(screen.getByLabelText("תאריך לידה")).toHaveValue(dateOfBirth);

    submit();
    await waitFor(() => expect(io.success).toHaveBeenCalledWith("נשמר"));
    expect(io.rpc).toHaveBeenCalledTimes(2);
    expect(io.savedClient.date_of_birth).toBe(dateOfBirth);
    expect(io.write).toHaveBeenCalledTimes(2);
  });

  it("keeps the confirmed DOB after a partial direct save and restores a custom display name", async () => {
    const dateOfBirth = "1990-01-01";
    let failClientOnce = true;
    io.write.mockImplementation(async (table, values, userId) => {
      if (table === "client_profiles" && failClientOnce) {
        failClientOnce = false;
        return { data: null, error: { message: "client write failed" } };
      }
      return successfulWrite(table, values, userId);
    });
    render(<Page />);
    await loaded();
    fireEvent.change(screen.getByLabelText("שם תצוגה"), { target: { value: "שם מיוחד" } });
    fireEvent.change(screen.getByLabelText("תאריך לידה"), { target: { value: dateOfBirth } });
    fireEvent.change(screen.getByLabelText("שם פרטי"), { target: { value: "נועה" } });
    submit();
    await waitFor(() => expect(io.error).toHaveBeenCalled());
    expect(io.savedClient.date_of_birth).toBe(dateOfBirth);
    expect(io.savedClient.first_name).toBe(client.first_name);

    submit();
    await waitFor(() => expect(io.success).toHaveBeenCalledWith("נשמר"));
    expect(io.rpc).toHaveBeenCalledTimes(1);
    expect(io.write).toHaveBeenCalledWith("profiles", { display_name: "שם מיוחד" }, "client-a");
    expect(io.rpc.mock.invocationCallOrder[0]).toBeLessThan(io.write.mock.invocationCallOrder[0]);
    expect(io.savedClient).toMatchObject({ date_of_birth: dateOfBirth, first_name: "נועה" });
  });

  it.each([
    ["גיל מינימלי מועדף", "17", "יש להזין טווח גילאים תקין"],
    ["גיל מקסימלי מועדף", "121", "יש להזין טווח גילאים תקין"],
    ["מרחק מרבי בקילומטרים", "0", "יש להזין מרחק חיפוש תקין"],
  ])("rejects invalid changed preference %s", async (label, value, message) => {
    render(<Page />);
    await loaded();
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
    submit();
    expect(io.write).not.toHaveBeenCalled();
    expect(io.error).toHaveBeenCalledWith(message);
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
      { display_name: profile.display_name },
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

  it("uses the last confirmed client values for A to B to A conditional payloads", async () => {
    render(<Page />);
    await loaded();
    const originalBirthYear = new Date(client.date_of_birth).getUTCFullYear();
    const changedDate = `${originalBirthYear - 1}-01-01`;

    fireEvent.change(screen.getByLabelText("שם פרטי"), { target: { value: "נועה" } });
    fireEvent.change(screen.getByLabelText("שם משפחה"), { target: { value: "כהן" } });
    fireEvent.change(screen.getByLabelText("תאריך לידה"), { target: { value: changedDate } });
    fireEvent.keyDown(screen.getByRole("combobox", { name: "עיר" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "חיפה" }));
    fireEvent.change(screen.getByLabelText("גיל מינימלי מועדף"), { target: { value: "30" } });
    fireEvent.change(screen.getByLabelText("גיל מקסימלי מועדף"), { target: { value: "45" } });
    fireEvent.change(screen.getByLabelText("מרחק מרבי בקילומטרים"), {
      target: { value: "75" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "רומנטיקה" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "דמויות גבריות" }));
    submit();
    await waitFor(() => expect(io.success).toHaveBeenCalledWith("נשמר"));
    expect(io.savedClient).toMatchObject({
      first_name: "נועה",
      last_name: "כהן",
      date_of_birth: changedDate,
      city_id: "city-b",
      preferred_min_age: 30,
      preferred_max_age: 45,
      preferred_distance_km: 75,
      content_preferences: ["casual_chat", "romance"],
      character_preferences: ["female", "male"],
    });

    io.success.mockClear();
    fireEvent.change(screen.getByLabelText("שם פרטי"), { target: { value: client.first_name } });
    fireEvent.change(screen.getByLabelText("שם משפחה"), { target: { value: client.last_name } });
    fireEvent.change(screen.getByLabelText("תאריך לידה"), {
      target: { value: client.date_of_birth },
    });
    fireEvent.keyDown(screen.getByRole("combobox", { name: "עיר" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "תל אביב" }));
    fireEvent.change(screen.getByLabelText("גיל מינימלי מועדף"), {
      target: { value: String(client.preferred_min_age) },
    });
    fireEvent.change(screen.getByLabelText("גיל מקסימלי מועדף"), {
      target: { value: String(client.preferred_max_age) },
    });
    fireEvent.change(screen.getByLabelText("מרחק מרבי בקילומטרים"), {
      target: { value: String(client.preferred_distance_km) },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "רומנטיקה" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "דמויות גבריות" }));
    submit();
    await waitFor(() => expect(io.success).toHaveBeenCalledWith("נשמר"));
    expect(io.savedClient).toMatchObject({
      first_name: client.first_name,
      last_name: client.last_name,
      date_of_birth: client.date_of_birth,
      city_id: client.city_id,
      preferred_min_age: client.preferred_min_age,
      preferred_max_age: client.preferred_max_age,
      preferred_distance_km: client.preferred_distance_km,
      content_preferences: client.content_preferences,
      character_preferences: client.character_preferences,
    });

    const clientWrites = io.write.mock.calls.filter(([table]) => table === "client_profiles");
    expect(clientWrites).toHaveLength(2);
    expect(clientWrites[0]?.[1]).toMatchObject({
      first_name: "נועה",
      last_name: "כהן",
      city_id: "city-b",
      preferred_min_age: 30,
      preferred_max_age: 45,
      preferred_distance_km: 75,
      content_preferences: ["casual_chat", "romance"],
      character_preferences: ["female", "male"],
    });
    expect(clientWrites[1]?.[1]).toMatchObject({
      first_name: client.first_name,
      last_name: client.last_name,
      city_id: client.city_id,
      preferred_min_age: client.preferred_min_age,
      preferred_max_age: client.preferred_max_age,
      preferred_distance_km: client.preferred_distance_km,
      content_preferences: client.content_preferences,
      character_preferences: client.character_preferences,
    });
    expect(io.rpc).toHaveBeenNthCalledWith(1, "save_client_onboarding_step", {
      _payload: {
        date_of_birth: changedDate,
        profile_image_url: client.profile_image_url,
        profile_image_urls: client.profile_image_urls,
      },
    });
    expect(io.rpc).toHaveBeenNthCalledWith(2, "save_client_onboarding_step", {
      _payload: {
        date_of_birth: client.date_of_birth,
        profile_image_url: client.profile_image_url,
        profile_image_urls: client.profile_image_urls,
      },
    });
  });

  it("advances the confirmed baseline after each successful save", async () => {
    render(<Page />);
    await loaded();
    const firstName = screen.getByLabelText("שם פרטי");

    fireEvent.change(firstName, { target: { value: "נועה" } });
    submit();
    await waitFor(() => expect(io.success).toHaveBeenCalledWith("נשמר"));

    io.success.mockClear();
    fireEvent.change(firstName, { target: { value: "מיכל" } });
    submit();
    await waitFor(() => expect(io.success).toHaveBeenCalledWith("נשמר"));

    const clientWrites = io.write.mock.calls.filter(([table]) => table === "client_profiles");
    expect(clientWrites[0]?.[1]).toMatchObject({ first_name: "נועה" });
    expect(clientWrites[1]?.[1]).toMatchObject({ first_name: "מיכל" });
  });

  it("omits an already confirmed conditional field from a later unrelated save", async () => {
    render(<Page />);
    await loaded();

    fireEvent.change(screen.getByLabelText("שם פרטי"), { target: { value: "נועה" } });
    submit();
    await waitFor(() => expect(io.success).toHaveBeenCalledWith("נשמר"));

    io.success.mockClear();
    fireEvent.change(screen.getByLabelText("ספר/י על עצמך"), {
      target: { value: "תיאור מאוחר" },
    });
    submit();
    await waitFor(() => expect(io.success).toHaveBeenCalledWith("נשמר"));

    const clientWrites = io.write.mock.calls.filter(([table]) => table === "client_profiles");
    expect(clientWrites[1]?.[1]).toMatchObject({ bio: "תיאור מאוחר" });
    expect(clientWrites[1]?.[1]).not.toHaveProperty("first_name");
    expect(io.savedClient).toMatchObject({ first_name: "נועה", bio: "תיאור מאוחר" });
  });

  it("advances the client baseline after client success even when the account write fails", async () => {
    let profileAttempts = 0;
    io.write.mockImplementation(async (table, values, userId) => {
      if (table === "profiles" && profileAttempts++ === 0) {
        return { data: null, error: { message: "profile write failed" } };
      }
      return successfulWrite(table, values, userId);
    });
    render(<Page />);
    await loaded();

    fireEvent.change(screen.getByLabelText("שם תצוגה"), { target: { value: "שם B" } });
    fireEvent.change(screen.getByLabelText("שם פרטי"), { target: { value: "נועה" } });
    submit();
    await waitFor(() =>
      expect(io.error).toHaveBeenCalledWith("לא כל השינויים נשמרו. הקלט נשמר, אפשר לנסות שוב."),
    );
    expect(io.savedClient).toMatchObject({ first_name: "נועה" });

    io.error.mockClear();
    fireEvent.change(screen.getByLabelText("שם תצוגה"), {
      target: { value: profile.display_name },
    });
    fireEvent.change(screen.getByLabelText("שם פרטי"), {
      target: { value: client.first_name },
    });
    submit();
    await waitFor(() => expect(io.success).toHaveBeenCalledWith("נשמר"));
    expect(io.savedClient).toMatchObject({ first_name: client.first_name });

    const profileWrites = io.write.mock.calls.filter(([table]) => table === "profiles");
    const clientWrites = io.write.mock.calls.filter(([table]) => table === "client_profiles");
    expect(profileWrites[1]?.[1]).toEqual({ display_name: profile.display_name });
    expect(clientWrites[0]?.[1]).toMatchObject({ first_name: "נועה" });
    expect(clientWrites[1]?.[1]).toMatchObject({ first_name: client.first_name });
  });

  it("does not promote a rejected save into the confirmed baseline", async () => {
    let rejectOnce = true;
    io.write.mockImplementation(async (table, values, userId) => {
      if (table === "client_profiles" && rejectOnce) {
        rejectOnce = false;
        throw new Error("transport failed");
      }
      return successfulWrite(table, values, userId);
    });
    render(<Page />);
    await loaded();
    fireEvent.change(screen.getByLabelText("שם פרטי"), { target: { value: "מיכל" } });

    submit();
    await waitFor(() => expect(io.error).toHaveBeenCalled());
    expect(io.savedClient).toMatchObject({ first_name: client.first_name });
    submit();
    await waitFor(() => expect(io.success).toHaveBeenCalledWith("נשמר"));
    expect(io.savedClient).toMatchObject({ first_name: "מיכל" });

    const clientWrites = io.write.mock.calls.filter(([table]) => table === "client_profiles");
    expect(clientWrites).toHaveLength(2);
    expect(clientWrites[1]?.[1]).toMatchObject({ first_name: "מיכל" });
  });

  it("restores allowed null and empty preference values after a successful intermediate save", async () => {
    io.savedClient = {
      ...client,
      interests: null,
      preferred_min_age: null,
      preferred_max_age: null,
      preferred_distance_km: null,
      content_preferences: [],
      character_preferences: [],
    };
    io.read.mockImplementation(async (table, userId) =>
      table === "client_profiles"
        ? {
            data: {
              ...client,
              interests: null,
              preferred_min_age: null,
              preferred_max_age: null,
              preferred_distance_km: null,
              content_preferences: [],
              character_preferences: [],
            },
            error: null,
          }
        : loadReply(table, userId),
    );
    render(<Page />);
    await loaded();

    fireEvent.change(screen.getByLabelText("תחומי עניין (מופרדים בפסיקים)"), {
      target: { value: "  מוזיקה, טיולים  " },
    });
    fireEvent.change(screen.getByLabelText("גיל מינימלי מועדף"), { target: { value: "25" } });
    fireEvent.change(screen.getByLabelText("גיל מקסימלי מועדף"), { target: { value: "40" } });
    fireEvent.change(screen.getByLabelText("מרחק מרבי בקילומטרים"), {
      target: { value: "50" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "שיחות קלילות" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "דמויות נשיות" }));
    submit();
    await waitFor(() => expect(io.success).toHaveBeenCalledWith("נשמר"));
    expect(io.savedClient).toMatchObject({
      interests: ["מוזיקה", "טיולים"],
      preferred_min_age: 25,
      preferred_max_age: 40,
      preferred_distance_km: 50,
      content_preferences: ["casual_chat"],
      character_preferences: ["female"],
    });

    io.success.mockClear();
    fireEvent.change(screen.getByLabelText("תחומי עניין (מופרדים בפסיקים)"), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByLabelText("גיל מינימלי מועדף"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("גיל מקסימלי מועדף"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("מרחק מרבי בקילומטרים"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "שיחות קלילות" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "דמויות נשיות" }));
    submit();
    await waitFor(() => expect(io.success).toHaveBeenCalledWith("נשמר"));
    expect(io.savedClient).toMatchObject({
      interests: [],
      preferred_min_age: null,
      preferred_max_age: null,
      preferred_distance_km: null,
      content_preferences: [],
      character_preferences: [],
    });

    const clientWrites = io.write.mock.calls.filter(([table]) => table === "client_profiles");
    expect(clientWrites[1]?.[1]).toMatchObject({
      interests: [],
      preferred_min_age: null,
      preferred_max_age: null,
      preferred_distance_km: null,
      content_preferences: [],
      character_preferences: [],
    });
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

  it("rejects malformed discovery city rows without exposing a writable form", async () => {
    io.read.mockImplementation(async (table, userId) =>
      table === "discovery_cities"
        ? { data: [{ id: "city-a", display_name_he: 42 }], error: null }
        : loadReply(table, userId),
    );
    render(<Page />);
    expect(await screen.findByRole("alert")).toHaveTextContent("לא ניתן לטעון את הפרופיל כרגע");
    expect(screen.queryByLabelText("שם תצוגה")).not.toBeInTheDocument();
    expect(io.write).not.toHaveBeenCalled();
  });

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
    "keeps input and retries the same conditional change after %s without claiming false success",
    async (failure) => {
      let failedClientWrite = false;
      io.write.mockImplementation(async (table, values, userId) => {
        if (table === "profiles") return { data: { user_id: userId }, error: null };
        if (failedClientWrite) return successfulWrite(table, values, userId);
        failedClientWrite = true;
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
      fireEvent.change(screen.getByLabelText("שם פרטי"), { target: { value: "מיכל" } });
      submit();
      await waitFor(() => expect(io.error).toHaveBeenCalled());
      expect(io.success).not.toHaveBeenCalled();
      expect(io.savedClient).toMatchObject({ first_name: client.first_name });
      expect(screen.getByLabelText("שם פרטי")).toHaveValue("מיכל");
      expect(screen.getByRole("button", { name: "שמירה" })).toBeEnabled();

      submit();
      await waitFor(() => expect(io.success).toHaveBeenCalledWith("נשמר"));
      expect(io.savedClient).toMatchObject({ first_name: "מיכל" });
      const clientWrites = io.write.mock.calls.filter(([table]) => table === "client_profiles");
      expect(clientWrites).toHaveLength(2);
      expect(clientWrites[1]?.[1]).toMatchObject({ first_name: "מיכל" });
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

  it("persists profile images through the atomic server RPC", async () => {
    render(<Page />);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "עדכון תמונה לבדיקה" }));
    await waitFor(() =>
      expect(io.rpc).toHaveBeenCalledWith("update_client_profile_images", {
        _profile_image_url: "demo-avatar.webp",
        _profile_image_urls: ["demo-avatar.webp", "kept.webp"],
      }),
    );
    await waitFor(() => expect(io.success).toHaveBeenCalledWith("תמונות הפרופיל עודכנו"));
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

    act(() => io.avatarChange?.(["late-avatar.webp", "kept.webp"], "late-avatar.webp"));
    expect(io.write).toHaveBeenCalledTimes(2);

    await act(async () => {
      profileSave.resolve({ data: { user_id: "client-a" }, error: null });
      clientSave.resolve({ data: { user_id: "client-a" }, error: null });
    });

    await waitFor(() =>
      expect(io.rpc).toHaveBeenCalledWith("update_client_profile_images", {
        _profile_image_url: "late-avatar.webp",
        _profile_image_urls: ["late-avatar.webp", "kept.webp"],
      }),
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
    act(() =>
      io.avatarChange?.(["kept-after-partial.webp", "kept.webp"], "kept-after-partial.webp"),
    );

    await act(async () => {
      profileSave.resolve({ data: { user_id: "client-a" }, error: null });
      clientSave.resolve({ data: null, error: { message: "partial failure" } });
    });

    await waitFor(() =>
      expect(io.rpc).toHaveBeenCalledWith("update_client_profile_images", {
        _profile_image_url: "kept-after-partial.webp",
        _profile_image_urls: ["kept-after-partial.webp", "kept.webp"],
      }),
    );
    expect(io.error).toHaveBeenCalledWith("לא כל השינויים נשמרו. הקלט נשמר, אפשר לנסות שוב.");
  });

  it("selects the next image when the pending primary is removed", async () => {
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
    act(() => io.avatarChange?.(["kept.webp"], "kept.webp"));

    await act(async () => {
      profileSave.resolve({ data: { user_id: "client-a" }, error: null });
      clientSave.resolve({ data: { user_id: "client-a" }, error: null });
    });

    await waitFor(() =>
      expect(io.rpc).toHaveBeenCalledWith("update_client_profile_images", {
        _profile_image_url: "kept.webp",
        _profile_image_urls: ["kept.webp"],
      }),
    );
    expect(io.success).toHaveBeenCalledWith("תמונות הפרופיל עודכנו");
  });

  it("removes a legacy public primary without discarding the remaining profile images", async () => {
    io.read.mockImplementation(async (table, userId) => {
      if (table === "profiles") {
        return {
          data: { ...profile, avatar_url: "legacy-primary.webp" },
          error: null,
        };
      }
      if (table === "client_profiles") {
        return {
          data: {
            ...client,
            profile_image_url: null,
            profile_image_urls: ["legacy-primary.webp", "kept.webp"],
          },
          error: null,
        };
      }
      return loadReply(table, userId);
    });
    render(<Page />);
    await loaded();

    act(() => io.avatarChange?.(["kept.webp"], "kept.webp"));

    await waitFor(() =>
      expect(io.rpc).toHaveBeenCalledWith("update_client_profile_images", {
        _profile_image_url: "kept.webp",
        _profile_image_urls: ["kept.webp"],
      }),
    );
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
      io.avatarChange?.(["first-pending.webp", "kept.webp"], "first-pending.webp");
      io.avatarChange?.(["last-pending.webp", "kept.webp"], "last-pending.webp");
    });

    await act(async () => {
      profileSave.resolve({ data: { user_id: "client-a" }, error: null });
      clientSave.resolve({ data: { user_id: "client-a" }, error: null });
    });

    await waitFor(() =>
      expect(io.rpc).toHaveBeenCalledWith("update_client_profile_images", {
        _profile_image_url: "last-pending.webp",
        _profile_image_urls: ["last-pending.webp", "kept.webp"],
      }),
    );
    expect(io.rpc).not.toHaveBeenCalledWith("update_client_profile_images", {
      _profile_image_url: "first-pending.webp",
      _profile_image_urls: ["first-pending.webp", "kept.webp"],
    });
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
      act(() => io.avatarChange?.(["stale-avatar.webp", "kept.webp"], "stale-avatar.webp"));

      io.user = change === "logout" ? null : { id: "client-b", email: "b@example.test" };
      view.rerender(<Page />);
      if (change === "switch") await loaded();
      await act(async () => {
        profileSave.resolve({ data: { user_id: "client-a" }, error: null });
        clientSave.resolve({ data: { user_id: "client-a" }, error: null });
      });

      expect(io.rpc).not.toHaveBeenCalledWith("update_client_profile_images", {
        _profile_image_url: "stale-avatar.webp",
        _profile_image_urls: ["stale-avatar.webp", "kept.webp"],
      });
      expect(io.success).not.toHaveBeenCalled();
      expect(io.error).not.toHaveBeenCalled();
    },
  );

  it("reports a queued avatar failure, unlocks, and retries only on request", async () => {
    const profileSave = deferred<Reply>();
    const clientSave = deferred<Reply>();
    let failAvatar = true;
    io.write.mockImplementation((table) =>
      table === "profiles" ? profileSave.promise : clientSave.promise,
    );
    io.rpc.mockImplementation(async (_name: string, args: Record<string, unknown>) =>
      failAvatar
        ? { data: null, error: { message: "avatar failure" } }
        : {
            data: [
              {
                profile_image_url: args._profile_image_url,
                profile_image_urls: args._profile_image_urls,
              },
            ],
            error: null,
          },
    );
    render(<Page />);
    await loaded();
    submit();
    await waitFor(() => expect(io.write).toHaveBeenCalledTimes(2));
    act(() => io.avatarChange?.(["retry-avatar.webp", "kept.webp"], "retry-avatar.webp"));
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
    await waitFor(() => expect(io.success).toHaveBeenCalledWith("תמונות הפרופיל עודכנו"));
    expect(io.rpc).toHaveBeenCalledWith("update_client_profile_images", {
      _profile_image_url: "retry-avatar.webp",
      _profile_image_urls: ["retry-avatar.webp", "kept.webp"],
    });
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
