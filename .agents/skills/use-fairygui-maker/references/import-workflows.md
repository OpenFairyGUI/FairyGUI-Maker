# Local CLI and Import Draft workflows

Use the `fairygui-maker` binary from the `@openfairygui/fairygui-maker` package, or `node <maker-checkout>/scripts/fairygui-maker.mjs` after building the source checkout. Run `--version` and `--help` first. Confirm the requested version is available in the registry; otherwise use a supplied tarball/source checkout. Do not repeatedly run npx against an unavailable version.

## Commands and writes

```powershell
fairygui-maker import inspect E:\Design\hud.fig --data-dir E:\MakerData
fairygui-maker import plan E:\Design\hud.fig --out E:\Design\hud-plan.json --data-dir E:\MakerData
fairygui-maker import E:\Design\hud.fig --dry-run --data-dir E:\MakerData
fairygui-maker import E:\Design\hud.fig --out E:\Projects\hud-imported --data-dir E:\MakerData
fairygui-maker reimport E:\Projects\hud-imported --dry-run --data-dir E:\MakerData
fairygui-maker reimport E:\Projects\hud-imported --apply <approved-planDigest> --data-dir E:\MakerData
```

`.psd` files and Maker Import Bundle directories use the same commands. Bundle directories must contain `maker-import.json`, `fixture.json`, and exactly their declared assets; an arbitrary image folder is not a Bundle.

| Command | Result | Files written |
|---|---|---|
| `import inspect` | `{draft}` with source metadata/diagnostics | Private Draft only; no compile |
| `import plan --out plan.json` | `{draft, planPath}` | Private Draft and a new Plan JSON; refuses existing Plan path |
| `import --dry-run` | `{draft}` with generated report | Compiled private Draft; no destination project |
| `import --out new-directory` | `fairyPath`, `projectId`, IDs, report, draftId/revision | New project plus State v2 and generated baseline; refuses overwrite |
| `reimport --dry-run` | Change lists, blockers, `projectRevision`, `sourceDigest`, `planDigest` | No project write |
| `reimport --apply digest` | `applied: true` and the approved digest | Existing project, State and baseline committed together |

Import inspection is not filesystem write-free: it snapshots the source in private Draft storage. `--data-dir` defaults to `.fairygui-maker` under the launch directory; use a separate authorized private directory when appropriate. Drafts expire after seven inactive days. CLI output is JSON, failures use a nonzero exit status. A compiled Draft is structural conversion evidence; it does not prove browser rendering.

Reimport reads the local source path stored at import time. Browser-only uploads have no stable local source path and cannot reimport this way. Keep the project closed in Host/editor; Maker uses Backend locking and rejects conflicts, stale digests, uncertain PSD identity, missing resources and unsupported Backend content. Do not auto-resolve conflicts, force overwrite, or accept a changed digest as approval. After an uncertain apply result, inspect the disk and run a new dry-run before any further write. Never restore only an old State file into a new project.

## Start a Host only when needed

```powershell
# Set the MCP token privately; do not log its value.
fairygui-maker --data-dir E:\MakerData
fairygui-maker view E:\Projects\hud-imported --data-dir E:\MakerData
```

Full Host limits Backend paths to its launch directory and descendants; start in the authorized project parent. Private Maker data and projects containing that data are excluded. `view` authorizes only the explicit root and exposes a frozen read-only snapshot with no Backend write tools. Both serve Workbench and Streamable HTTP MCP at the printed origin (`/mcp`); default port is 3847, configurable by `--port`.

Non-interactive Host startup needs `FAIRYGUI_MAKER_TOKEN` (24–256 characters). MCP uses `Authorization: Bearer <token>`. The human owner separately configures/enters their approval token for Backend Save Grants; do not request or read that secret. CLI import/reimport commands themselves need neither token nor MCP. Use the installed package's README for client-specific connection configuration.

## Workbench and authenticated REST

The `/design-import` page accepts FIG/PSD/Bundle upload and opens `/imports/<draftId>`. Use the returned revision after every mutation. The Host REST API uses the same authorized token; do not put it in logs.

| Request | JSON body / result |
|---|---|
| `POST /api/import-drafts` | `{sourcePath}` for an authorized Host-local source; returns `{draft}` |
| `GET /api/import-drafts/<id>` | Draft, outline, semanticOverlay, buildPlan, preview, previewError, materializeAttempt |
| `POST .../parse` | `{expectedRevision}`; created → parsed |
| `PATCH .../semantic-overlay` | `{expectedRevision,nodeId,directive:{target:"ignore"}}`; nodeId comes from outline; read supported targets before using another target |
| `POST .../plan` | `{expectedRevision,rootIds?,semanticOverlay?}`; full Overlay replacement when provided; omitted rootIds/Overlay retain the saved selection |
| `POST .../compile` | `{expectedRevision}`; planned → compiled |
| `POST .../materialize` | `{expectedRevision,targetPath}`; explicit new destination or exact recovery target |

Mapping in parsed stays parsed. Mapping in planned/compiled regenerates the Plan and returns planned, clearing current generated/visual evidence. Plan accepts parsed/planned/compiled; compile accepts planned. Re-read detail, use the returned preview projectId in Viewer, then inspect/capture the actual render. Each generation has its own source snapshot; old render sessions cannot validate a new generation. Materialized Drafts retain their completion record.

On `409 materialize_recovery_required`, `committed: true` means the target was already written. The REST response includes `draftId`, `expectedRevision` and `outputDirectory`; CLI error text identifies the same Draft, revision and target. Do not rerun CLI import as if it had never happened (that creates another Draft). Start/reuse Host with the same data directory, inspect that Draft and `materializeAttempt`, and retry its Materialize with the observed revision and the same target. Workbench exposes “核对并完成上次物化”. Recovery checks the full target digest and returns `recovered: true`; changed contents are preserved and rejected.
