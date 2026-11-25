# WP12 public entry mobile check (2026-11-25)

- Cause: direct browser measurement at 375px found 36px login inputs and submit button, a 20px password-help link, and 36-40px home calls to action. These fell below the 44px touch-target goal even though RTL, the hero gradient and horizontal overflow were correct.
- Change: public home and login interactive controls now have a 44px minimum height. No Auth, backend, protected-workspace, or product-package contract changed. Vitest now discovers `src` application tests only; Node's independent database and integration tests are not counted as Vitest passes.
- Verification: in a local Vite preview using a synthetic loopback-only Supabase URL, browser measurements at 375px found every visible home link/button and every login input/link/button at least 44px high. Neither page scrolled horizontally. Home `background-clip` remained `text` at 375px and 1280px. Desktop home had no visible link/button shorter than 44px. Focused public-entry tests, typecheck, lint, full `npm test` (680/680) and client/SSR build passed.
- Scope: this is public-entry browser evidence only. Registration, protected flows, keyboard journeys, disconnected states, live DB/HTTP/concurrency, migrations, load/recovery, and full Product acceptance remain unverified on this revision. The local preview uses no QA or Production credentials and does not establish a live service.

## 2026-11-26 current-branch spot check

- A temporary loopback Vite server with a synthetic Supabase URL and dummy public key rendered `/` and `/login` without the error boundary. It was stopped after the check; port 4187 was no longer listening.
- The in-app browser exposed a 530x901 viewport but no explicit viewport override. At that width, neither page had horizontal overflow; visible home and login links/buttons and both login inputs were at least 44px high. The home headline retained computed `background-clip: text`. Login had one H1, `name=email` / `autocomplete=email`, and `name=password` / `autocomplete=current-password`.
- This does not repeat the earlier exact 375px measurement on the current branch. No persistent screenshot artifact was saved. Registration, protected routes and live Auth remain unverified.
