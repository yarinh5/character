import type { ComponentType, ComponentProps } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DiscoveryFilters as Filters,
  DiscoveryCharacterWithFilters,
} from "@/hooks/useDiscovery";
import type { DiscoveryDeck } from "@/components/discovery/DiscoveryDeck";

const state = vi.hoisted(() => ({
  activeCharacter: null as DiscoveryCharacterWithFilters | null,
  isLoading: false,
  isRefreshing: false,
  isError: false,
  isEmpty: true,
  isSwipePending: false,
  isFavoritePending: false,
  isFavorite: false,
  swipe: vi.fn(),
  setFavorite: vi.fn(),
  retry: vi.fn(),
  navigate: vi.fn(),
  rpc: vi.fn(),
  lastFilters: null as Filters | null,
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  useRouterState: () => "/app/characters",
  useNavigate: () => state.navigate,
  Outlet: () => null,
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: "client-a" } }) }));
vi.mock("@/lib/analyticsEvents", () => ({ trackAnalyticsEvent: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: state.rpc } }));
vi.mock("@/hooks/useDiscovery", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/hooks/useDiscovery")>();
  return {
    ...original,
    useDiscovery: (_userId: string, filters: Filters) => {
      state.lastFilters = filters;
      return state;
    },
  };
});
vi.mock("@/components/discovery/DiscoveryFilters", () => ({
  DiscoveryFilters: ({
    filters,
    onChange,
  }: {
    filters: Filters;
    onChange: (value: Filters) => void;
  }) => (
    <div>
      <button onClick={() => onChange({ ...filters, favorites_only: true })}>
        מסנן מועדפים לבדיקה
      </button>
      <button
        onClick={() =>
          onChange({
            ...filters,
            min_age: 25,
            max_age: 40,
            city_id: "demo-city",
            interest: "מוזיקה",
            recycled_only: true,
          })
        }
      >
        מסננים נוספים לבדיקה
      </button>
    </div>
  ),
}));
// The deck is a presentation boundary. Exercise the page's existing callbacks;
// this page test does not exercise swipe physics or the RPC implementations.
vi.mock("@/components/discovery/DiscoveryDeck", () => ({
  DiscoveryDeck: (props: ComponentProps<typeof DiscoveryDeck>) => (
    <section aria-label="כרטיס דמות">
      <span>{props.character.name}</span>
      <button disabled={props.disabled} onClick={props.onPass}>
        דלג
      </button>
      <button disabled={props.disabled} onClick={props.onLike}>
        אהבתי
      </button>
      <button disabled={props.disabled} onClick={props.onFavorite}>
        מועדף
      </button>
      <button disabled={props.disabled} onClick={props.onStartChat}>
        שיחה
      </button>
      <button disabled={props.disabled} onClick={props.onViewProfile}>
        פרופיל דמות
      </button>
    </section>
  ),
}));

import { Route } from "@/routes/app.characters";
import { EMPTY_DISCOVERY_FILTERS } from "@/hooks/useDiscovery";
const Page = (Route as unknown as { component: ComponentType }).component;
const character = {
  id: "character-a",
  name: "דמות הדגמה",
  is_liked: false,
  conversation_id: "existing-conversation",
} as DiscoveryCharacterWithFilters;

beforeEach(() => {
  state.activeCharacter = null;
  state.isLoading = false;
  state.isRefreshing = false;
  state.isError = false;
  state.isEmpty = true;
  state.isFavorite = false;
  state.isSwipePending = false;
  state.isFavoritePending = false;
  state.swipe.mockReset().mockResolvedValue(undefined);
  state.setFavorite.mockReset().mockResolvedValue(undefined);
  state.retry.mockReset().mockResolvedValue(undefined);
  state.navigate.mockReset();
  state.rpc.mockReset().mockResolvedValue({ data: "canonical-conversation", error: null });
});

describe("client discovery states", () => {
  it("uses a neutral empty message without filters and does not invent the reason", () => {
    render(<Page />);
    expect(screen.getByText("אין דמויות להצגה כרגע")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "איפוס מסננים" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["מסנן מועדפים לבדיקה", "מסננים נוספים לבדיקה"])(
    "offers a full EMPTY_DISCOVERY_FILTERS reset after %s",
    (button) => {
      render(<Page />);
      fireEvent.click(screen.getByRole("button", { name: button }));
      expect(screen.getByText("לא נמצאו דמויות למסננים הנוכחיים")).toBeInTheDocument();
      expect(screen.queryByText("אין דמויות להצגה כרגע")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "איפוס מסננים" }));
      expect(state.lastFilters).toEqual(EMPTY_DISCOVERY_FILTERS);
      expect(screen.getByText("אין דמויות להצגה כרגע")).toBeInTheDocument();
    },
  );

  it.each(["loading", "refreshing"])(
    "shows a skeleton without contradictory empty/error during %s with no card",
    (mode) => {
      state.isLoading = mode === "loading";
      state.isRefreshing = mode === "refreshing";
      render(<Page />);
      expect(screen.getByRole("status", { name: "טוען דמויות" })).toBeInTheDocument();
      expect(screen.queryByText("אין דמויות להצגה כרגע")).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );

  it.each([null, character])("exposes a retryable error including cached card=%j", (cached) => {
    state.activeCharacter = cached;
    state.isError = true;
    const view = render(<Page />);
    expect(screen.getByRole("alert")).toHaveTextContent("טעינת הדמויות נכשלה");
    expect(screen.queryByRole("region", { name: "כרטיס דמות" })).not.toBeInTheDocument();
    expect(screen.queryByText("אין דמויות להצגה כרגע")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "נסה שוב" }));
    expect(state.retry).toHaveBeenCalledTimes(1);
    state.isRefreshing = true;
    view.rerender(<Page />);
    const retry = screen.getByRole("button", { name: "מנסה שוב..." });
    expect(retry).toBeDisabled();
    fireEvent.click(retry);
    expect(state.retry).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status", { name: "טוען דמויות" })).not.toBeInTheDocument();
  });

  it("labels a background refresh with cached data and prevents actions until it completes", () => {
    state.activeCharacter = character;
    state.isEmpty = false;
    state.isRefreshing = true;
    render(<Page />);
    expect(screen.getByRole("status")).toHaveTextContent("מרענן דמויות...");
    expect(screen.getByRole("region", { name: "כרטיס דמות" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "אהבתי" })).toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("preserves Swipe, favorite, profile and canonical chat callbacks", async () => {
    state.activeCharacter = character;
    state.isEmpty = false;
    render(<Page />);
    fireEvent.click(screen.getByRole("button", { name: "דלג" }));
    fireEvent.click(screen.getByRole("button", { name: "אהבתי" }));
    expect(state.swipe).toHaveBeenCalledWith(character, "pass");
    expect(state.swipe).toHaveBeenCalledWith(character, "like");
    fireEvent.click(screen.getByRole("button", { name: "מועדף" }));
    expect(state.setFavorite).toHaveBeenCalledWith("character-a", true);
    fireEvent.click(screen.getByRole("button", { name: "פרופיל דמות" }));
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/app/characters/$characterId",
      params: { characterId: "character-a" },
    });
    fireEvent.click(screen.getByRole("button", { name: "שיחה" }));
    await waitFor(() =>
      expect(state.navigate).toHaveBeenCalledWith({
        to: "/app/chat/$conversationId",
        params: { conversationId: "canonical-conversation" },
      }),
    );
    expect(state.rpc).toHaveBeenCalledTimes(1);
    expect(state.rpc).toHaveBeenCalledWith("start_or_get_conversation", {
      _character_id: "character-a",
    });
  });
});
