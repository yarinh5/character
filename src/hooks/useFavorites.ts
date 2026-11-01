import { useCallback, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

type Character = {
  id: string;
  name: string;
  avatar_url: string | null;
  fictional_age: number | null;
  short_description: string | null;
  category: string | null;
  interests: string[] | null;
  availability_status: "available" | "busy" | "offline";
};

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

type FavoriteResult = {
  character_id: string;
  is_favorite: boolean;
  idempotent: boolean;
};

export class AmbiguousFavoriteResultError extends Error {
  constructor() {
    super("favorite_result_requires_reconciliation");
    this.name = "AmbiguousFavoriteResultError";
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID_PATTERN.test(value);
const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";
const isNullableStringArray = (value: unknown): value is string[] | null =>
  value === null || (Array.isArray(value) && value.every((item) => typeof item === "string"));

function isCharacter(value: unknown): value is Character {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    isUuid(row.id) &&
    typeof row.name === "string" &&
    row.name.length > 0 &&
    isNullableString(row.avatar_url) &&
    (row.fictional_age === null ||
      (typeof row.fictional_age === "number" && Number.isFinite(row.fictional_age))) &&
    isNullableString(row.short_description) &&
    isNullableString(row.category) &&
    isNullableStringArray(row.interests) &&
    ["available", "busy", "offline"].includes(String(row.availability_status))
  );
}

function isPreference(value: unknown): value is FavoritePreferenceRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    isUuid(row.character_id) &&
    isNullableString(row.favorited_at) &&
    isNullableString(row.liked_at) &&
    isCharacter(row.characters) &&
    row.characters.id === row.character_id
  );
}

function parsePreferences(data: unknown): FavoritePreferenceRow[] {
  if (!Array.isArray(data) || !data.every(isPreference)) {
    throw new Error("invalid_favorites_response");
  }
  return data;
}

function parseConversationMap(data: unknown, characterIds: Set<string>) {
  if (!Array.isArray(data)) throw new Error("invalid_favorite_conversations_response");
  const map = new Map<string, string>();
  for (const value of data) {
    if (typeof value !== "object" || value === null) {
      throw new Error("invalid_favorite_conversations_response");
    }
    const row = value as Record<string, unknown>;
    if (!isUuid(row.id) || !isUuid(row.character_id) || !characterIds.has(row.character_id)) {
      throw new Error("invalid_favorite_conversations_response");
    }
    map.set(row.character_id, row.id);
  }
  return map;
}

function isFavoriteResult(
  value: unknown,
  characterId: string,
  isFavorite: boolean,
): value is FavoriteResult {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    row.character_id === characterId &&
    row.is_favorite === isFavorite &&
    typeof row.idempotent === "boolean"
  );
}

function isAmbiguousTransportFailure(error: unknown, status?: number) {
  if (status === 0 || error instanceof TypeError) return true;
  if (typeof error !== "object" || error === null || !("message" in error)) return false;
  return /failed to fetch|network|transport/i.test(String(error.message));
}

async function fetchFavorites(
  userId: string,
  isCurrent: () => boolean,
): Promise<FavoriteCharacter[]> {
  const { data: preferenceData, error: preferenceError } = await supabase
    .from("client_character_preferences")
    .select(
      "character_id, favorited_at, liked_at, characters!inner(id, name, avatar_url, fictional_age, short_description, category, interests, availability_status)",
    )
    .eq("is_favorite", true)
    .eq("characters.is_active", true)
    .eq("characters.is_visible", true)
    .order("favorited_at", { ascending: false, nullsFirst: false });
  if (!isCurrent()) throw new Error("stale_favorites_request");
  if (preferenceError) throw preferenceError;

  const preferences = parsePreferences(preferenceData ?? []);
  const characterIds = preferences.map((preference) => preference.character_id);
  if (characterIds.length === 0) return [];

  const { data: conversationData, error: conversationError } = await supabase
    .from("conversations")
    .select("id, character_id")
    .in("character_id", characterIds)
    .is("client_hidden_at", null)
    .neq("status", "closed");
  if (!isCurrent()) throw new Error("stale_favorites_request");
  if (conversationError) throw conversationError;

  const conversationIds = parseConversationMap(conversationData ?? [], new Set(characterIds));
  return preferences.map((preference) => ({
    ...preference.characters,
    favorited_at: preference.favorited_at,
    is_liked: preference.liked_at !== null,
    conversation_id: conversationIds.get(preference.character_id) ?? null,
  }));
}

