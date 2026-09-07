---
name: use-fairygui-maker
description: Use FairyGUI Maker to import or reimport design sources, inspect or edit FairyGUI projects, analyze assets, preview unpublished UI in Viewer, and validate published .fui or _fui.bytes artifacts in Player. Trigger for operating the Maker CLI, Workbench, or MCP tools, including render evidence and revision or permission failures. Do not trigger for developing FairyGUI Maker's own source code.
---

# Use FairyGUI Maker

Choose the local CLI or connected Maker Host for the requested workflow. Keep project authoring, Viewer preview, and Player validation separate.

## Choose the workflow

| Goal | Use | Persistent effect |
|---|---|---|
| Import `.fig`, `.psd`, or a Maker Import Bundle | Local CLI or Workbench Draft | Draft state; project files only on explicit import/Materialize |
| Reimport changed local design sources | Local CLI dry-run, then approved plan digest | Three-way merge into the existing project |
| Inspect, edit, or save a `.fairy` project | OpenFairyGUI backend session | Save requires an explicit revision and a one-time Host Save Grant |
| Inspect resource health/references | Asset Manager + `inspect_project_assets` | Advisory analysis for one source revision |
| Preview the current unpublished project | Viewer | Render-session memory only |
| Validate imported `.fui` / `_fui.bytes` output | Player | Artifact remains immutable |
| Publish a project automatically | Unsupported | `publish_artifact` is not implemented |

Do not use Viewer as evidence of published runtime behavior. Use Player for the final published result.

## Start safely

1. For local CLI work, check the installed command's `--version` and `--help`; import/reimport do not require a running Host, MCP connection, or token. For backend/MCP rendering work, use the available Maker tools or start/connect the authorized Host as described in the [CLI reference](references/import-workflows.md).
2. Call `openfairygui_backend_get_capabilities` before backend work. Respect its versions, supported methods, and non-goals.
3. Use the single Maker MCP service. Do not create a second OpenFairyGUI transaction path.
4. Use only a project path supplied or authorized by the user. Do not scan for other FairyGUI projects.
5. Preserve stable project, package, component, object, session, artifact, revision, and state-version IDs. Never guess an ID from a display name.
6. Generate a UUID `requestId` for each new render payload. Reuse one only when retrying the identical payload.
7. Never expose the Maker token in logs, screenshots, or the final report.

Use the registered OpenFairyGUI MCP prompts when the client exposes them. They define the same capability, revision, save, and polling contracts.

## Import and reimport design sources

Read [references/import-workflows.md](references/import-workflows.md) for exact CLI commands, Draft REST inputs, and recovery. Use inspect/plan/dry-run when the user requests analysis; use `import --out` or Draft Materialize only for a requested new project. Keep the source path, draftId, revision, output path and diagnostics in the result.

After preview, a planned/compiled Draft can change Mapping and compile again. Successful replanning invalidates the old preview and visual evidence; capture the new result. An already-written Materialize attempt must be recovered before changing that Draft.

For reimport, show the actual dry-run changes, conflicts/blockers and `planDigest` before applying. A prior request to apply the reviewed plan is sufficient authorization; a request merely to inspect changes is not. Close the project in Host/editor, apply the exact approved digest once, and run a fresh dry-run to check the resulting project. Never use CLI reimport to bypass a pending Host Save Grant.

## Inspect or edit a project

