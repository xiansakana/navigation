# Repository Guidelines

## Workspace Interaction Preferences

- Do not create or use Codex Canvas (`.canvas.tsx`) artifacts.
- For charts, dashboards, or interactive presentations, prefer inline conversation visualizations; otherwise use ordinary workspace files and summarize in chat.
- Do not link Canvas source files as deliverables.

## Project Structure & Module Organization

This repository contains several independently deployed Node.js services:

- `portal/`: navigation, authentication, reverse proxy, and RBAC.
- `stock-manage/`: portfolio management, real-market quotes, and quantitative analysis.
- `qqq-dip/`: QQQ dip monitoring and QQ notifications.
- `qq-bot/`: notification delivery service.
- `shared/`: shared database and portfolio adapters; changes here can affect multiple services.
- `scripts/`: ECS deployment, migration, backup, and maintenance scripts.
- `data/`: local runtime data; do not commit secrets or generated production data.

Application code is under each service's `src/`; browser assets are under `public/`; tests are colocated as `*.test.js` files.

## Build, Test, and Development Commands

Run commands from the target service directory:

```powershell
cd stock-manage; npm test       # unit and integration tests
cd qqq-dip; npm test            # monitoring and notification tests
cd qq-bot; npm test             # bot/configuration tests
npm start                       # start the current service
```

There is no repository-wide build step. Keep service-specific deployment scripts and `DEPLOY-ECS.md` in sync when deployment behavior changes.

## Local Development and ECS Deployment

- The local checkout is the primary editing and testing workspace. Before editing, inspect `git status` and classify existing changes; preserve unrelated work. Do not edit production source directly during normal development.
- Review `git diff`, test affected services, and commit only intentional code/docs locally. Do not leave task-related changes staged or uncommitted at handoff; report any pre-existing unrelated changes separately. Never commit `config.json`, secrets, SQLite databases, logs, uploads, or caches.
- Push the exact local commit to `origin/main` through Git. Prefer direct push when authenticated. If local GitHub transport is unavailable, push the commit to a non-checked-out incoming ref on ECS via SSH, have ECS push that ref to `origin/main`, verify the remote SHA, and then run a clean `git pull --ff-only` on ECS. Do not copy files with SCP or edit ECS working files as a substitute.
- Deploy only after ECS has pulled the verified SHA, using `scripts/ecs-update.sh --expected-sha <sha> --only <services>`; verify affected service health and production UI/API. Keep ECS clean and record the deployed commit.
- If any push, pull, SHA comparison, or clean-tree check fails, stop and diagnose; never reset or overwrite either checkout automatically. `scripts/ecs-deploy-from-local.ps1` is emergency-only and requires explicit authorization.

## Coding Style & Naming Conventions

Use two-space indentation, semicolons, single quotes, and ES modules for JavaScript. Prefer `camelCase` for functions and variables, `PascalCase` for classes/components, and descriptive kebab-case commit scopes. Keep browser code dependency-light and escape user-controlled values before inserting HTML. Reuse shared helpers and existing CSS variables instead of duplicating service behavior.

## Testing Guidelines

Tests use Node's built-in `node:test` and `node:assert/strict`. Name files `*.test.js` and place them beside the implementation. Add regression coverage for API fallbacks, persistence, calculations, and permission-sensitive behavior. Run the complete service test command before submitting changes; UI changes should also receive browser verification.

- Keep test fixtures independent of the host's free disk space and proxy environment. Provide explicit capacity/network fixtures while retaining rejection tests for low disk space and unauthorized access.
- Control animation frames and timers explicitly in UI tests. For asynchronous I/O, wait for an observable condition with a bounded elapsed-time deadline; a fixed number of `setImmediate` or microtask turns is not a timeout and does not prove a rendering timer ran.
- For intermittent CI failures, first reproduce the scheduling or environment dependency, then verify repeated targeted runs and the actual GitHub workflow on the fix commit. Do not hide failures with skipped tests, disabled checks, or automatic retries until green.
- Queue fixtures must follow the production ordering including timestamp tie breakers. Release held I/O before awaiting child-process shutdown, bound graceful shutdown with forced termination, and honor test cancellation so failed assertions cannot leave CI hanging.

## Shared Page Layout and Full-Width Verification

- Every new or changed Portal module page with a full-width control must use the shared layout contract: `body.portal-layout-enabled`, a main `[data-layout-container]`, `.navbar-layout-btn`, and the shared `portal.css` and `layout.js`. Proxied pages must use the Portal shell's shared layout behavior.
- Full-width mode must remove width limits from both the main content and navbar. Ensure later module/theme styles and media queries cannot restore a `max-width` cap. Keep button text and `aria-pressed` synchronized, including buttons with plain text and those containing `.label`.
- Verify actual rendered widths in a browser wider than the page's normal maximum: record the content and navbar widths before and after clicking, confirm both fill the available width in full-width mode, confirm toggling back restores the original width, and confirm a reload preserves the saved choice. A changed class, active button, or saved preference alone is not proof that the layout works.
- Include every new or affected module in the browser checks; do not validate only established pages. Restore the user's prior layout preference after verification. When changing shared layout assets, update cache versions in Portal pages and proxy injection together.

## Authorization & User Data

Every new page, menu, tab, or action button must define a permission in `portal/src/rbac.js` with a `permissionPath` matching its menu/page hierarchy. Enforce it in browser and API; hiding controls alone is insufficient. Persist user-specific feature data in shared SQLite keyed by the authenticated Portal `userId`. Do not use global JSON files or browser storage for multi-user state.

## Commit & Pull Request Guidelines

Follow the established imperative Conventional Commit style, such as `feat: ...`, `fix: ...`, or `revert: ...`. Keep commits focused. Pull requests should describe affected services, configuration or migration impact, test commands/results, deployment considerations, and include screenshots for UI changes. Never commit API keys, production `config.json`, databases, or runtime JSON.

## Unified Notification Configuration

- All new or changed notification features must configure channel switches, recipients, mentions, and test delivery in Notification Management → Business Alerts. Business modules only configure monitoring conditions and link to that central location; never add independent notification forms to toolbox or business pages. Preserve existing per-user notification settings and enforce separate view/save/test permissions.
