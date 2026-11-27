-- The v3 writer clears all legacy hours. support_windows_shape still pairs a
-- configured timezone with valid windows and a non-null closure array.
ALTER TABLE private.support_operations_config
  DROP CONSTRAINT support_schedule_all_or_none,
  ADD CONSTRAINT support_schedule_all_or_none CHECK (
    (support_weekdays IS NULL AND support_day_start IS NULL AND support_day_end IS NULL
      AND (support_timezone IS NULL
        OR (support_timezone <> '' AND support_timezone = btrim(support_timezone))))
    OR
    (support_timezone IS NOT NULL AND support_weekdays IS NOT NULL
      AND cardinality(support_weekdays) > 0
      AND support_weekdays <@ ARRAY[0,1,2,3,4,5,6]::SMALLINT[]
      AND support_day_start IS NOT NULL AND support_day_end IS NOT NULL
      AND support_day_start < support_day_end)
  );
