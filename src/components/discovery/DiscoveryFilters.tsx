import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { FilterX } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import type { DiscoveryFilters } from "@/hooks/useDiscovery";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";

type DiscoveryCity = {
  id: string;
  display_name_he: string;
};

type DiscoveryFilterData = {
  cities: DiscoveryCity[];
  interests: string[];
};

type DiscoveryFiltersProps = {
  filters: DiscoveryFilters;
  onChange: (filters: DiscoveryFilters) => void;
};

const AGE_MIN = 18;
const AGE_MAX = 80;

async function fetchAvailableCities() {
  const [{ data: cities, error: citiesError }, { data: characters, error: charactersError }] = await Promise.all([
    supabase.from("discovery_cities").select("id, display_name_he").eq("is_active", true).order("display_name_he"),
    supabase
      .from("characters")
      .select("interests, discovery_city_id")
      .eq("is_active", true)
      .eq("is_visible", true),
  ]);

  if (citiesError) throw citiesError;
  if (charactersError) throw charactersError;

  const assignedCityIds = new Set(
    (characters ?? []).map((character) => character.discovery_city_id).filter((cityId): cityId is string => Boolean(cityId)),
  );
  const interests = Array.from(
    new Set(
      (characters ?? []).flatMap((character) =>
        (character.interests ?? []).map((interest) => interest.trim()).filter(Boolean),
      ),
    ),
  ).sort((a, b) => a.localeCompare(b, "he"));

  return {
    cities: ((cities ?? []) as DiscoveryCity[]).filter((city) => assignedCityIds.has(city.id)),
    interests,
  } satisfies DiscoveryFilterData;
}

export function DiscoveryFilters({ filters, onChange }: DiscoveryFiltersProps) {
  const citiesQuery = useQuery({
    queryKey: ["discovery-filter-cities"],
    queryFn: fetchAvailableCities,
  });
  const ageRange: [number, number] = [
    Math.min(Math.max(filters.min_age ?? AGE_MIN, AGE_MIN), AGE_MAX),
    Math.min(Math.max(filters.max_age ?? AGE_MAX, AGE_MIN), AGE_MAX),
  ];
  const hasAgeFilter = filters.min_age !== null || filters.max_age !== null;
  const ageRangeLabel = !hasAgeFilter
    ? "כל הגילים"
    : `גיל ${ageRange[0]}-${ageRange[1]}${ageRange[1] === AGE_MAX ? "+" : ""}`;
  const showCityFilter = Boolean(citiesQuery.data?.cities.length);
  const showInterestFilter = Boolean(citiesQuery.data?.interests.length);
  const hasActiveFilters =
    hasAgeFilter ||
    filters.city_id !== null ||
    filters.favorites_only ||
    filters.recycled_only ||
    filters.interest !== null;

  useEffect(() => {
    if (!citiesQuery.data) return;

    const cityIsAvailable = !filters.city_id || citiesQuery.data.cities.some((city) => city.id === filters.city_id);
    const interestIsAvailable = !filters.interest || citiesQuery.data.interests.includes(filters.interest);
    if (cityIsAvailable && interestIsAvailable) return;

    onChange({
      ...filters,
      city_id: cityIsAvailable ? filters.city_id : null,
      interest: interestIsAvailable ? filters.interest : null,
    });
  }, [citiesQuery.data, filters, onChange]);

  return (
    <section className="mb-6 border-y py-4" aria-label="סינון גילוי">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <Label htmlFor="discovery-age-range">טווח גיל</Label>
          <span className={hasAgeFilter ? "text-sm font-medium text-foreground" : "text-sm text-muted-foreground"}>
            {ageRangeLabel}
          </span>
        </div>
        {hasActiveFilters && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() =>
              onChange({
                min_age: null,
                max_age: null,
                city_id: null,
                favorites_only: false,
                recycled_only: false,
                interest: null,
              })
            }
          >
            <FilterX className="h-4 w-4" />
            נקה
          </Button>
        )}
      </div>
      <div className="mt-3 rounded-md border bg-muted/30 px-4 py-3">
        <Slider
          id="discovery-age-range"
          min={AGE_MIN}
          max={AGE_MAX}
          step={1}
          minStepsBetweenThumbs={1}
          dir="ltr"
          value={ageRange}
          onValueChange={([firstValue = AGE_MIN, secondValue = AGE_MAX]) => {
            const minAge = Math.min(firstValue, secondValue);
            const maxAge = Math.max(firstValue, secondValue);
            onChange({
              ...filters,
              min_age: minAge === AGE_MIN && maxAge === AGE_MAX ? null : minAge,
              max_age: minAge === AGE_MIN && maxAge === AGE_MAX ? null : maxAge,
            });
          }}
          aria-label="טווח גיל"
        />
        <div className="mt-2 flex justify-between text-sm text-muted-foreground" dir="ltr">
          <span>{AGE_MIN}</span>
          <span>{AGE_MAX}+</span>
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

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {showInterestFilter && (
          <div className="space-y-2">
          <Label htmlFor="discovery-interest">תחום עניין</Label>
          <Select
            value={filters.interest ?? "all"}
            onValueChange={(interest) => onChange({ ...filters, interest: interest === "all" ? null : interest })}
          >
            <SelectTrigger id="discovery-interest">
              <SelectValue placeholder="כל תחומי העניין" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">כל תחומי העניין</SelectItem>
              {citiesQuery.data?.interests.map((interest) => (
                <SelectItem key={interest} value={interest}>
                  {interest}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="discovery-recycled">הצגה</Label>
          <Select
            value={filters.recycled_only ? "recycled" : "all"}
            onValueChange={(value) => onChange({ ...filters, recycled_only: value === "recycled" })}
          >
            <SelectTrigger id="discovery-recycled">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">כל הדמויות</SelectItem>
              <SelectItem value="recycled">מדמויות שנצפו בעבר</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <label className="mt-4 flex w-fit cursor-pointer items-center gap-2 text-sm font-medium">
        <Checkbox
          checked={filters.favorites_only}
          onCheckedChange={(checked) => onChange({ ...filters, favorites_only: checked === true })}
        />
        מועדפים בלבד
      </label>
    </section>
  );
}
