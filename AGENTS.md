# Repository Guidelines

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

## Production Deployment

- Deploy through Git only: test, commit the intended files, push the commit to `origin/main`, then run `/opt/navigation/scripts/ecs-update.sh --expected-sha <pushed-commit> --only <affected-services>` on ECS. A successful push is required before any server pull or restart.
- Confirm the ECS checkout is clean before pulling, use a fast-forward-only pull, and verify both ECS `HEAD` and the pushed commit match. Verify service health and the production UI/API after restart. Only committed files are covered by the revision match; never describe unrelated local uncommitted files as deployed.
- If push, pull, revision verification, or the clean-checkout check fails, stop and report the blocker. Do not fall back to SCP, `--skip-pull`, or copying local files for a normal deployment. Do not reset, discard, or overwrite ECS changes to make a pull succeed; reconcile them separately with user approval.
- `scripts/ecs-deploy-from-local.ps1` is an emergency-only legacy tool, not a normal deployment path. Use it only if the user explicitly authorizes an exception and understands that Git revision parity will not be guaranteed.

## Coding Style & Naming Conventions

Use two-space indentation, semicolons, single quotes, and ES modules for JavaScript. Prefer `camelCase` for functions and variables, `PascalCase` for classes/components, and descriptive kebab-case commit scopes. Keep browser code dependency-light and escape user-controlled values before inserting HTML. Reuse shared helpers and existing CSS variables instead of duplicating service behavior.

## Testing Guidelines

Tests use Node's built-in `node:test` and `node:assert/strict`. Name files `*.test.js` and place them beside the implementation. Add regression coverage for API fallbacks, persistence, calculations, and permission-sensitive behavior. Run the complete service test command before submitting changes; UI changes should also receive browser verification.

## Authorization & User Data

Every new page, menu, tab, or action button must define a permission in `portal/src/rbac.js` with a `permissionPath` matching its menu/page hierarchy. Enforce it in browser and API; hiding controls alone is insufficient. Persist user-specific feature data in shared SQLite keyed by the authenticated Portal `userId`. Do not use global JSON files or browser storage for multi-user state.

## Commit & Pull Request Guidelines

Follow the established imperative Conventional Commit style, such as `feat: ...`, `fix: ...`, or `revert: ...`. Keep commits focused. Pull requests should describe affected services, configuration or migration impact, test commands/results, deployment considerations, and include screenshots for UI changes. Never commit API keys, production `config.json`, databases, or runtime JSON.
