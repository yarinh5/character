import { useQuery } from "@tanstack/react-query";
import { FilterX } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import type { DiscoveryFilters } from "@/hooks/useDiscovery";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";

type DiscoveryCity = {
  id: string;
  display_name_he: string;
};

type DiscoveryFiltersProps = {
  filters: DiscoveryFilters;
  onChange: (filters: DiscoveryFilters) => void;
};

async function fetchAvailableCities() {
  const [{ data: cities, error: citiesError }, { count, error: charactersError }] = await Promise.all([
    supabase.from("discovery_cities").select("id, display_name_he").eq("is_active", true).order("display_name_he"),
    supabase
      .from("characters")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true)
      .eq("is_visible", true)
      .not("discovery_city_id", "is", null),
  ]);

  if (citiesError) throw citiesError;
  if (charactersError) throw charactersError;

  return {
    cities: (cities ?? []) as DiscoveryCity[],
    hasAssignedCharacters: (count ?? 0) > 0,
  };
}

export function DiscoveryFilters({ filters, onChange }: DiscoveryFiltersProps) {
  const citiesQuery = useQuery({
    queryKey: ["discovery-filter-cities"],
    queryFn: fetchAvailableCities,
  });
  const ageRange = [filters.min_age ?? 18, filters.max_age ?? 120];
  const hasAgeFilter = filters.min_age !== null || filters.max_age !== null;
  const showCityFilter = Boolean(citiesQuery.data?.hasAssignedCharacters && citiesQuery.data.cities.length > 0);
  const hasActiveFilters = hasAgeFilter || filters.city_id !== null;

  return (
    <section className="mb-6 border-y py-4" aria-label="סינון גילוי">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="discovery-age-range">טווח גיל</Label>
        {hasActiveFilters && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange({ min_age: null, max_age: null, city_id: null })}
          >
            <FilterX className="h-4 w-4" />
            נקה
          </Button>
        )}
      </div>
      <div className="mt-4 space-y-2">
        <Slider
          id="discovery-age-range"
          min={18}
          max={120}
          step={1}
          value={ageRange}
          onValueChange={([minAge, maxAge]) =>
            onChange({
              ...filters,
              min_age: minAge,
              max_age: maxAge,
            })
          }
          aria-label="טווח גיל"
        />
        <div className="flex justify-between text-sm text-muted-foreground">
          <span>{ageRange[0]}</span>
          <span>{ageRange[1]}</span>
        </div>
      </div>

      {showCityFilter && (
        <div className="mt-4 space-y-2">
          <Label htmlFor="discovery-city">עיר</Label>
          <Select
            value={filters.city_id ?? "all"}
            onValueChange={(cityId) => onChange({ ...filters, city_id: cityId === "all" ? null : cityId })}
          >
            <SelectTrigger id="discovery-city">
              <SelectValue placeholder="כל הערים" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">כל הערים</SelectItem>
              {citiesQuery.data?.cities.map((city) => (
                <SelectItem key={city.id} value={city.id}>
                  {city.display_name_he}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </section>
  );
}
