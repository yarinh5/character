import { useCallback, useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Database, Json } from "@/integrations/supabase/types";

const DISCOVERY_PAGE_SIZE = 12;

type DiscoveryCharacter = Database["public"]["Functions"]["get_discovery_characters"]["Returns"][number];
type DiscoveryCursor = Pick<DiscoveryCharacter, "created_at" | "id">;
type DiscoveryPage = { items: DiscoveryCharacter[]; nextCursor?: DiscoveryCursor };
type Swipe = "like" | "pass";
type FavoriteRpcResult = { is_favorite?: boolean };

function isBusinessError(error: unknown, code: string) {
  return typeof error === "object" && error !== null && "message" in error && String(error.message).includes(code);
}

async function fetchDiscoveryPage(cursor: DiscoveryCursor | null): Promise<DiscoveryPage> {
  const { data, error } = await supabase.rpc("get_discovery_characters", {
    _limit: DISCOVERY_PAGE_SIZE,
    _cursor_created_at: cursor?.created_at,
    _cursor_id: cursor?.id,
  });
  if (error) throw error;

  const items = (data ?? []) as DiscoveryCharacter[];
  const lastItem = items.at(-1);
  return {
    items,
    nextCursor: lastItem ? { created_at: lastItem.created_at, id: lastItem.id } : undefined,
  };
}

export function useDiscovery(userId?: string) {
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => new Set());
  const [favoriteOverrides, setFavoriteOverrides] = useState<Record<string, boolean>>({});

  const discoveryQuery = useInfiniteQuery({
    queryKey: ["discovery", userId],
    enabled: Boolean(userId),
    initialPageParam: null as DiscoveryCursor | null,
    queryFn: ({ pageParam }) => fetchDiscoveryPage(pageParam),
    getNextPageParam: (lastPage) =>
      lastPage.items.length === DISCOVERY_PAGE_SIZE ? lastPage.nextCursor : undefined,
  });

  const allCharacters = useMemo(() => {
    const byId = new Map<string, DiscoveryCharacter>();
    discoveryQuery.data?.pages.forEach((page) => {
      page.items.forEach((character) => byId.set(character.id, character));
    });
    return [...byId.values()];
  }, [discoveryQuery.data?.pages]);

  const preferenceCharacterIds = useMemo(() => allCharacters.map((character) => character.id), [allCharacters]);
  const preferencesQuery = useQuery({
    queryKey: ["discovery-preferences", userId, preferenceCharacterIds],
    enabled: Boolean(userId) && preferenceCharacterIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("client_character_preferences")
        .select("character_id, is_favorite")
        .in("character_id", preferenceCharacterIds);
      if (error) throw error;
      return data ?? [];
    },
  });

  const storedFavorites = useMemo(
    () => new Map((preferencesQuery.data ?? []).map((preference) => [preference.character_id, preference.is_favorite])),
    [preferencesQuery.data],
  );

  const visibleCharacters = useMemo(
    () => allCharacters.filter((character) => !dismissedIds.has(character.id)),
    [allCharacters, dismissedIds],
  );

  const { fetchNextPage, hasNextPage, isFetchingNextPage } = discoveryQuery;

  useEffect(() => {
    setDismissedIds(new Set());
    setFavoriteOverrides({});
  }, [userId]);

  useEffect(() => {
    if (
      visibleCharacters.length <= 3 &&
      hasNextPage &&
      !isFetchingNextPage
    ) {
      void fetchNextPage();
    }
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, visibleCharacters.length]);

  const swipeMutation = useMutation({
    mutationFn: async ({ characterId, swipe }: { characterId: string; swipe: Swipe }) => {
      const { data, error } = await supabase.rpc("set_character_swipe", {
        _character_id: characterId,
        _swipe: swipe,
      });
      if (error) throw error;
      return data as Json;
    },
    onMutate: ({ characterId }) => {
      setDismissedIds((previous) => new Set(previous).add(characterId));
    },
    onError: (error, { characterId }) => {
      if (isBusinessError(error, "swipe_already_recorded")) {
        void discoveryQuery.refetch();
        return;
      }
      setDismissedIds((previous) => {
        const next = new Set(previous);
        next.delete(characterId);
        return next;
      });
    },
  });

  const favoriteMutation = useMutation({
    mutationFn: async ({ characterId, isFavorite }: { characterId: string; isFavorite: boolean }) => {
      const { data, error } = await supabase.rpc("set_character_favorite", {
        _character_id: characterId,
        _is_favorite: isFavorite,
      });
      if (error) throw error;
      return data as FavoriteRpcResult;
    },
    onMutate: ({ characterId, isFavorite }) => {
      const hadOverride = Object.hasOwn(favoriteOverrides, characterId);
      const previousOverride = favoriteOverrides[characterId];
      setFavoriteOverrides((previous) => ({ ...previous, [characterId]: isFavorite }));
      return { characterId, hadOverride, previousOverride };
    },
    onError: (_error, _variables, context) => {
      if (!context) return;
      setFavoriteOverrides((previous) => {
        const next = { ...previous };
        if (context.hadOverride) next[context.characterId] = context.previousOverride;
        else delete next[context.characterId];
        return next;
      });
    },
  });

  const swipe = useCallback(
    (characterId: string, action: Swipe) => swipeMutation.mutateAsync({ characterId, swipe: action }),
    [swipeMutation],
  );

  const setFavorite = useCallback(
    (characterId: string, isFavorite: boolean) => favoriteMutation.mutateAsync({ characterId, isFavorite }),
    [favoriteMutation],
  );

  const isFavorite = useCallback(
    (characterId: string) => favoriteOverrides[characterId] ?? storedFavorites.get(characterId) ?? false,
    [favoriteOverrides, storedFavorites],
  );

  return {
    activeCharacter: visibleCharacters[0] ?? null,
    visibleCount: visibleCharacters.length,
    isFavorite,
    swipe,
    setFavorite,
    retry: discoveryQuery.refetch,
    loadMore: discoveryQuery.fetchNextPage,
    hasMore: Boolean(discoveryQuery.hasNextPage),
    isLoading: discoveryQuery.isLoading,
    isLoadingMore: discoveryQuery.isFetchingNextPage,
    isError: discoveryQuery.isError,
    isSwipePending: swipeMutation.isPending,
    isFavoritePending: favoriteMutation.isPending,
    error: discoveryQuery.error,
  };
}
