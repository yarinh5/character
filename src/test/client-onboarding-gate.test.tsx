import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RequireClient } from "@/components/client/ClientLayout";

const io = vi.hoisted(() => ({
  pathname: "/app/characters",
  userId: "client-a",
  navigate: vi.fn(),
  signOut: vi.fn(),
  renderProtected: vi.fn(),
  pendingClientRead: null as Promise<{
    data: unknown;
    error: { message: string } | null;
  }> | null,
  responses: {} as Record<string, { data: unknown; error: { message: string } | null }>,
  consentResponse: { data: [] as unknown, error: null as { message: string } | null },
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => io.navigate,
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname: io.pathname } }),
}));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    loading: false,
    session: { user: { id: io.userId } },
    role: "client",
    signOut: io.signOut,
  }),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: () => Promise.resolve(io.consentResponse),
    from(table: string) {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: () =>
          table === "client_profiles" && io.pendingClientRead
            ? io.pendingClientRead
            : Promise.resolve(io.responses[table]),
      };
      return query;
    },
  },
}));

const completeProfile = {
  onboarding_completed_at: "2026-01-01T00:00:00Z",
  computed_age: 30,
  age: 30,
  first_name: "Dana",
  last_name: "Levi",
  city_id: "city-a",
  bio: "A complete profile",
  relationship_status: "single",
  smoking_status: "never",
  preferred_min_age: 25,
  preferred_max_age: 40,
  preferred_distance_km: 50,
  content_preferences: ["casual_chat"],
  character_preferences: ["any"],
};
const requiredConsent = {
  id: "consent-a",
  consent_key: "terms",
  version: "1",
  title: "Terms",
  document_url: "https://example.test/terms",
  required: true,
  accepted_at: null as string | null,
};

function mount() {
  return render(
    <RequireClient>
      <p>Protected content</p>
    </RequireClient>,
  );
}

beforeEach(() => {
  io.pathname = "/app/characters";
  io.userId = "client-a";
  io.navigate.mockReset();
  io.signOut.mockReset().mockResolvedValue(undefined);
  io.renderProtected.mockReset();
  io.pendingClientRead = null;
  io.responses = {
    profiles: { data: { status: "active", deleted_at: null, pii_archived_at: null }, error: null },
    system_settings: { data: { value: true }, error: null },
    client_profiles: { data: completeProfile, error: null },
  };
  io.consentResponse = { data: [], error: null };
});

