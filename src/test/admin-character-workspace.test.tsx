import { useSyncExternalStore } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Reply<T = unknown> = { data: T; error: unknown };
type Character = {
  id: string;
  name: string;
  fictional_age: number | null;
  category: string | null;
  short_description: string | null;
  full_description: string | null;
  personality: string | null;
  interests: string[] | null;
  discovery_city_id: string | null;
  avatar_url: string | null;
  availability_status: string;
  is_active: boolean;
  is_visible: boolean;
};

const io = vi.hoisted(() => ({
  listeners: new Set<() => void>(),
  sessionId: "admin-a" as string | null,
  userId: "admin-a" as string | null,
  role: "admin",
  loading: false,
  characters: vi.fn<() => Promise<Reply<Character[]>>>(),
  assignments: vi.fn<() => Promise<Reply<{ character_id: string }[]>>>(),
  conversations: vi.fn<() => Promise<Reply<{ character_id: string }[]>>>(),
  cities: vi.fn<() => Promise<Reply<{ id: string; display_name_he: string }[]>>>(),
  update: vi.fn<(input: { id: string; payload: Record<string, unknown> }) => Promise<Reply>>(),
  insert: vi.fn<(payload: Record<string, unknown>) => Promise<Reply>>(),
  createCity: vi.fn<(name: string) => Promise<Reply>>(),
  success: vi.fn(),
  error: vi.fn(),
  avatarProps: null as null | {
    value: string | null;
    disabled?: boolean;
    onChange: (value: string | null) => void;
    onUploadStateChange?: (uploading: boolean) => void;
  },
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => {
    useSyncExternalStore(
      (notify) => {
        io.listeners.add(notify);
        return () => io.listeners.delete(notify);
      },
      () => [io.sessionId, io.userId, io.role, io.loading].join(":"),
    );
    return {
      session: io.sessionId ? { user: { id: io.sessionId } } : null,
      user: io.userId ? { id: io.userId } : null,
      role: io.role,
      loading: io.loading,
    };
  },
}));
vi.mock("sonner", () => ({ toast: { success: io.success, error: io.error } }));
vi.mock("@/components/admin/AdminLayout", () => ({
  PageHeader: ({ title, actions }: { title: string; actions?: React.ReactNode }) => (
    <header>
      <h1>{title}</h1>
      {actions}
    </header>
  ),
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));
vi.mock("@/components/common/AvatarUpload", () => ({
  AvatarUpload: (props: NonNullable<typeof io.avatarProps>) => {
    io.avatarProps = props;
    return (
      <div aria-label="בקרת תמונת דמות">
        <span>{props.value ?? "ללא תמונה"}</span>
        <button
          type="button"
          disabled={props.disabled}
          onClick={() => props.onUploadStateChange?.(true)}
        >
          התחל העלאת תמונה
        </button>
        <button
          type="button"
          onClick={() => {
            props.onChange("https://cdn.test/new.webp");
            props.onUploadStateChange?.(false);
          }}
        >
          השלם העלאת תמונה
        </button>
        <button type="button" onClick={() => props.onChange(null)}>
          הסר תמונה
        </button>
      </div>
    );
  },
}));
vi.mock("@/components/admin/CharacterMediaDialog", () => ({
  CharacterMediaDialog: ({
    character,
    onClose,
  }: {
    character: { id: string; name: string };
    onClose: () => void;
  }) => (
    <div role="dialog" aria-label={`ניהול מדיה: ${character.name}`}>
      <button onClick={onClose}>סגור מדיה</button>
    </div>
  ),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => ({
      select: () => {
        if (table === "characters") return { order: () => io.characters() };
        if (table === "character_operator_assignments") return { in: () => io.assignments() };
        if (table === "conversations") return { in: () => io.conversations() };
        if (table === "discovery_cities") {
          return { eq: () => ({ order: () => io.cities() }) };
        }
        throw new Error(`unexpected read: ${table}`);
      },
      update: (payload: Record<string, unknown>) => ({
        eq: (_column: string, id: string) => ({
          select: () => ({ maybeSingle: () => io.update({ id, payload }) }),
        }),
      }),
      insert: (payload: Record<string, unknown>) => ({
        select: () => ({ maybeSingle: () => io.insert(payload) }),
      }),
    }),
    rpc: (name: string, args: { _display_name_he: string }) => {
      if (name !== "create_discovery_city") throw new Error(`unexpected rpc: ${name}`);
      return io.createCity(args._display_name_he);
    },
  },
}));

