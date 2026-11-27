import {
  assertRestoredMigrationVersions,
  loadApprovedRestoreMigrationVersions,
} from "../upgrades/wp01-shadow-113-to-116.mjs";
import { expectedMigrationVersionsFromSource } from "../upgrades/wp01-strict-send-116-to-117.mjs";

export function assertConcurrencyMigrationVersions(applied) {
  // The service lane requires its run root independently of RUN_EVIDENCE.
  // Missing or invalid Product evidence must never select the standalone path.
  const expected = Object.hasOwn(process.env, "INTEGRATION_RUN_ROOT")
    ? loadApprovedRestoreMigrationVersions()
    : expectedMigrationVersionsFromSource();
  assertRestoredMigrationVersions(applied, expected);
}
