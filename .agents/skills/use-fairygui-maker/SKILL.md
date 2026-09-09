---
name: use-fairygui-maker
description: Create or refine FairyGUI UI with FairyGUI Maker using reusable resources and components, Controller states, Relations and Transitions. Also use for design import/reimport, project inspection/editing, asset analysis, Viewer previews, published .fui or _fui.bytes validation in Player, and Maker CLI/MCP revision or permission failures. Do not trigger for developing FairyGUI Maker's own source code or unrelated UI frameworks.
---

# Use FairyGUI Maker

Choose the local CLI or connected Maker Host for the requested workflow. Keep project authoring, Viewer preview, and Player validation separate.

## Choose the workflow

| Goal | Use | Persistent effect |
|---|---|---|
| Import `.fig`, `.psd`, or a Maker Import Bundle | Local CLI or Workbench Draft | Draft state; project files only on explicit import/Materialize |
| Reimport changed local design sources | Local CLI dry-run, then approved plan digest | Three-way merge into the existing project |
| Create or refine reusable UI components, states, layout or motion | Backend authoring + Viewer; Player for published acceptance | Same transaction and save rules as project editing |
| Inspect, edit, or save a `.fairy` project | OpenFairyGUI backend session | Explicit revision plus owner-granted session permission for ordinary saves, or a one-time Host Save Grant |
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

## Create or refine UI

For building components or panels, reusing templates, configuring visual states, adapting layout or adding motion, read [UI authoring decisions and acceptance examples](references/ui-authoring.md). It explains when to choose component references, Controller/Gear, Relations, Transitions, lists or branches, and how to check the result. A narrow inspection or rename does not require this reference.

Inspect existing resources and the requested behavior before choosing a representation. Use only the mechanisms the task needs, preserve the user's design intent, and check current capabilities and installed schemas before applying a choice. The reference supplies design decisions; the workflows below supply the authoring, permission and rendering contracts. A discussion or review request remains read-only.

## Inspect or edit a project

1. Call `openfairygui_backend_open_session` with the authorized `projectPath` and record the returned `sessionId`.
2. Call `openfairygui_backend_get_session` for revision/dirty/save metadata and `openfairygui_backend_get_project_outline` for stable IDs. Use `openfairygui_backend_query_entity` to read the current properties of the exact target. Read its installed method/operation schema before constructing selectors; do not guess current values.
3. Plan the smallest UAM operation batch supported by the current contract. Do not invent selector or operation grammar at the MCP layer.
4. Call `openfairygui_backend_apply_transaction` with `sessionId`, the observed `expectedRevision`, and the operation batch.
5. Query the changed entity again and compare the intended fields at the returned revision; call `openfairygui_backend_validate_session` for structural diagnostics and inspect its actual validity/completeness. A successful transaction or validation envelope alone does not prove the changed properties.
6. Before `openfairygui_backend_save_session`, ensure the user has requested persistence or overwriting. An explicit edit-and-save request allows requesting a Host grant; a read-only or preview request does not. Chat authorization alone does not bypass the Host gate.
7. Always send the observed `expectedRevision`, including for force-save or materialization. On `save_approval_required`, report the target, operation and Workbench `approvalPath`. The owner verifies once there and chooses one-time approval or session permission for ordinary saves. Keep the backend session open while awaiting this decision. Do not obtain owner keys or cookies, approve via REST/browser automation, or bypass the gate using filesystem tools or another backend.
8. After owner confirmation, retry the identical tool arguments once. Session permission covers ordinary saves to the original project across revisions; still read and supply the current revision each time. It ends on revocation, project close/reopen or Host restart. Force-save, any explicit targetPath, materializeCleanSession and materialize_session always require one-time approval. Pending requests and one-time grants expire five minutes after request creation; one-time grants are consumed before execution, even on failed or uncertain writes. Re-read state after failure instead of blindly replaying writes; preserve backend partial-save/error envelopes. Owner verification alone grants no project permission, and neither kind of grant proves a successful save.
9. Verify the save result and dirty/save metadata. When persistence verification is part of the task, close and reopen the same authorized project, query the saved fields, and compare them at the reopened session's revision. Close the session with `openfairygui_backend_close_session` when finished or abandoning the operation, including after failures; do not close a session still awaiting owner approval.

If a revision is stale, fetch the session again and re-plan. On `save_session_unavailable`, inspect the session and open the explicitly authorized project again before requesting a new grant. Never replay an old mutation blindly. Use `openfairygui_backend_materialize_session` only when the user explicitly requests full-project materialization.