import { Route } from "@/routes/admin.characters";

const character: Character = {
  id: "character-a",
  name: "דמות א",
  fictional_age: null,
  category: "legacy-category",
  short_description: null,
  full_description: "תיאור",
  personality: null,
  interests: null,
  discovery_city_id: "legacy-city",
  avatar_url: "https://cdn.test/old.webp",
  availability_status: "legacy-away",
  is_active: true,
  is_visible: true,
};
const second: Character = {
  ...character,
  id: "character-b",
  name: "דמות ב",
  discovery_city_id: null,
  is_active: false,
  is_visible: false,
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

function mount() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const root = createRootRoute({ component: Outlet });
  const route = createRoute({
    getParentRoute: () => root,
    path: "/admin/characters",
    component: Route.options.component,
  });
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ["/admin/characters"] }),
  });
  const view = render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return {
    ...view,
    qc,
    rerenderAuth: () =>
      act(() => {
        io.listeners.forEach((notify) => notify());
      }),
  };
}

async function openEdit(name = character.name) {
  fireEvent.click(await screen.findByRole("button", { name: `עריכת ${name}` }));
  return await screen.findByRole("dialog", { name: `עריכת ${name}` });
}

beforeAll(() => {
  window.scrollTo = vi.fn();
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
});

beforeEach(() => {
  vi.clearAllMocks();
  io.sessionId = io.userId = "admin-a";
  io.role = "admin";
  io.loading = false;
  io.avatarProps = null;
  io.characters.mockReset().mockResolvedValue({ data: [character, second], error: null });
  io.assignments
    .mockReset()
    .mockResolvedValue({ data: [{ character_id: character.id }], error: null });
  io.conversations.mockReset().mockResolvedValue({
    data: [{ character_id: character.id }, { character_id: character.id }],
    error: null,
  });
  io.cities.mockReset().mockResolvedValue({ data: [], error: null });
  io.update.mockReset().mockImplementation(async ({ id, payload }) => ({
    data: { id, ...payload },
    error: null,
  }));
  io.insert.mockReset().mockResolvedValue({ data: { id: "created-character" }, error: null });
  io.createCity.mockReset().mockImplementation(async (name) => ({
    data: [{ id: "new-city", display_name_he: name }],
    error: null,
  }));
});

