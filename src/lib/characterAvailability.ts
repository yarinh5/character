import { supabase } from "@/integrations/supabase/client";

export type CharacterAvailability = "available" | "busy" | "offline";

type LiveAvailabilityRow = {
  character_id: string;
  availability_status: CharacterAvailability;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_AVAILABILITY = new Set<CharacterAvailability>(["available", "busy", "offline"]);

function parseLiveAvailabilityRows(data: unknown, requestedIds: Set<string>) {
  if (!Array.isArray(data)) throw new Error("invalid_character_availability_response");
  const result = new Map<string, CharacterAvailability>();
  for (const value of data) {
    if (typeof value !== "object" || value === null) {
      throw new Error("invalid_character_availability_response");
    }
    const row = value as Record<string, unknown>;
    if (
      typeof row.character_id !== "string" ||
      !UUID_PATTERN.test(row.character_id) ||
      !requestedIds.has(row.character_id) ||
      typeof row.availability_status !== "string" ||
      !VALID_AVAILABILITY.has(row.availability_status as CharacterAvailability) ||
      result.has(row.character_id)
    ) {
      throw new Error("invalid_character_availability_response");
    }
    result.set(row.character_id, row.availability_status as CharacterAvailability);
  }
  if (result.size !== requestedIds.size) {
    throw new Error("incomplete_character_availability_response");
  }
  return result;
}

export async function fetchCharacterLiveAvailability(characterIds: string[]) {
  const uniqueIds = [...new Set(characterIds)];
  if (uniqueIds.length === 0) return new Map<string, CharacterAvailability>();
  if (uniqueIds.length > 100 || uniqueIds.some((id) => !UUID_PATTERN.test(id))) {
    throw new Error("invalid_character_availability_request");
  }

  const { data, error } = await supabase.rpc("get_character_live_availability", {
    _character_ids: uniqueIds,
  });
  if (error) throw error;
  return parseLiveAvailabilityRows(data as LiveAvailabilityRow[] | null, new Set(uniqueIds));
}
