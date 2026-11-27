import { useLayoutEffect, useRef, useState } from "react";
import { onlineManager, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { DiscoveryCharacterWithFilters } from "./useDiscovery";
import { refreshLikedProfiles } from "@/lib/clientLikedProfiles";

type State = "idle" | "pending" | "denied" | "reconciled" | "unknown";

async function readOwnLike(clientId: string, characterId: string) {
  const { data, error } = await supabase
    .from("client_character_preferences")
    .select("client_id,character_id,liked_at")
    .eq("client_id", clientId)
    .eq("character_id", characterId)
    .maybeSingle();
  if (error) throw error;
  if (data === null) return false;
  if (
    data.client_id !== clientId ||
    data.character_id !== characterId ||
    (data.liked_at !== null && typeof data.liked_at !== "string")
  ) {
    throw new Error("invalid_like_read");
  }
  return data.liked_at !== null;
}

export function useRemoveCharacterLike(
  clientId: string | undefined,
  card: DiscoveryCharacterWithFilters | null,
) {
  const cache = useQueryClient();
  const request = useRef<symbol | null>(null);
  const [state, setState] = useState<State>("idle");
  useLayoutEffect(() => {
    setState("idle");
    return () => {
      request.current = null;
    };
  }, [clientId]);

  const removeLike = async () => {
    if (!clientId || !card?.is_liked || request.current) return;
    const characterId = card.id;
    const token = Symbol();
    request.current = token;
    const current = () => request.current === token;
    const sameSession = async () => {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      return current() && data.session?.user.id === clientId;
    };
    let outcome: State = "denied";
    setState("pending");
    try {
      if (!onlineManager.isOnline()) return;
      if (!(await sameSession()) || !current()) {
        outcome = "idle";
        return;
      }
      if (!onlineManager.isOnline()) return;
      let liked = false;
      let confirmed = false;
      try {
        const { data, error } = await supabase.rpc("remove_character_like", {
          _character_id: characterId,
          _expected_subject: clientId,
        });
        if (!current()) return;
        if (error?.code === "42501" || error?.code === "P0001") {
          if (!(await sameSession())) outcome = "idle";
          return;
        }
        confirmed =
          !error &&
          !!data &&
          typeof data === "object" &&
          !Array.isArray(data) &&
          data.character_id === characterId &&
          data.is_liked === false &&
          typeof data.idempotent === "boolean";
      } catch {
        // A lost reply does not establish whether the POST committed.
      }
      outcome = "unknown";
      if (!current() || !(await sameSession())) {
        outcome = "idle";
        return;
      }
      if (!confirmed) {
        liked = await readOwnLike(clientId, characterId);
        if (!current() || !(await sameSession())) {
          outcome = "idle";
          return;
        }
      }

      const cards = { queryKey: ["discovery-card", clientId] };
      // An in-flight first read has no card ID yet. Cancel across this viewer's filters.
      await cache.cancelQueries(cards);
      if (!current()) return;
      cache.setQueriesData<DiscoveryCharacterWithFilters | null>(cards, (entry) =>
        entry?.id === characterId ? { ...entry, is_liked: liked } : undefined,
      );
      void cache.invalidateQueries({ ...cards, refetchType: "none" });
      void cache.refetchQueries({
        ...cards,
        type: "active",
        predicate: (q) => q.state.data === undefined,
      });
      void cache.invalidateQueries({ queryKey: ["favorites", clientId], refetchType: "none" });
      void refreshLikedProfiles(cache, clientId);
      outcome = confirmed ? "idle" : "reconciled";
    } catch {
      // Keep the last verified cache. Distinguish preflight failure from unknown delivery.
      if (current() && outcome === "unknown") void refreshLikedProfiles(cache, clientId);
    } finally {
      if (current()) {
        request.current = null;
        setState(outcome);
      }
    }
  };

  const removeLikeError =
    state === "denied"
      ? "לא הצלחנו להסיר את הלייק. אפשר לנסות שוב."
      : state === "reconciled"
        ? "לא התקבל אישור להסרת הלייק. המצב המוצג נבדק מחדש."
        : state === "unknown"
          ? "לא ניתן היה לאשר את הסרת הלייק או לרענן את המצב."
          : null;
  return { removeLike, removeLikeError, isRemoveLikePending: state === "pending" };
}
