import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

type Character = Pick<
  Database["public"]["Tables"]["characters"]["Row"],
  | "id"
  | "name"
  | "avatar_url"
  | "fictional_age"
  | "short_description"
  | "category"
  | "interests"
  | "availability_status"
>;

type FavoritePreferenceRow = {
  character_id: string;
  favorited_at: string | null;
  liked_at: string | null;
  characters: Character;
};

export type FavoriteCharacter = Character & {
  favorited_at: string | null;
  is_liked: boolean;
  conversation_id: string | null;
};

async function fetchFavorites(): Promise<FavoriteCharacter[]> {
  const { data: preferenceData, error: preferenceError } = await supabase
    .from("client_character_preferences")
    .select(
      "character_id, favorited_at, liked_at, characters!inner(id, name, avatar_url, fictional_age, short_description, category, interests, availability_status)",
    )
    .eq("is_favorite", true)
    .eq("characters.is_active", true)
    .eq("characters.is_visible", true)
    .order("favorited_at", { ascending: false, nullsFirst: false });

  if (preferenceError) throw preferenceError;

  const preferences = (preferenceData ?? []) as unknown as FavoritePreferenceRow[];
  const characterIds = preferences.map((preference) => preference.character_id);

  if (characterIds.length === 0) return [];

  const { data: conversationData, error: conversationError } = await supabase
    .from("conversations")
    .select("id, character_id")
    .in("character_id", characterIds)
    .is("client_hidden_at", null)
    .neq("status", "closed");

  if (conversationError) throw conversationError;

  const conversationIds = new Map((conversationData ?? []).map((conversation) => [conversation.character_id, conversation.id]));

  return preferences.map((preference) => ({
    ...preference.characters,
    favorited_at: preference.favorited_at,
    is_liked: preference.liked_at !== null,
    conversation_id: conversationIds.get(preference.character_id) ?? null,
  }));
}

export function useFavorites(userId?: string) {
  const queryClient = useQueryClient();
  const queryKey = ["favorites", userId] as const;

  const favoritesQuery = useQuery({
    queryKey,
    enabled: Boolean(userId),
    queryFn: fetchFavorites,
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
    onMutate: async ({ characterId, isFavorite }) => {
      await queryClient.cancelQueries({ queryKey });
      const previousFavorites = queryClient.getQueryData<FavoriteCharacter[]>(queryKey);

      if (!isFavorite) {
        queryClient.setQueryData<FavoriteCharacter[]>(queryKey, (favorites) =>
          favorites?.filter((favorite) => favorite.id !== characterId),
        );
      }

      return { previousFavorites };
    },
    onError: (_error, _variables, context) => {
      queryClient.setQueryData(queryKey, context?.previousFavorites);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
      void queryClient.invalidateQueries({ queryKey: ["discovery-card", userId] });
    },
  });

  const setFavorite = useCallback(
    (characterId: string, isFavorite: boolean) => favoriteMutation.mutateAsync({ characterId, isFavorite }),
    [favoriteMutation],
  );

  return {
    favorites: favoritesQuery.data ?? [],
    isLoading: favoritesQuery.isLoading,
    isRefreshing: favoritesQuery.isFetching && !favoritesQuery.isLoading,
    isError: favoritesQuery.isError,
    isEmpty: !favoritesQuery.isLoading && !favoritesQuery.isError && favoritesQuery.data?.length === 0,
    isFavoritePending: favoriteMutation.isPending,
    pendingCharacterId: favoriteMutation.variables?.characterId ?? null,
    retry: favoritesQuery.refetch,
    setFavorite,
    error: favoritesQuery.error,
  };
}
