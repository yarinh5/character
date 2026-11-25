import type { QueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export const likedProfilesKey = (clientId: string) => ["client-liked-profiles", clientId] as const;

export async function refreshLikedProfiles(cache: QueryClient, clientId: string) {
  const target = { queryKey: likedProfilesKey(clientId), exact: true };
  // A first read in flight may predate the mutation and have no cached rows yet.
  await cache.cancelQueries(target);
  await cache.invalidateQueries(target);
}

export async function fetchLikedProfiles(clientId: string, signal: AbortSignal) {
  const { data, error } = await supabase
    .from("client_character_preferences")
    .select("client_id, character_id, liked_at, characters!inner(id, name)")
    .eq("client_id", clientId)
    .not("liked_at", "is", null)
    .eq("characters.is_active", true)
    .eq("characters.is_visible", true)
    .order("liked_at", { ascending: false })
    .abortSignal(signal);
  if (error) throw error;
  return data.map((row) => {
    if (
      row.client_id !== clientId ||
      !row.liked_at ||
      !row.characters?.name ||
      row.characters.id !== row.character_id
    )
      throw new Error("invalid_liked_profile");
    return row.characters;
  });
}
