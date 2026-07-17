import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

type DiscoveryCharacter = Database["public"]["Functions"]["get_discovery_characters"]["Returns"][number];
type Swipe = "like" | "pass";
type DismissedCard = Pick<DiscoveryCharacter, "id" | "cycle_id">;
type FavoriteMutationContext = { previousValue: boolean | undefined };
type SwipeMutationContext = { previousDismissedCard: DismissedCard | null };

function isBusinessError(error: unknown, code: string) {
  return typeof error === "object" && error !== null && "message" in error && String(error.message).includes(code);
}

async function fetchDiscoveryCharacter(): Promise<DiscoveryCharacter | null> {
  const { data, error } = await supabase.rpc("get_discovery_characters");
  if (error) throw error;
  return data?.[0] ?? null;
}

export function useDiscovery(userId?: string) {
  const queryClient = useQueryClient();
  const [dismissedCard, setDismissedCard] = useState<DismissedCard | null>(null);
  const [favoriteOverride, setFavoriteOverride] = useState<boolean | undefined>();
  const queryKey = ["discovery-card", userId] as const;

  const discoveryQuery = useQuery({
    queryKey,
    enabled: Boolean(userId),
    queryFn: fetchDiscoveryCharacter,
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
  }, [userId]);

  useEffect(() => {
    if (!fetchedCharacter) return;
    setFavoriteOverride(undefined);
  }, [fetchedCharacter?.cycle_id, fetchedCharacter?.id]);

  const swipeMutation = useMutation({
    mutationFn: async ({ characterId, swipe }: { characterId: string; swipe: Swipe }) => {
      const { data, error } = await supabase.rpc("set_character_swipe", {
        _character_id: characterId,
        _swipe: swipe,
      });
      if (error) throw error;
      return data;
    },
    onMutate: ({ characterId }): SwipeMutationContext => {
      const previousDismissedCard = dismissedCard;
      if (fetchedCharacter?.id === characterId) {
        setDismissedCard({ id: fetchedCharacter.id, cycle_id: fetchedCharacter.cycle_id });
      }
      return { previousDismissedCard };
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
    onError: (error, _variables, context) => {
      if (isBusinessError(error, "character_not_available")) {
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
    onError: (_error, _variables, context) => {
      setFavoriteOverride(context?.previousValue);
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
