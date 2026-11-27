import type { ComponentType, ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigate = vi.hoisted(() => vi.fn());
const rpc = vi.hoisted(() => vi.fn());
const invalidateQueries = vi.hoisted(() => vi.fn(async () => undefined));
const readTable = vi.hoisted(() => vi.fn());

const consentRequirement = {
  id: "00000000-0000-4000-8000-000000040901",
  consent_key: "terms",
  version: "2026-11-05",
  title: "תנאי שימוש – גרסה מאושרת",
  document_url: "https://example.invalid/terms/2026-11-05",
  required: true,
  accepted_at: null,
};

function queryResult(table: string) {
  if (table === "client_profiles") {
    return {
      data: {
        age: 31,
        first_name: "אייל",
        last_name: "כהן",
        date_of_birth: "1995-01-01",
        city_id: "city-a",
        bio: "תיאור תקין ומלא",
        relationship_status: "single",
        smoking_status: "never",
        preferred_min_age: 25,
        preferred_max_age: 40,
        preferred_distance_km: 50,
        content_preferences: ["casual_chat"],
        character_preferences: ["any"],
        onboarding_step: 3,
        profile_image_url: "https://cdn.test/profile-primary.webp",
        profile_image_urls: [
          "https://cdn.test/profile-primary.webp",
          "https://cdn.test/profile-legacy-extra.webp",
        ],
      },
      error: null,
    };
  }
  if (table === "profiles") {
    return { data: { display_name: "אייל כהן", avatar_url: null }, error: null };
  }
  if (table === "discovery_cities") {
    return { data: [{ id: "city-a", display_name_he: "חיפה" }], error: null };
  }
  throw new Error(`Unexpected table: ${table}`);
}

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => options,
  useNavigate: () => navigate,
  Link: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries }),
}));

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: "client-a" } }) }));
vi.mock("@/components/profile/ProfileImageManager", () => ({
  ProfileImageManager: ({
    onChange,
  }: {
    onChange: (images: string[], primary: string | null) => void;
  }) => (
    <button
      type="button"
      onClick={() =>
        onChange(
          ["https://cdn.test/profile-new.webp", "https://cdn.test/profile-legacy-extra.webp"],
          "https://cdn.test/profile-new.webp",
        )
      }
    >
      החלפת תמונה
    </button>
  ),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        order: () => Promise.resolve().then(() => readTable(table)),
        maybeSingle: () => Promise.resolve().then(() => readTable(table)),
      };
      return builder;
    },
    rpc,
  },
}));

import { Route as OnboardingRoute } from "@/routes/app.onboarding";

const OnboardingPage = (OnboardingRoute as unknown as { component: ComponentType }).component;

beforeEach(() => {
  navigate.mockReset();
  rpc.mockReset();
  readTable.mockReset().mockImplementation(queryResult);
  invalidateQueries.mockClear();
  rpc.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
    if (name === "get_client_consent_requirements") {
      return { data: [consentRequirement], error: null };
    }
    if (name === "accept_client_consent") {
      return {
        data: [{ document_id: args?._document_id, accepted_at: "2026-11-05T12:00:00Z" }],
        error: null,
      };
    }
    if (name === "save_client_onboarding_step") return { data: null, error: null };
    if (name === "complete_client_onboarding") return { data: null, error: null };
    throw new Error(`Unexpected RPC: ${name}`);
  });
});

