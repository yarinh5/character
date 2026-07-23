import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type OperatorOnlineCharacterOption = {
  character_id: string;
  character_name: string;
  character_avatar_url: string | null;
};

export type OperatorOnlineCandidate = {
  client_id: string;
  display_name: string;
  avatar_url: string | null;
  has_existing_conversation: boolean;
  character_options: OperatorOnlineCharacterOption[];
};

function parseCharacterOptions(value: unknown): OperatorOnlineCharacterOption[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((option) => {
    if (!option || typeof option !== "object") return [];
    const candidate = option as Record<string, unknown>;
    if (typeof candidate.character_id !== "string" || typeof candidate.character_name !== "string") return [];

    return [{
      character_id: candidate.character_id,
      character_name: candidate.character_name,
      character_avatar_url: typeof candidate.character_avatar_url === "string" ? candidate.character_avatar_url : null,
    }];
  });
}

export function useOperatorOnlineCandidates(filters: { search: string; characterId: string | null }) {
  const search = filters.search.trim();

  return useQuery({
    queryKey: ["operator-online-candidates", search, filters.characterId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_operator_online_candidates", {
        _filters: {
          limit: 50,
          ...(search ? { search } : {}),
          ...(filters.characterId ? { character_id: filters.characterId } : {}),
        },
      });
      if (error) throw error;

      return (data ?? []).map((candidate) => ({
        ...candidate,
        character_options: parseCharacterOptions(candidate.character_options),
      })) as OperatorOnlineCandidate[];
    },
    refetchInterval: 30_000,
    refetchIntervalInBackground: true,
  });
}
