import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Database, Json } from "@/integrations/supabase/types";

type DiscoveryCharacter = Database["public"]["Functions"]["get_discovery_characters"]["Returns"][number];
export type DiscoveryFilters = {
  min_age: number | null;
  max_age: number | null;
  city_id: string | null;
  favorites_only: boolean;
  recycled_only: boolean;
  interest: string | null;
};

type DiscoveryRpcFilters = {
  min_age?: number;
  max_age?: number;
  city_id?: string;
  favorites_only: boolean;
  recycled_only: boolean;
  interest?: string;
};
export type DiscoveryCharacterWithFilters = DiscoveryCharacter & {
  filtersSnapshot: DiscoveryRpcFilters;
};
type Swipe = "like" | "pass";
type DismissedCard = Pick<DiscoveryCharacterWithFilters, "id" | "cycle_id">;
type FavoriteMutationContext = { previousValue: boolean | undefined };
type SwipeMutationContext = { previousDismissedCard: DismissedCard | null };

export const EMPTY_DISCOVERY_FILTERS: DiscoveryFilters = {
  min_age: null,
  max_age: null,
  city_id: null,
  favorites_only: false,
  recycled_only: false,
  interest: null,
};

function isBusinessError(error: unknown, code: string) {
  return typeof error === "object" && error !== null && "message" in error && String(error.message).includes(code);
}

function serializeDiscoveryFilters(filters: DiscoveryFilters): DiscoveryRpcFilters {
  const payload: DiscoveryRpcFilters = {
    favorites_only: filters.favorites_only,
    recycled_only: filters.recycled_only,
  };

  if (filters.min_age !== null) payload.min_age = filters.min_age;
  if (filters.max_age !== null) payload.max_age = filters.max_age;
  if (filters.city_id !== null) payload.city_id = filters.city_id;
  if (filters.interest !== null) payload.interest = filters.interest;

  return payload;
}

async function fetchDiscoveryCharacter(filtersSnapshot: DiscoveryRpcFilters): Promise<DiscoveryCharacterWithFilters | null> {
  const { data, error } = await supabase.rpc("get_discovery_characters", {
    _filters: filtersSnapshot as Json,
  });
  if (error) throw error;

  const character = data?.[0] ?? null;
  return character ? { ...character, filtersSnapshot } : null;
}

export function useDiscovery(userId?: string, filters: DiscoveryFilters = EMPTY_DISCOVERY_FILTERS) {
  const queryClient = useQueryClient();
  const [dismissedCard, setDismissedCard] = useState<DismissedCard | null>(null);
  const [favoriteOverride, setFavoriteOverride] = useState<boolean | undefined>();
  const filtersSnapshot = useMemo(
    () => serializeDiscoveryFilters(filters),
    [filters.city_id, filters.favorites_only, filters.interest, filters.max_age, filters.min_age, filters.recycled_only],
  );
  const filtersKey = JSON.stringify(filtersSnapshot);
  const queryKey = ["discovery-card", userId, filtersKey] as const;

  const discoveryQuery = useQuery({
    queryKey,
    enabled: Boolean(userId),
    queryFn: () => fetchDiscoveryCharacter(filtersSnapshot),
  });

  const fetchedCharacter = discoveryQuery.data ?? null;
  const activeCharacter =
    fetchedCharacter &&
    !(dismissedCard?.id === fetchedCharacter.id && dismissedCard.cycle_id === fetchedCharacter.cycle_id)
      ? fetchedCharacter
      : null;

  useEffect(() => {
    setDismissedCard(null);
    setFavoriteOverride(undefined);
  }, [filtersKey, userId]);

  useEffect(() => {
    if (!fetchedCharacter) return;
    setFavoriteOverride(undefined);
  }, [fetchedCharacter?.cycle_id, fetchedCharacter?.id]);

  const swipeMutation = useMutation({
    mutationFn: async ({ character, swipe }: { character: DiscoveryCharacterWithFilters; swipe: Swipe }) => {
      const { data, error } = await supabase.rpc("set_character_swipe", {
        _character_id: character.id,
        _cycle_id: character.cycle_id,
        _filters: character.filtersSnapshot as Json,
        _swipe: swipe,
      });
      if (error) throw error;
      return data;
    },
    onMutate: ({ character }): SwipeMutationContext => {
      const previousDismissedCard = dismissedCard;
      if (fetchedCharacter?.id === character.id && fetchedCharacter.cycle_id === character.cycle_id) {
        setDismissedCard({ id: fetchedCharacter.id, cycle_id: fetchedCharacter.cycle_id });
      }
      return { previousDismissedCard };
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
    onError: (error, _variables, context) => {
      if (
        isBusinessError(error, "character_not_available") ||
        isBusinessError(error, "stale_discovery_cycle") ||
        isBusinessError(error, "character_not_in_open_cycle")
      ) {
        void queryClient.invalidateQueries({ queryKey });
        return;
      }
      setDismissedCard(context?.previousDismissedCard ?? null);
    },
  });

  const favoriteMutation = useMutation({
    mutationFn: async ({ characterId, isFavorite }: { characterId: string; isFavorite: boolean }) => {
      const { data, error } = await supabase.rpc("set_character_favorite", {
        _character_id: characterId,
        _is_favorite: isFavorite,
      });
      if (error) throw error;
      return data;
    },
    onMutate: ({ isFavorite }): FavoriteMutationContext => {
      const previousValue = favoriteOverride;
      setFavoriteOverride(isFavorite);
      return { previousValue };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["favorites", userId] });
    },
    onError: (_error, _variables, context) => {
      setFavoriteOverride(context?.previousValue);
    },
  });

  const swipe = useCallback(
    (character: DiscoveryCharacterWithFilters, action: Swipe) => swipeMutation.mutateAsync({ character, swipe: action }),
    [swipeMutation],
  );

  const setFavorite = useCallback(
    (characterId: string, isFavorite: boolean) => favoriteMutation.mutateAsync({ characterId, isFavorite }),
    [favoriteMutation],
  );

  return {
    activeCharacter,
    isFavorite: favoriteOverride ?? activeCharacter?.is_favorite ?? false,
    retry: discoveryQuery.refetch,
    isLoading: discoveryQuery.isLoading,
    isRefreshing: discoveryQuery.isFetching && !discoveryQuery.isLoading,
    isError: discoveryQuery.isError,
    isEmpty: !discoveryQuery.isLoading && !discoveryQuery.isError && fetchedCharacter === null,
    isSwipePending: swipeMutation.isPending,
    isFavoritePending: favoriteMutation.isPending,
    swipe,
    setFavorite,
    error: discoveryQuery.error,
  };
}