describe("client onboarding consent contract", () => {
  it("shows the age validation message for the actual PostgREST error shape", async () => {
    rpc.mockImplementation(async (name: string) => {
      if (name === "get_client_consent_requirements") return { data: [], error: null };
      if (name === "save_client_onboarding_step") {
        return {
          data: null,
          error: { message: "invalid_onboarding_age", code: "P0001", details: null, hint: null },
        };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });
    render(<OnboardingPage />);

    fireEvent.click(await screen.findByRole("button", { name: "חזרה" }));
    fireEvent.click(screen.getByRole("button", { name: "שמירה והמשך" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("הגיל צריך להיות בין 18 ל־120."));
    expect(screen.getByText("2 מתוך 3")).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("opens a legacy completed profile at the earliest missing step without dropping existing fields", async () => {
    readTable.mockImplementation((table: string) => {
      const result = queryResult(table);
      if (table !== "client_profiles") return result;
      return { ...result, data: { ...result.data, city_id: null, onboarding_step: 3 } };
    });

    render(<OnboardingPage />);

    expect(await screen.findByText("1 מתוך 3")).toBeInTheDocument();
    expect(screen.getByLabelText("שם פרטי")).toHaveValue("אייל");
    expect(screen.getByLabelText("תאריך לידה")).toHaveValue("1995-01-01");
    expect(screen.getByRole("button", { name: "שמירה והמשך" })).toBeInTheDocument();
    expect(rpc.mock.calls.some(([name]) => name === "save_client_onboarding_step")).toBe(false);
  });

  it("requires every configured document and records its exact version before completion", async () => {
    render(<OnboardingPage />);

    expect(await screen.findByRole("link", { name: consentRequirement.title })).toHaveAttribute(
      "href",
      consentRequirement.document_url,
    );
    const complete = screen.getByRole("button", { name: "השלמת פרופיל" });
    expect(complete).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox", { name: /קראתי ואישרתי/ }));
    expect(complete).toBeEnabled();
    fireEvent.click(complete);

    await waitFor(() => {
      expect(rpc).toHaveBeenCalledWith("accept_client_consent", {
        _document_id: consentRequirement.id,
      });
      expect(rpc).toHaveBeenCalledWith("complete_client_onboarding", {
        _payload: expect.objectContaining({
          onboarding_step: 3,
          profile_image_url: "https://cdn.test/profile-primary.webp",
          profile_image_urls: [
            "https://cdn.test/profile-primary.webp",
            "https://cdn.test/profile-legacy-extra.webp",
          ],
        }),
      });
    });
    const acceptOrder = rpc.mock.invocationCallOrder.find(
      (_, index) => rpc.mock.calls[index]?.[0] === "accept_client_consent",
    );
    const completeOrder = rpc.mock.invocationCallOrder.find(
      (_, index) => rpc.mock.calls[index]?.[0] === "complete_client_onboarding",
    );
    expect(acceptOrder).toBeDefined();
    expect(completeOrder).toBeDefined();
    expect(acceptOrder!).toBeLessThan(completeOrder!);
  });

  it("keeps the existing completion path when the consent policy is disabled", async () => {
    rpc.mockImplementation(async (name: string) => {
      if (name === "get_client_consent_requirements") return { data: [], error: null };
      if (name === "complete_client_onboarding") return { data: null, error: null };
      throw new Error(`Unexpected RPC: ${name}`);
    });

    render(<OnboardingPage />);

    const complete = await screen.findByRole("button", { name: "השלמת פרופיל" });
    expect(complete).toBeEnabled();
    fireEvent.click(complete);

    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("complete_client_onboarding", expect.anything()),
    );
    expect(rpc.mock.calls.some(([name]) => name === "accept_client_consent")).toBe(false);
  });

  it("replaces the primary image without discarding additional legacy images", async () => {
    render(<OnboardingPage />);

    fireEvent.click(await screen.findByRole("button", { name: "חזרה" }));
    fireEvent.click(screen.getByRole("button", { name: "החלפת תמונה" }));
    fireEvent.click(screen.getByRole("button", { name: "שמירה והמשך" }));

    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("save_client_onboarding_step", {
        _payload: expect.objectContaining({
          onboarding_step: 3,
          profile_image_url: "https://cdn.test/profile-new.webp",
          profile_image_urls: [
            "https://cdn.test/profile-new.webp",
            "https://cdn.test/profile-legacy-extra.webp",
          ],
        }),
      }),
    );
  });

  it("fails closed when consent requirements cannot be loaded", async () => {
    rpc.mockImplementation(async (name: string) => {
      if (name === "get_client_consent_requirements") {
        return { data: null, error: new Error("consent_unavailable") };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });

    render(<OnboardingPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent("לא ניתן לטעון");
    expect(screen.getByRole("button", { name: "השלמת פרופיל" })).toBeDisabled();
    expect(rpc.mock.calls.some(([name]) => name === "complete_client_onboarding")).toBe(false);
  });

  it("shows a retryable load error when a core profile read rejects", async () => {
    let rejectProfile = true;
    readTable.mockImplementation((table: string) => {
      if (table === "client_profiles" && rejectProfile) {
        rejectProfile = false;
        return Promise.reject(new Error("profile transport failed"));
      }
      return queryResult(table);
    });

    render(<OnboardingPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent("טעינת הפרופיל נכשלה");
    expect(screen.queryByLabelText("שם פרטי")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "נסה שוב" }));

    expect(await screen.findByRole("button", { name: "השלמת פרופיל" })).toBeInTheDocument();
    expect(readTable.mock.calls.filter(([table]) => table === "client_profiles")).toHaveLength(2);
  });

  it("does not treat a resolved Supabase error as an empty onboarding profile", async () => {
    readTable.mockImplementation((table: string) =>
      table === "client_profiles"
        ? { data: null, error: new Error("profile unavailable") }
        : queryResult(table),
    );

    render(<OnboardingPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent("טעינת הפרופיל נכשלה");
    expect(screen.queryByLabelText("שם פרטי")).not.toBeInTheDocument();
  });
});