## Preview an unpublished project in Viewer

Choose one authorization path:

- Current Backend session: call `open_session_preview` with the existing `sessionId` and explicitly observed `expectedRevision`, or click its Dashboard “预览会话” button. Open the returned `project.viewerUrl`; this reads the unsaved session without saving. On `stale_read`, discard the incomplete read and inspect/replan against current state. Do not silently substitute a new revision.
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

Session previews use public `readSessionState` and revision-bound `readResourceBytes`. Model reads exclude primary resource bytes; the Viewer fetches only the selected component's dependency closure, including cross-package assets and bitmap-font glyphs. Edits/saves invalidate the old renderer; refresh before rendering again. The Host `sourceRevision` identifies a preview generation, not a file hash or a permanent Backend revision snapshot. A session close removes its preview. File-bound Viewer projects still require source refresh (or CLI restart) after saving. Do not read private runtime fields, mirror Backend transactions, or save just to obtain a preview.

Backend and Maker tools share normal MCP discovery. If expected tools are missing or a save returns `backend_unhandled_error`, report the actual Host version and response, preserve the dirty session, and investigate the failure without bypassing the Host gate.

## Inspect assets

Use `list_viewer_components` to find the authorized projectId, then call `inspect_project_assets`. On `browser_required`, open its `assetManagerUrl` and let Asset Manager scan the authorized source; retry for that sourceRevision. Do not invent a scan or upload your own conclusions as Host-verified evidence.

Session preview projects load resource bytes on demand and do not provide full-project asset analysis. Use an explicitly authorized saved directory for that workflow.

Use `{projectId, packageId, resourceId, direction: "both", limit: 100}` for one resource. Repeat identical selectors with `nextCursor` until null to read all issues and incoming/outgoing references. For a large issue group, use its `issueId` with `{projectId, issueId, limit: 100}` to page every affected resource key. Stale cursors or issue IDs require a fresh query. Results are `analysisOwner: "browser"`, `trust: "advisory"`; zero references do not authorize deletion, and Maker exposes no delete/rename/merge/reference-rewrite asset operation.

## Validate a published Artifact in Player

1. Start from a real published directory imported through Workbench or its authorized Artifact REST flow. Do not claim Maker published it; automatic publishing is not implemented.
2. Call `list_artifact_components` to page artifact summaries, then pass `artifactId` to page its package/component catalog. Repeat the same selectors with `nextCursor` until it is `null`; `limit` is 1–500 (default 100). Use the returned immutable `artifactId`, digest, package IDs, and component IDs. On `cursor_invalid_or_stale`, restart that query without the cursor.
3. Call `open_artifact_player`. If no render session exists, open the returned `playerUrl` in a real browser.
4. Call `render_artifact_component` with stable IDs and `capture: true` when visual evidence is required.
5. Use `get_render_observation`, `update_render_session`, and `capture_render_screenshot` with the returned render-session and state versions.
6. Treat Player behavior as authoritative for native `UIPackage`, Controller, Gear, Transition, and published-resource behavior.

Player operations change only render-session memory. Never treat them as Artifact mutation.

## Run a continuous UI scenario

After rendering a Viewer or Player component, use `run_ui_scenario` to sequence temporary operations, assertions, condition waits and one optional Canvas capture. Start from fresh observation IDs, `sourceRevision`, semantic/view versions and a new UUID requestId. Follow the portable [scenario input, example and recovery reference](references/ui-scenarios.md).

Inspect `value.passed`, zero-based step results and `failedStep`; later steps stop after a failure and prior operations are not rolled back. A capture has its own versions in `value.capture`. Replay identical input/requestId only while its receipt remains among the renderer's last eight runs. If execution is uncertain or the session closed, reopen and inspect rather than replaying mutations under a new ID. Scenarios cannot edit/save project files, publish Artifacts or preview unsaved Backend changes.

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

This folder is portable: keep `SKILL.md`, `agents/` and `references/` together. The local reference contains CLI/Host startup details. Extended product documentation ships in the installed `node_modules/@openfairygui/fairygui-maker/docs/` directory; online copies are the [README](https://github.com/OpenFairyGUI/FairyGUI-Maker/blob/main/README.md), [architecture](https://github.com/OpenFairyGUI/FairyGUI-Maker/blob/main/docs/architecture.md), and [Workbench contract](https://github.com/OpenFairyGUI/FairyGUI-Maker/blob/main/docs/workbench.md). Match the installed version when consulting online documentation.