describe("admin character workspace", () => {
  it("shows list failure instead of empty and retries the real list", async () => {
    io.characters
      .mockResolvedValueOnce({ data: null as never, error: new Error("private") })
      .mockResolvedValueOnce({ data: [character], error: null });
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("טעינת הדמויות נכשלה");
    expect(screen.queryByText("אין דמויות עדיין")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "נסה שוב לטעון דמויות" }));
    expect(await screen.findByText(character.name)).toBeInTheDocument();
  });

  it("keeps the list when one counter fails and retries that counter independently", async () => {
    io.assignments
      .mockResolvedValueOnce({ data: null as never, error: new Error("private") })
      .mockResolvedValueOnce({ data: [{ character_id: character.id }], error: null });
    mount();
    const card = await screen.findByRole("article", { name: character.name });
    expect(await within(card).findByText("עובדים: לא זמין")).toBeInTheDocument();
    expect(await within(card).findByText("2 שיחות")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "נסה שוב לטעון מוני עובדים" }));
    expect(await within(card).findByText("1 עובדים")).toBeInTheDocument();
    expect(screen.getByText(character.name)).toBeInTheDocument();
  });

  it("filters only loaded rows, reports no-results, and resets all filters", async () => {
    mount();
    expect(await screen.findByText("2 תוצאות טעונות")).toBeInTheDocument();
    await userEvent.type(
      screen.getByRole("searchbox", { name: "חיפוש בדמויות הטעונות" }),
      "לא קיימת",
    );
    expect(screen.getByText("אין תוצאות במסננים הנוכחיים")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "איפוס חיפוש ומסננים" }));
    expect(await screen.findByText(character.name)).toBeInTheDocument();
    expect(screen.getByText(second.name)).toBeInTheDocument();
  });

  it("preserves untouched null and legacy values by sending only the edited field", async () => {
    mount();
    const dialog = await openEdit();
    expect(
      within(dialog).getByRole("combobox", { name: "עיר קיימת שאינה ברשימה" }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("option", { name: "ערך קיים: legacy-away" }),
    ).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("קטגוריה"), {
      target: { value: "קטגוריה חדשה" },
    });
    expect(within(dialog).getByText("יש שינויים שלא נשמרו")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "שמור" }));
    await waitFor(() =>
      expect(io.update).toHaveBeenCalledWith({
        id: character.id,
        payload: { category: "קטגוריה חדשה" },
      }),
    );
  });

  it("treats a zero-row update as failure, keeps the draft, and unlocks retry", async () => {
    io.update.mockResolvedValueOnce({ data: null, error: null });
    mount();
    const dialog = await openEdit();
    const name = within(dialog).getByLabelText("שם *");
    fireEvent.change(name, { target: { value: "טיוטה שנשמרת" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "שמור" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("שמירת הדמות נכשלה");
    expect(name).toHaveValue("טיוטה שנשמרת");
    expect(within(dialog).getByRole("button", { name: "שמור" })).toBeEnabled();
    expect(io.success).not.toHaveBeenCalled();
  });

  it("uses a synchronous lock to prevent double-submit", async () => {
    const pending = deferred<Reply>();
    io.update.mockReturnValueOnce(pending.promise);
    mount();
    const dialog = await openEdit();
    fireEvent.change(within(dialog).getByLabelText("שם *"), { target: { value: "שם חדש" } });
    const save = within(dialog).getByRole("button", { name: "שמור" });
    fireEvent.click(save);
    fireEvent.click(save);
    expect(io.update).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve({ data: { id: character.id }, error: null }));
  });

  it("reports refresh failure separately after a verified successful mutation", async () => {
    io.characters
      .mockResolvedValueOnce({ data: [character], error: null })
      .mockResolvedValueOnce({ data: null as never, error: new Error("refresh") });
    mount();
    const dialog = await openEdit();
    fireEvent.change(within(dialog).getByLabelText("שם *"), { target: { value: "שם מעודכן" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "שמור" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("הדמות נשמרה, אך רענון הרשימה נכשל");
    expect(
      screen.queryByRole("dialog", { name: `עריכת ${character.name}` }),
    ).not.toBeInTheDocument();
    expect(io.success).toHaveBeenCalled();
  });

  it("keeps a legacy city on city-read failure and retries without closing the draft", async () => {
    io.cities
      .mockResolvedValueOnce({ data: null as never, error: new Error("city") })
      .mockResolvedValueOnce({ data: [], error: null });
    mount();
    const dialog = await openEdit();
    expect(
      within(dialog).getByRole("combobox", { name: "עיר קיימת שאינה ברשימה" }),
    ).toBeInTheDocument();
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("טעינת הערים נכשלה");
    fireEvent.click(within(dialog).getByRole("button", { name: "נסה שוב לטעון ערים" }));
    await waitFor(() => expect(io.cities).toHaveBeenCalledTimes(2));
    expect(
      within(dialog).getByRole("combobox", { name: "עיר קיימת שאינה ברשימה" }),
    ).toBeInTheDocument();
  });

  it("distinguishes explicit avatar removal and blocks save while an upload is pending", async () => {
    mount();
    const dialog = await openEdit();
    fireEvent.click(within(dialog).getByRole("button", { name: "התחל העלאת תמונה" }));
    expect(within(dialog).getByRole("button", { name: "שמור" })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "השלם העלאת תמונה" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "הסר תמונה" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "שמור" }));
    await waitFor(() =>
      expect(io.update).toHaveBeenCalledWith({ id: character.id, payload: { avatar_url: null } }),
    );
  });

  it("blocks ambiguous create retry until the list is checked", async () => {
    io.insert.mockRejectedValueOnce(new Error("timeout"));
    io.characters
      .mockResolvedValueOnce({ data: [character], error: null })
      .mockResolvedValueOnce({ data: [character], error: null });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "דמות חדשה" }));
    const dialog = await screen.findByRole("dialog", { name: "דמות חדשה" });
    fireEvent.change(within(dialog).getByLabelText("שם *"), { target: { value: "דמות חדשה" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "שמור" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("לא ידוע אם הדמות נוצרה");
    expect(within(dialog).getByRole("button", { name: "שמור" })).toBeDisabled();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "בדוק את הרשימה לפני ניסיון נוסף" }),
    );
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "שמור" })).toBeEnabled());
  });

  it("creates a character with the existing defaults and verifies the returned id", async () => {
    io.characters
      .mockResolvedValueOnce({ data: [character], error: null })
      .mockResolvedValueOnce({ data: [character], error: null });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "דמות חדשה" }));
    const dialog = await screen.findByRole("dialog", { name: "דמות חדשה" });
    fireEvent.change(within(dialog).getByLabelText("שם *"), { target: { value: "  דמות חדשה  " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "שמור" }));
    await waitFor(() =>
      expect(io.insert).toHaveBeenCalledWith({
        name: "דמות חדשה",
        fictional_age: null,
        category: null,
        short_description: null,
        full_description: null,
        personality: null,
        interests: [],
        discovery_city_id: null,
        avatar_url: null,
        availability_status: "available",
        is_active: true,
        is_visible: true,
      }),
    );
    expect(io.success).toHaveBeenCalledWith("דמות נוצרה");
  });

  it("keeps city creation separate and rejects a malformed RPC result", async () => {
    io.createCity.mockResolvedValueOnce({
      data: [{ id: "wrong-city", display_name_he: "שם אחר" }],
      error: null,
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "דמות חדשה" }));
    const dialog = await screen.findByRole("dialog", { name: "דמות חדשה" });
    await userEvent.click(within(dialog).getByRole("combobox", { name: "ללא עיר" }));
    const citySearch = await screen.findByPlaceholderText("חיפוש עיר...");
    await userEvent.type(citySearch, "עיר בדיקה");
    await userEvent.click(await screen.findByText('הוסף "עיר בדיקה"'));
    const confirmation = await screen.findByRole("alertdialog");
    fireEvent.click(within(confirmation).getByRole("button", { name: "הוסף עיר" }));
    await waitFor(() => expect(io.error).toHaveBeenCalledWith("יצירת העיר נכשלה"));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("עיר בדיקה");
    expect(io.insert).not.toHaveBeenCalled();
  });

  it("verifies visibility writes and preserves the card when the returned row is wrong", async () => {
    io.update.mockResolvedValueOnce({ data: { id: "other", is_visible: false }, error: null });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: `הסתר: ${character.name}` }));
    await waitFor(() => expect(io.error).toHaveBeenCalledWith("עדכון הנראות נכשל"));
    expect(screen.getByRole("button", { name: `הסתר: ${character.name}` })).toBeEnabled();
    expect(screen.getByRole("article", { name: character.name })).toHaveTextContent("visible");
  });

  it("drops late completion and old feedback after an admin identity change", async () => {
    const pending = deferred<Reply>();
    io.update.mockReturnValueOnce(pending.promise);
    mount();
    const dialog = await openEdit();
    fireEvent.change(within(dialog).getByLabelText("שם *"), { target: { value: "שם ישן" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "שמור" }));
    io.sessionId = io.userId = "admin-b";
    await act(async () => io.listeners.forEach((notify) => notify()));
    await act(async () => pending.resolve({ data: { id: character.id }, error: null }));
    expect(io.success).not.toHaveBeenCalled();
    expect(screen.queryByDisplayValue("שם ישן")).not.toBeInTheDocument();
  });

  it("guards reads when session, user and admin role do not agree", async () => {
    io.userId = "other-user";
    mount();
    expect(await screen.findByRole("status")).toHaveTextContent("נדרש חיבור מנהל מאומת");
    expect(io.characters).not.toHaveBeenCalled();
  });

  it("opens existing media management for the selected character", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: `ניהול מדיה: ${second.name}` }));
    expect(screen.getByRole("dialog", { name: `ניהול מדיה: ${second.name}` })).toBeInTheDocument();
  });
});
