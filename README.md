# Notion ↔ GitHub automation

Shared automation for GitHub repositories (public or private) and Notion Kanban boards.

**Status:** MapPinList has validated the centralized branch and PR lifecycle. PokeRogue-SBC migration is being validated. This repository is being prepared for public visibility.

## How it works

1. A Notion ticket's **Create Branch** button sets `GitHub Lifecycle` to `Pending`.
2. Notion sends a signed `page.properties_updated` webhook to Cloudflare.
3. `cloudflare/worker.js` validates the signature, reads `PROJECTS_CONFIG`, and dispatches `create-notion-branch.yml` in the matching project repo.
4. That repo's small workflow calls this repository's **reusable workflow**, which runs the shared Python script to create the branch and update Notion.
5. A second per-project workflow receives PR/merge/delete events and calls the shared lifecycle script.

## Repository contents

| Path | Purpose |
| --- | --- |
| `scripts/create_notion_branch.py` | Latest imported MapPinList branch script; checks exact ticket ID for existing branches |
| `scripts/sync_github_lifecycle.py` | Latest imported MapPinList PR, merge and deletion sync |
| `.github/workflows/reusable-create-branch.yml` | Central branch-creation workflow |
| `.github/workflows/reusable-sync-lifecycle.yml` | Central lifecycle workflow |
| `templates/create-notion-branch.yml` | Per-project branch workflow caller |
| `templates/sync-notion-lifecycle.yml` | Per-project lifecycle workflow caller |
| `cloudflare/worker.js` | Multi-project webhook dispatcher |
| `templates/projects-config.json` | Example registration with placeholder IDs |
| `tests/test_branch_helpers.py` | Offline branch naming and duplicate-detection smoke tests |

## Shared workflows in a public repository

The shared repository must be **public** for a public project repository to call its reusable workflows. Public reusable workflows can be called by public or private projects (subject to their Actions policies). GitHub Actions automatically reads the shared workflow and `actions/checkout` downloads this public repository; **no `AUTOMATION_REPO_TOKEN` is needed**.

The Cloudflare `GITHUB_TOKEN` is separate and must have **Actions: Read/write** on registered target repositories. The built-in GitHub Actions `GITHUB_TOKEN` writes branches to the calling project. Keep `NOTION_TOKEN` as an Actions secret in each project.

The `templates/projects-config.json` file is illustrative. Keep your **real Notion IDs and repo mapping only in Cloudflare's `PROJECTS_CONFIG` variable**, not in this public repository.

## Migrate one project (MapPinList first)

1. Leave the existing working Python scripts in MapPinList as a rollback option.
2. In MapPinList, ensure Actions variables `NOTION_DATABASE_ID` and `NOTION_DATA_SOURCE_ID` are set. Keep its existing `NOTION_TOKEN` secret.
3. No shared-repository PAT is required after this repository becomes public.
4. **Back up** the existing two workflow YAML files.
5. Replace `.github/workflows/create-notion-branch.yml` with [the branch caller](templates/create-notion-branch.yml).
6. Replace `.github/workflows/sync-notion-lifecycle.yml` with [the lifecycle caller](templates/sync-notion-lifecycle.yml).
7. Test branch creation, repeated button press (no duplicate), PR opening, merging, and deletion/recreation on a safe ticket.
8. After success, migrate PokeRogue-SBC in the same way. Only then consider removing duplicate per-project scripts.

The caller workflow filenames **must remain** `create-notion-branch.yml` and `sync-notion-lifecycle.yml`; the Worker dispatches the first filename.

**Versioning:** templates initially reference `@main` and the reusable workflows check out `main` to simplify the pilot. Once validated, create a release tag and pin both references to that same release (or SHA) to prevent unreviewed changes from affecting every project.

## Cloudflare: switch to configuration-based project registration

This is a **separate migration**. The existing Worker works; keep it until ready.

1. Open your existing Cloudflare Worker `notion-github-bridge`.
2. Under **Settings → Variables and Secrets**, create `PROJECTS_CONFIG` as a **JSON variable**, using [projects-config.json](templates/projects-config.json). A text variable containing the JSON string also works.
3. Preserve the existing encrypted secrets `NOTION_WEBHOOK_SECRET`, `NOTION_TOKEN`, `GITHUB_TOKEN`.
4. Replace the Worker code with [cloudflare/worker.js](cloudflare/worker.js) and deploy.
5. Keep the existing Notion webhook URL `/webhook` and `page.properties_updated` subscription.
6. Confirm both existing projects still dispatch successfully.

The Worker intentionally retains Notion page-fetch API version `2022-06-28`, independent of the webhook subscription version.

## Adding a new project

1. Share the new Notion Kanban with the existing Notion integration.
2. Ensure properties: `Name` (title), `Ticket ID` (unique ID with prefix), `Phase` (select or relation), `GitHub Lifecycle` (select), `GitHub Link` (URL).
3. Add a Notion **Create Branch** button that edits **this page** and sets `GitHub Lifecycle = Pending`.
4. Copy the two YAML templates to `.github/workflows/` in the new GitHub repo.
5. Set Actions variables `NOTION_DATABASE_ID` and `NOTION_DATA_SOURCE_ID`, and the `NOTION_TOKEN` secret.
6. Add an entry to Cloudflare `PROJECTS_CONFIG`: `{"databaseId":"...","dataSourceId":"...","repo":"owner/name"}`. Optional `workflow` defaults to `create-notion-branch.yml`, `ref` defaults to `main`.
7. Ensure Cloudflare's `GITHUB_TOKEN` has Actions write access to the new repo. Deploy the variable change and test a ticket.

## Troubleshooting

- **Cloudflare dispatch 404**: Worker PAT cannot access target repo, lacks Actions write, or workflow missing/disabled.
- **Reusable workflow not accessible**: enable private repository Actions access in this repo's Settings.
- **Shared checkout 404**: `AUTOMATION_REPO_TOKEN` must read this private repo.
- **Notion 403**: integration not shared with board or invalid `NOTION_TOKEN`.
- **Workflow succeeds but no new branch**: exact ticket ID may already have a branch; inspect workflow logs and Notion lifecycle.

Run offline smoke tests with `python -m unittest discover -s tests -v`.

## Known limitations

- The imported lifecycle script does not fully correlate delayed **old PR events** with a newly recreated branch for the same ticket. Avoid simultaneous PR cycles until that protection is added.
- Each project still needs two tiny workflow files to receive its own repository events.
- `PROJECTS_CONFIG` is simpler than editing JavaScript, but changing it still requires deploying Cloudflare configuration.
- Never commit Notion tokens or GitHub PATs.