describe("client onboarding navigation gate", () => {
  it("admits a profile that satisfies the server's mandatory-onboarding fields", async () => {
    mount();
    expect(await screen.findByText("Protected content")).toBeInTheDocument();
    expect(io.navigate).not.toHaveBeenCalled();
  });

  it("sends a legacy completed profile with missing fields back to onboarding", async () => {
    io.responses.client_profiles = {
      data: { ...completeProfile, city_id: null, content_preferences: [] },
      error: null,
    };
    mount();
    await waitFor(() =>
      expect(io.navigate).toHaveBeenCalledWith({ to: "/app/onboarding", replace: true }),
    );
    expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
  });

  it.each([
    ["missing completion", { onboarding_completed_at: null }],
    ["missing age", { computed_age: null, age: null }],
    ["underage", { computed_age: 17 }],
    ["missing first name", { first_name: " " }],
    ["missing last name", { last_name: null }],
    ["missing city", { city_id: null }],
    ["missing bio", { bio: " " }],
    ["missing relationship status", { relationship_status: null }],
    ["missing smoking status", { smoking_status: null }],
    ["missing minimum age", { preferred_min_age: null }],
    ["missing maximum age", { preferred_max_age: null }],
    ["missing distance", { preferred_distance_km: null }],
    ["missing content preference", { content_preferences: [] }],
    ["missing character preference", { character_preferences: [] }],
  ])("redirects when the profile has %s", async (_case, changes) => {
    io.responses.client_profiles = { data: { ...completeProfile, ...changes }, error: null };
    mount();
    await waitFor(() =>
      expect(io.navigate).toHaveBeenCalledWith({ to: "/app/onboarding", replace: true }),
    );
    expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
  });

  it.each([
    "city_id",
    "relationship_status",
    "smoking_status",
    "preferred_min_age",
    "preferred_max_age",
    "preferred_distance_km",
  ])("does not admit a malformed profile missing %s", async (field) => {
    io.responses.client_profiles = {
      data: { ...completeProfile, [field]: undefined },
      error: null,
    };
    mount();
    await waitFor(() =>
      expect(io.navigate).toHaveBeenCalledWith({ to: "/app/onboarding", replace: true }),
    );
    expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
  });

  it("accepts a legacy age when computed_age is absent", async () => {
    io.responses.client_profiles = {
      data: { ...completeProfile, computed_age: null },
      error: null,
    };
    mount();
    expect(await screen.findByText("Protected content")).toBeInTheDocument();
  });

  it("keeps onboarding available to an incomplete legacy client", async () => {
    io.pathname = "/app/onboarding";
    io.responses.client_profiles = { data: { ...completeProfile, city_id: null }, error: null };
    mount();
    expect(await screen.findByText("Protected content")).toBeInTheDocument();
    expect(io.navigate).not.toHaveBeenCalled();
  });

  it("does not render protected content while rechecking a new route", async () => {
    io.pathname = "/app/onboarding";
    io.responses.client_profiles = { data: { ...completeProfile, city_id: null }, error: null };
    let resolveRead!: (result: { data: unknown; error: null }) => void;
    const Probe = () => {
      io.renderProtected();
      return <p>Protected content</p>;
    };
    const view = render(
      <RequireClient>
        <Probe />
      </RequireClient>,
    );
    expect(await screen.findByText("Protected content")).toBeInTheDocument();
    io.renderProtected.mockClear();
    io.pendingClientRead = new Promise((resolve) => {
      resolveRead = resolve;
    });
    io.pathname = "/app/characters";
    view.rerender(
      <RequireClient>
        <Probe />
      </RequireClient>,
    );
    expect(io.renderProtected).not.toHaveBeenCalled();
    expect(screen.queryByText("Protected content")).not.toBeInTheDocument();

    await act(async () =>
      resolveRead(io.responses.client_profiles as { data: unknown; error: null }),
    );
    await waitFor(() =>
      expect(io.navigate).toHaveBeenCalledWith({ to: "/app/onboarding", replace: true }),
    );
  });

  it("does not reuse the previous client's admission after a session change", async () => {
    const view = mount();
    expect(await screen.findByText("Protected content")).toBeInTheDocument();
    io.responses.client_profiles = { data: { ...completeProfile, city_id: null }, error: null };
    io.userId = "client-b";
    view.rerender(
      <RequireClient>
        <p>Protected content</p>
      </RequireClient>,
    );
    expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(io.navigate).toHaveBeenCalledWith({ to: "/app/onboarding", replace: true }),
    );
  });

  it("does not require completion when mandatory onboarding is disabled", async () => {
    io.responses.system_settings = { data: { value: false }, error: null };
    io.responses.client_profiles = { data: null, error: null };
    mount();
    expect(await screen.findByText("Protected content")).toBeInTheDocument();
  });

  it("routes a completed client to accept a newly required consent", async () => {
    io.consentResponse = {
      data: [requiredConsent],
      error: null,
    };
    mount();
    await waitFor(() =>
      expect(io.navigate).toHaveBeenCalledWith({ to: "/app/onboarding", replace: true }),
    );
    expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
  });

  it("admits a client whose required consent is accepted", async () => {
    io.consentResponse = {
      data: [{ ...requiredConsent, accepted_at: "2026-01-01T00:00:00Z" }],
      error: null,
    };
    mount();
    expect(await screen.findByText("Protected content")).toBeInTheDocument();
  });

  it("does not require an optional consent", async () => {
    io.consentResponse = { data: [{ ...requiredConsent, required: false }], error: null };
    mount();
    expect(await screen.findByText("Protected content")).toBeInTheDocument();
  });

  it("blocks malformed consent data instead of admitting a client", async () => {
    io.consentResponse = { data: { required: false }, error: null };
    mount();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
  });

  it("blocks a failed consent lookup on a protected route", async () => {
    io.consentResponse = { data: null, error: { message: "policy unavailable" } };
    mount();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
  });

  it("keeps onboarding available when consent lookup fails there", async () => {
    io.pathname = "/app/onboarding";
    io.consentResponse = { data: null, error: { message: "policy unconfigured" } };
    mount();
    expect(await screen.findByText("Protected content")).toBeInTheDocument();
  });

  it.each(["system_settings", "client_profiles", "profiles"])(
    "does not admit the client when the %s read fails",
    async (table) => {
      io.responses[table] = { data: null, error: { message: "read failed" } };
      mount();
      expect(await screen.findByRole("alert")).toBeInTheDocument();
      expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
      expect(io.signOut).not.toHaveBeenCalled();
    },
  );

  it("can retry a failed gate read without signing out", async () => {
    io.responses.system_settings = { data: null, error: { message: "temporary failure" } };
    mount();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    io.responses.system_settings = { data: { value: true }, error: null };
    fireEvent.click(screen.getByRole("button", { name: "נסה שוב" }));
    expect(await screen.findByText("Protected content")).toBeInTheDocument();
    expect(io.signOut).not.toHaveBeenCalled();
  });

  it("signs out an archived profile instead of admitting it", async () => {
    io.responses.profiles = {
      data: { status: "active", deleted_at: null, pii_archived_at: "2026-01-01" },
      error: null,
    };
    mount();
    await waitFor(() => expect(io.signOut).toHaveBeenCalledTimes(1));
    expect(io.navigate).toHaveBeenCalledWith({ to: "/login" });
    expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
  });
});
