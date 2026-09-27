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

## Remote ECS Development and Deployment

- The ECS checkout at `/opt/navigation` is the primary development workspace. Use Cursor/VS Code Remote SSH to edit, test, commit, and push from ECS; the local checkout is an optional mirror, not a second source of truth.
- Before committing on ECS, review `git status` and `git diff`. Commit application code and intentional documentation only; never commit `config.json`, secrets, SQLite databases, logs, uploads, caches, or other runtime data.
- After an ECS commit, push that exact commit to `origin/main`, verify the remote ref, then restart only affected services and verify their health plus the production UI/API. Record the deployed commit hash.
- Keep the ECS working tree clean after deployment. If unrelated local changes, secrets, or runtime files appear, stop and classify them; do not reset, discard, or overwrite them automatically.
- Local-to-ECS SCP synchronization and local pushes are no longer the normal workflow. `scripts/ecs-deploy-from-local.ps1` is an emergency-only legacy tool and requires explicit authorization.

## Coding Style & Naming Conventions

Use two-space indentation, semicolons, single quotes, and ES modules for JavaScript. Prefer `camelCase` for functions and variables, `PascalCase` for classes/components, and descriptive kebab-case commit scopes. Keep browser code dependency-light and escape user-controlled values before inserting HTML. Reuse shared helpers and existing CSS variables instead of duplicating service behavior.

## Testing Guidelines

Tests use Node's built-in `node:test` and `node:assert/strict`. Name files `*.test.js` and place them beside the implementation. Add regression coverage for API fallbacks, persistence, calculations, and permission-sensitive behavior. Run the complete service test command before submitting changes; UI changes should also receive browser verification.

## Authorization & User Data

Every new page, menu, tab, or action button must define a permission in `portal/src/rbac.js` with a `permissionPath` matching its menu/page hierarchy. Enforce it in browser and API; hiding controls alone is insufficient. Persist user-specific feature data in shared SQLite keyed by the authenticated Portal `userId`. Do not use global JSON files or browser storage for multi-user state.

## Commit & Pull Request Guidelines

Follow the established imperative Conventional Commit style, such as `feat: ...`, `fix: ...`, or `revert: ...`. Keep commits focused. Pull requests should describe affected services, configuration or migration impact, test commands/results, deployment considerations, and include screenshots for UI changes. Never commit API keys, production `config.json`, databases, or runtime JSON.