1. Call `openfairygui_backend_open_session` with the authorized `projectPath` and record the returned `sessionId`.
2. Call `openfairygui_backend_get_session` for revision/dirty/save metadata and `openfairygui_backend_get_project_outline` for stable resource and node IDs. Published Backend 0.3.1 does not expose current entity properties or full UAM through these calls; property readback is tracked in [OpenFairyGUI #129](https://github.com/OpenFairyGUI/OpenFairyGUI/issues/129). If a change depends on an unknown current value, report this limitation rather than guessing.
3. Plan the smallest UAM operation batch supported by the current contract. Do not invent selector or operation grammar at the MCP layer.
4. Call `openfairygui_backend_apply_transaction` with `sessionId`, the observed `expectedRevision`, and the operation batch.
5. Fetch the session and outline again to verify the new revision and any observable identity changes; call `openfairygui_backend_validate_session` for structural diagnostics. These checks do not verify changed text, geometry, or other properties in Backend 0.3.1. Report property readback as unavailable; do not claim a model change was independently verified just because the transaction succeeded.
6. Before `openfairygui_backend_save_session`, ensure the user has requested persistence or overwriting. An explicit edit-and-save request allows requesting a Host grant; a read-only or preview request does not. Chat authorization alone does not bypass the Host gate.
7. Always send the observed `expectedRevision`, including for force-save or materialization. On `save_approval_required`, report the request ID, target, revision, options and Workbench `approvalPath`; ask the Host owner to confirm there using their separate approval token. Keep the backend session open while awaiting this decision. Do not obtain, read, print or supply that token yourself, approve via REST/browser automation, or bypass the gate using filesystem tools or another backend.
8. After owner confirmation, retry the identical tool arguments once. Grants expire five minutes after request creation and are consumed before execution, even on failed or uncertain writes. Re-read state after failure; never silently request and approve another grant. Changed revision/options, closure, rejection or revocation require a fresh request and owner decision. Preserve backend partial-save/error envelopes; a consumed grant does not prove success.
9. Close the session with `openfairygui_backend_close_session` when finished or abandoning the operation, including after failures; do not close a session still awaiting owner approval.

If a revision is stale, fetch the session again and re-plan. Never replay an old mutation blindly. Use `openfairygui_backend_materialize_session` only when the user explicitly requests full-project materialization.

## Preview an unpublished project in Viewer

Choose one authorization path:

- Interactive: the user binds a directory from Dashboard with `showDirectoryPicker({ mode: "read" })`. Only the user can grant or renew this browser permission.
- Automated read-only snapshot: run the installed `fairygui-maker view <project-path>` (or `pnpm cli -- view <project-path>` from a built source checkout) using the one explicit project root. Add `--data-dir <private-path>` when artifacts must not live under the launch directory. The snapshot is immutable until the CLI/Host restarts and the MCP service does not register backend write tools.

Then:

1. Call `list_viewer_components`, optionally with `projectId`. Use its stable project, package, and component IDs; never guess them from display names.
2. If it returns `browserRequired: true`, open the returned stable `viewerUrl` in a real browser, wait for renderer registration, and call `list_viewer_components` again.
3. Call `render_component_preview` with the returned stable IDs and `capture: true` when visual evidence is required.
4. If rendering still returns `browser_required`, reopen the returned `viewerUrl`, wait for renderer registration, and retry the identical request safely.
5. Record the returned `renderSessionId` and `stateVersion`.
6. Use `get_render_observation` for the object tree, controls, each Controller's current page and available `pages`, plus target-scoped `availableTransitions`.
7. Use `update_render_session` only for temporary whitelisted operations with the latest `expectedStateVersion`. Switch a discovered page with `set-controller-page`; play a discovered target/name pair with `play-transition`.
8. Use `capture_render_screenshot` with the required `afterStateVersion` when a fresh screenshot is needed.

Use the MCP `image/png` content attached to render and capture results; do not copy or parse raw screenshot Base64. For component evidence, never substitute a browser page screenshot: it includes Workbench chrome and is not bound to `stateVersion`. Capture the whole browser only when the task is specifically auditing the Workbench interface itself.

Viewer updates never change the `.fairy` project. Persist project changes only through a backend revision-checked transaction and save.

Viewer reads saved files or the CLI's frozen snapshot, not pending Backend edits. There is no public Backend-revision preview bridge in 0.3.1; this is tracked in [OpenFairyGUI #130](https://github.com/OpenFairyGUI/OpenFairyGUI/issues/130). Do not read private runtime fields, mirror Backend transactions, or save solely to work around this limitation. After an explicitly requested and approved save, refresh the browser source or restart the CLI snapshot before validating the saved result.

## Inspect assets

Use `list_viewer_components` to find the authorized projectId, then call `inspect_project_assets`. On `browser_required`, open its `assetManagerUrl` and let Asset Manager scan the authorized source; retry for that sourceRevision. Do not invent a scan or upload your own conclusions as Host-verified evidence.

Use `{projectId, packageId, resourceId, direction: "both", limit: 100}` for one resource. Repeat identical selectors with `nextCursor` until null to read all issues and incoming/outgoing references. For a large issue group, use its `issueId` with `{projectId, issueId, limit: 100}` to page every affected resource key. Stale cursors or issue IDs require a fresh query. Results are `analysisOwner: "browser"`, `trust: "advisory"`; zero references do not authorize deletion, and Maker exposes no delete/rename/merge/reference-rewrite asset operation.

## Validate a published Artifact in Player

1. Start from a real published directory imported through Workbench or its authorized Artifact REST flow. Do not claim Maker published it; automatic publishing is not implemented.
2. Call `list_artifact_components` to page artifact summaries, then pass `artifactId` to page its package/component catalog. Repeat the same selectors with `nextCursor` until it is `null`; `limit` is 1–500 (default 100). Use the returned immutable `artifactId`, digest, package IDs, and component IDs. On `cursor_invalid_or_stale`, restart that query without the cursor.
3. Call `open_artifact_player`. If no render session exists, open the returned `playerUrl` in a real browser.
4. Call `render_artifact_component` with stable IDs and `capture: true` when visual evidence is required.
5. Use `get_render_observation`, `update_render_session`, and `capture_render_screenshot` with the returned render-session and state versions.
6. Treat Player behavior as authoritative for native `UIPackage`, Controller, Gear, Transition, and published-resource behavior.

Player operations change only render-session memory. Never treat them as Artifact mutation.

## Recover from expected failures

| Failure | Response |
|---|---|
| `browser_required` | Open the returned Viewer or Player URL; do not fabricate a render result |
| `project_permission_required` | Ask the user to reauthorize from Dashboard |
| stale backend revision | Re-fetch the session, re-plan, and use the new revision |
| `cursor_invalid_or_stale` / `issue_invalid_or_stale` | Restart the same asset/catalog query without the old cursor/issue ID |
| `materialize_recovery_required` | Files are committed; preserve the returned target and recover the same Draft/target after content verification |
| reimport conflict, blocker or stale plan digest | Stop applying; read a fresh dry-run and resolve the reported source/project issue |
| `save_approval_required` | Ask the owner to confirm in Workbench; keep the session open and do not self-approve |
| `save_revision_stale` / `save_input_invalid` | Re-fetch the backend revision and supply supported, bounded save arguments; old grants cannot be reused |
| state-version conflict | Observe the latest state, then decide whether the update is still valid |
| `state_version_not_reached` | Wait for the requested version; never lower freshness just to get an old image |
| project/component/artifact not found | Refresh authoritative IDs; never fall back to display-name guessing |
| unsupported Viewer semantic | Return the structured diagnostic; do not fall back to `.fui` or arbitrary JavaScript |

Do not send arbitrary JavaScript, expressions, business JSON, coordinate guesses, or non-whitelisted properties to a render session. Do not bypass Host, Origin, token, path, symlink, capacity, or directory-permission checks.

## Report completion

State:

- which workflow ran: import/reimport, backend authoring, Asset Manager, Viewer, or Player;
- the relevant project/session revisions or Artifact digest;
- whether changes were persisted or temporary;
- the structured observation, screenshot, and diagnostics actually verified;
- any browser, permission, unsupported-semantic, or snapshot-restart limitation.

Do not present build or type-check success as browser-runtime evidence.

This folder is portable: keep `SKILL.md`, `agents/` and `references/` together. The local reference contains CLI/Host startup details. Extended product documentation ships in the installed `fairygui-maker/docs/` directory; online copies are the [README](https://github.com/OpenFairyGUI/FairyGUI-Maker/blob/main/README.md), [architecture](https://github.com/OpenFairyGUI/FairyGUI-Maker/blob/main/docs/architecture.md), and [Workbench contract](https://github.com/OpenFairyGUI/FairyGUI-Maker/blob/main/docs/workbench.md). Match the installed version when consulting online documentation.
