# WP11 — Existing Client Management Workspace

## Scope and baseline

- Baseline: `9e490ecec5f3fa8e34145073973fbe864ba735b6` (`origin/main`, including the approved WP11 Operator merge).
- Branch: `codex/wp11-client-workspace`; isolated worktree `wp11-client-workspace/character`.
- KEEP: `/admin/clients`, the existing visual system, name/email search, filters, archived-only mode, conversation and credit links, and all current management endpoints and payload contracts.
- MODIFY/EXTEND: authenticated admin lifecycle, identity-scoped query keys, list/detail read states, edit loading/draft/save lifecycle, and late-completion guards.
- NEW: focused workspace/editing component suites and this progress record. REMOVE: none.
- WP01.5 remains OPEN/PAUSED and was not opened, executed or changed.

## Implemented behavior

- Reads start only after Auth initialization confirms `role=admin` and matching session/user IDs. Admin replacement, logout, mismatch or role loss remounts the workspace, closes dialogs and prevents old cache or late callbacks from appearing in the next identity.
- List keys are `admin + archived-only mode`; detail keys preserve the external prefix `['admin-client-details', clientId]` and append the admin identity.
- The loaded list distinguishes initial loading/error, true empty, filtered no-results, background refresh and cached refresh failure. A failed refresh keeps rows visible with one bounded retry warning that clears on recovery. Counts describe only returned rows.
- Detail reads distinguish initial error, missing profile, cached refresh failure and recovery. Missing server profile data is not replaced with list enrichment for sensitive actions. Conversation links, wallet, transactions and timeline remain intact.
- Edit waits for verified profile and client-profile data. A draft is initialized once per opening/client identity, survives refetch failures, and is discarded when the dialog/client/admin identity changes.
- Save sends only changed optional fields, preserving untouched `null` and legacy values. Client-side validation mirrors the existing server contract: display name 1–120, integer age 18–120 or null, gender 80, up to 30 interests of 60 characters, and preferences 1000.
- Synchronous double-submit is blocked before rerender. A returned `{ ok: true }` is required for success; mutation failure preserves the draft. A successful mutation is not relabeled as failed if subsequent invalidation/refetch fails.
- Existing status, credit, archive, PII archive, restore, promotion and reset flows retain their endpoints, payloads and confirmations. Local busy/identity guards suppress late UI side effects. Clipboard failure is reported and never produces a false “copied” success.

## Verification evidence

- Clean baseline full Vitest: `263 passed / 24 skipped` (`17 passed / 6 skipped` files). Existing jsdom document-navigation notice remained non-failing.
- TDD RED 1: `9/9` focused tests failed on the unmodified route for the intended missing behaviors (Auth gate, read states, edit loading/draft, changed-only payload, double-submit and late completion).
- GREEN 1: `9/9` focused tests passed.
- TDD RED 2: the clipboard regression failed because the old code swallowed clipboard rejection and emitted success; the other 12 focused tests passed.
- GREEN 2: `13/13` focused tests passed.
- Required focused regression command: `58/58` passed across client workspace/editing, reports workflow and operator workspace.
- Final verification on the delivery snapshot: format, changed-file lint and typecheck passed; the required focused command passed `58/58` tests; full Vitest passed `277` tests with `24` existing skips (`19` passed / `6` skipped files); and the client/SSR production build passed.
- Existing non-failing notices remained visible: jsdom document navigation, Node `punycode` deprecation and the Vite chunk-size advisory. No assertion, skip, timeout or dependency setting was changed to obtain a pass.

## Boundaries and remaining acceptance

- `adminGetClientDetails` remains server-limited: 12 conversations, 20 credit transactions and 80 merged timeline events. These are recent bounded windows, not complete history or aggregation.
- List wallet/conversation enrichment and some timeline sources do not expose independent partial-source errors; the UI does not infer unavailable data the server contract does not provide.
- The existing profile and client-profile writes are not one transaction. A transport failure does not prove that the server made no partial change; the UI performs no automatic write retry.
- No client-profile row is created when it is missing, and the UI does not promise edits for absent fields.
- Browser RTL/mobile/desktop: **NOT VERIFIED**. No new browser harness was created.
- Live Auth/Supabase/RLS integration: **NOT VERIFIED**. Component tests use real screen/dialog/query behavior with mocked external I/O and do not prove server authorization.
- Backend, schema, migrations, RLS, RPCs, dependencies, lockfile and route tree: unchanged. Local/QA/Production application and deploy: not executed.
- Dependency installation reported 42 vulnerabilities (2 low, 20 moderate, 14 high, 6 critical); remediation is outside this allowlist.
- WP11 as a whole is not complete and no product-delivery claim is made. Browser and authorized live integration evidence remain separate gates.