export function useFavorites(userId?: string, identityGeneration = 0) {
  const queryClient = useQueryClient();
  const identityKey = userId ? `${userId}:${identityGeneration}` : undefined;
  const identityRef = useRef(identityKey);
  identityRef.current = identityKey;
  const mutationLockRef = useRef<{ identityKey: string; token: symbol } | null>(null);
  const [pendingCharacterId, setPendingCharacterId] = useState<string | null>(null);
  const [mutationRefreshFailed, setMutationRefreshFailed] = useState(false);
  const queryKey = ["favorites", userId, identityGeneration] as const;

  const favoritesQuery = useQuery({
    queryKey,
    enabled: Boolean(userId),
    queryFn: () => {
      const capturedUserId = userId;
      if (!capturedUserId) throw new Error("missing_favorites_identity");
      const capturedIdentityKey = identityKey;
      return fetchFavorites(capturedUserId, () => identityRef.current === capturedIdentityKey);
    },
  });

  const retry = useCallback(async () => {
    const result = await favoritesQuery.refetch();
    if (!result.isError) setMutationRefreshFailed(false);
    return result;
  }, [favoritesQuery]);

  const setFavorite = useCallback(
    async (characterId: string, isFavorite: boolean) => {
      if (!userId || !identityKey || mutationLockRef.current?.identityKey === identityKey) return;
      const token = Symbol("favorite");
      const capturedUserId = userId;
      const capturedQueryKey = ["favorites", capturedUserId, identityGeneration] as const;
      const capturedIdentityKey = identityKey;
      mutationLockRef.current = { identityKey: capturedIdentityKey, token };
      setPendingCharacterId(characterId);
      setMutationRefreshFailed(false);
      let previousFavorites: FavoriteCharacter[] | undefined;

      try {
        await queryClient.cancelQueries({ queryKey: capturedQueryKey });
        previousFavorites = queryClient.getQueryData<FavoriteCharacter[]>(capturedQueryKey);
        if (!isFavorite) {
          queryClient.setQueryData<FavoriteCharacter[]>(capturedQueryKey, (favorites) =>
            favorites?.filter((favorite) => favorite.id !== characterId),
          );
        }
        const result = await supabase.rpc("set_character_favorite", {
          _character_id: characterId,
          _is_favorite: isFavorite,
        });
        const isCurrent = identityRef.current === capturedIdentityKey;
        if (!isCurrent) throw new Error("stale_favorite_completion");
        if (result.error || !isFavoriteResult(result.data, characterId, isFavorite)) {
          const ambiguous =
            !result.error || isAmbiguousTransportFailure(result.error, result.status);
          if (!ambiguous) {
            queryClient.setQueryData(capturedQueryKey, previousFavorites);
            throw result.error;
          }
          await queryClient.invalidateQueries({ queryKey: capturedQueryKey });
          throw new AmbiguousFavoriteResultError();
        }

        await Promise.all([
          queryClient.invalidateQueries({ queryKey: capturedQueryKey }),
          queryClient.invalidateQueries({
            queryKey: ["character-profile", capturedUserId, characterId],
          }),
          queryClient.invalidateQueries({ queryKey: ["discovery-card", capturedUserId] }),
        ]);
        if (isCurrent) {
          setMutationRefreshFailed(queryClient.getQueryState(capturedQueryKey)?.status === "error");
        }
        return result.data;
      } catch (error) {
        if (
          identityRef.current === capturedIdentityKey &&
          !(error instanceof AmbiguousFavoriteResultError)
        ) {
          queryClient.setQueryData(capturedQueryKey, previousFavorites);
        }
        throw error;
      } finally {
        if (mutationLockRef.current?.token === token) mutationLockRef.current = null;
        if (identityRef.current === capturedIdentityKey) setPendingCharacterId(null);
      }
    },
    [identityKey, identityGeneration, queryClient, userId],
  );

  const favorites = userId ? (favoritesQuery.data ?? []) : [];
  return {
    favorites,
    isLoading: Boolean(userId) && favoritesQuery.isLoading,
    isRefreshing: favoritesQuery.isFetching && !favoritesQuery.isLoading,
    isError: favoritesQuery.isError || favoritesQuery.isRefetchError,
    isEmpty:
      Boolean(userId) &&
      !favoritesQuery.isLoading &&
      !favoritesQuery.isError &&
      favoritesQuery.data?.length === 0,
    isFavoritePending: pendingCharacterId !== null,
    pendingCharacterId,
    mutationRefreshFailed,
    retry,
    setFavorite,
    error: favoritesQuery.error,
  };
}
