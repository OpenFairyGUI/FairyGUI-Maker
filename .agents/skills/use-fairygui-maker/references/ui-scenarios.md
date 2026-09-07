# Continuous UI scenarios

`run_ui_scenario` operates on an already rendered Viewer or Player component. It reuses the existing renderer, operations, observations and PNG capture. It needs a connected browser, but no new Backend interface. It changes temporary runtime state only; it cannot edit/save a project, change an Artifact, load business scripts or preview an unsaved Backend revision.

## Prepare and run

1. Use the appropriate component-list and render tools to open/render the authorized source.
2. Get a fresh `get_render_observation`. Copy its `renderSessionId`, `sourceRevision`, `semanticStateVersion` and `viewStateVersion`. Obtain object IDs and Controller names/page IDs from that observation.
3. Submit a fresh UUID `requestId`, the observed versions, and the exact steps to execute. Review the returned `value.passed`, step results and optional PNG.

Replace the source/session/root placeholders and versions below with those actual results. This example temporarily hides the rendered root, verifies it, restores it and captures its visible state:

```json
{
  "renderSessionId": "<returned-render-session-id>",
  "requestId": "bc9c73c9-861c-4675-af8d-a67397e9f565",
  "sourceRevision": "<returned-source-revision>",
  "expectedStateVersion": 1,
  "expectedViewStateVersion": 0,
  "timeoutMs": 10000,
  "steps": [
    {"action":"update","operations":[{"op":"set-property","targetId":"<root-id>","property":"visible","value":false}]},
    {"action":"assert","condition":{"kind":"property","targetId":"<root-id>","property":"visible","equals":false}},
    {"action":"update","operations":[{"op":"set-property","targetId":"<root-id>","property":"visible","value":true}]},
    {"action":"wait-for","condition":{"kind":"property","targetId":"<root-id>","property":"visible","equals":true},"timeoutMs":2000},
    {"action":"capture"}
  ]
}
```

## Steps and conditions

| Step | Behavior |
|---|---|
| `update` + `operations` | The same whitelisted operations as `update_render_session`; each update uses the preceding result's semantic version. |
| `assert` + `condition` | Evaluate once against a fresh runtime observation or acknowledged interaction records. Stop on a mismatch. |
| `wait-for` + `condition` + `timeoutMs` | Poll at most ten times per second until the condition matches or its deadline expires. The whole-run deadline also applies. |
| `capture` | Capture the actual Canvas PNG and preserve that capture's source, semantic/view versions, component and view metadata. |

Conditions use exact, case-sensitive IDs and values, with no expressions or name-path guessing:

| `kind` | Additional fields | Match |
|---|---|---|
| `exists` | `targetId`, `exists: boolean` | Whether the current object tree contains the ID. Duplicate IDs fail as ambiguous. |
| `property` | `targetId`, `property`, `equals` | Exact equality; missing objects/properties do not match. Allowed properties: `text`, `visible`, `enabled`, `selected`, `value`, `selectedIndex`, `x`, `y`, `width`, `height`. Values are string, finite number or boolean. |
| `controller` | `targetId`, `controllerName`, `pageId` | The exact Controller on that object is on the requested page. Duplicate selectors fail as ambiguous. |
| `interaction` | `targetId`, `event` | A matching acknowledged `click`, `input`, `change` or `scroll` occurred after this scenario started. |

Interaction assertions exclude earlier events. They depend on the renderer's actual event reporting: a synthetic `dispatch-event` does not necessarily generate a human-interaction record, so assert the resulting control state for synthetic operations. More than 100 new events can overflow the retained history; the scenario then fails with `interaction_history_lost` instead of guessing.

Observations/waits may see new human interactions and return a newer semantic version. The next update uses that version. An update that races another change fails CAS; it is not replayed automatically. View state remains separately versioned. Changing zoom or switching components should be done with the existing tools before starting a new scenario. There is no arbitrary sleep, `idle`, animation-completion promise or business-event interpreter; wait on an observable state that proves the intended result.

## Results, retries and failure recovery

The text result follows the existing render-command envelope. `value` contains `requestId`, `passed`, ordered `steps`, `sessionAvailable` and `executionUncertain`. Step indices and `failedStep` are zero-based. A failed step includes its error or last mismatching `actual` value; later steps are absent because they did not execute. MCP sets `isError: true` and `ok: false` for failed runs.

On capture, the PNG is MCP image content, never Base64 text. `value.capture` identifies its `stepIndex` and actual capture versions. Those can be older than the final result if later steps or interactions changed state. Use the capture metadata when citing the image. A successful assertion proves the observed condition at that step, not permanent stability or visual fidelity of the entire interface.

An operation batch may apply a prefix before failing. The response explicitly reports `rollback: false`; inspect current state before deciding what to do next. Source replacement or renderer closure stops the scenario. If `sessionAvailable` is false, returned versions are the last confirmed versions and cannot authorize another update. If `executionUncertain` is true, an unacknowledged mutation may have run; reopen the renderer and inspect it before proceeding. A deadline with an in-flight command closes that session so an abandoned command cannot race later work. An unmet condition whose reads completed leaves the session usable.

Each renderer retains its last eight scenario receipts. Within that window, repeat the exact input and `requestId` to get the same in-flight/completed result, including failures, without executing steps again. Reusing that ID with different input fails `request_id_conflict`. Receipts end when the render session closes or its source changes; beyond the retained window, inspect state and use a new request ID for newly authorized work. Do not treat a connection failure as evidence that no operations executed.

Only one scenario runs per render session at a time (`scenario_busy`). Workbench and other clients still use the normal Broker, so concurrent changes can cause version conflicts. Limits: 20 steps, 100 total operations, one PNG, 256 KiB input, and an overall 100–30,000 ms deadline (default 10,000 ms). Property/controller observations reuse the runtime's object/entry budgets. Whole scenarios are not transactions and are not persisted across Host restarts.
