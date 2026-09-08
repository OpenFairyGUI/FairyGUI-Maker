# UI authoring decisions and acceptance

Use this reference when creating or refining FairyGUI UI. Preserve the requested appearance and behavior while choosing structures that can be reused and maintained. Apply the relevant decisions below; a task does not need every FairyGUI feature. Inspect existing components before proposing replacements, and keep discussion/review work read-only.

## Choose the representation

| Need | Preferred approach | Check before choosing |
|---|---|---|
| Repeated artwork or UI structure | Reference existing image/font resources and component templates; use supported instance properties for content differences. | Inspect actual resource IDs, dependencies, template type and exposed properties. Similar names or appearance alone do not prove interchangeability. |
| Several visual properties change with one state | Use a Controller with named pages and appropriate Gears. Separate independent state dimensions when their property ownership is clear. | Record which page controls which properties. Preserve existing page IDs/actions and bindings; avoid two mechanisms competing over the same property. A static value needs no Controller. |
| Container size or text length changes | Set the initial geometry and text sizing, then use Relations to preserve the required offsets or size differences. | Identify the target and dependency direction. Relations maintain relationships; they do not establish initial alignment or guarantee every aspect ratio works. Avoid circular dependencies. |
| A visual change unfolds over time | Use a Transition; use supported Gear tweening for a simple state-driven change. | Identify targets, duration, units, trigger and repeat behavior. Check interactions with Controllers and Relations; keep business effects outside animation. |
| A data-driven collection scrolls or refreshes | Reuse a list-item component. Consider runtime virtualization and pooling when data volume warrants them. | Confirm the target runtime and application integration support item rendering and recycling. Repeated design layers alone do not establish a dynamic list. |
| Language or channel variants differ | Share common resources; use localized text and layout adjustments for small differences, or UI branches for resource/component variants. | Confirm the actual variants and current authoring/runtime support. A UI branch is not a Git branch; do not assume changing a branch updates already-created objects. |

Component definitions and images can be shared while runtime component instances remain independent. Reusing an instance through an object pool is a separate runtime concern. Do not copy a template's children or image bytes when a reference plus supported instance properties expresses the request. If an existing template cannot express the required difference, explain the gap and create or extend only the requested structure; changing a shared definition requires checking its other consumers.

Controllers describe presentation states, not business truth. The application decides eligibility, request results and other business transitions. For example, a reward state can control button text, graying, touchability and a status mark; it does not grant a reward. Independent dimensions such as selection and eligibility should not become a page for every possible combination unless their visuals actually require coupled states.

For lists, bind all variable item properties on reuse, including selection and disabled state. Verify that event handlers and data do not leak between recycled items. A UI asset alone does not install an `itemRenderer`, enable virtualization or prove performance. For resource optimization, distinguish shared references, atlas organization and runtime batching; do not promise lower draw calls or memory without target-runtime measurements.

These are design choices, not additional Maker APIs. Look up current capabilities and the installed operation/method schemas before editing. An upstream FairyGUI feature may lack a writable UAM representation or Viewer support. Report that specific gap and continue independent supported work; do not invent an operation, use `extras` to smuggle in a formal field, flatten requested editable behavior, or inject application scripts into the renderer.

## Apply and verify through Maker

1. Identify the authorized component(s), existing reusable resources and dependencies using the [project inspection workflow](../SKILL.md#inspect-or-edit-a-project). Record a compact task-specific state/layout expectation before editing; use a table only when multiple states or variants need comparison. Do not add features or refactor unrelated components.
2. Read exact current entities and schemas, prepare the smallest supported UAM batch and preflight it through the advertised Backend capability. Follow the existing transaction, validation and save workflow. Keep selectors/revisions tied to the queried state; never paste example names as IDs. Do not create a second Backend path to bypass Maker.
3. Query the changed entities and compare intended fields and affected references. Structural validation must be valid and complete for the claimed scope. When saving is requested, follow the Host Save Grant flow and reopen/read back the saved fields. Preview-only work stays unsaved.
4. Open the current session through the [Viewer workflow](../SKILL.md#preview-an-unpublished-project-in-viewer). Discover target IDs, Controller pages and available Transitions from the observation. Exercise relevant states, return to the initial state, and test representative content/size variants using only supported temporary operations. Refresh the preview after authoring changes.
5. Use [UI scenarios](ui-scenarios.md) for supported state assertions and fresh Canvas evidence. Verify real input when claiming click/input behavior: an `enabled` observation or synthetic event alone does not prove touchability. Report unavailable evidence explicitly. Validate real published artifacts through the [Player workflow](../SKILL.md#validate-a-published-artifact-in-player) when publication/runtime acceptance is part of the task; Maker does not automatically publish a project.

Keep the evidence proportional to the change. Resource queries establish reference structure; reopened fields establish persistence; Viewer establishes the supported preview behavior; Player establishes the loaded published artifact's behavior. None alone establishes all four. A successful render-session update changes temporary state, not the source project.

The current scenario property whitelist does not expose `alpha` or `touchable`, and scenarios have no exact-time seek or animation-completion primitive. Check persisted animation parameters through Backend queries and assess playback with the evidence the renderer actually provides. A screenshot captured after `play-transition` cannot certify the exact midpoint, duration or absence of an input event. When those are acceptance requirements, use an authorized runtime check that can measure them or report them as unverified; do not invent assertions or use arbitrary JavaScript in a render session.

## Worked acceptance examples

These examples describe outcomes, not fixed operation JSON. Adapt names, values and geometry to the user's project and obtain all IDs from current queries. They are evaluation cases, not claims that a particular project or runtime has already passed.

### Three cards from one template

**Request:** Create daily, weekly and bonus reward cards from an existing reward-card template, with different titles and existing icons.

Inspect the template's component type, supported title/icon instance properties and exported cross-package resources. Reuse the template and image references. If named reusable variants are requested, each new component can contain one configured template instance; if only three placements are needed, create those instances without adding wrapper resources.

**Accept:** Each card resolves to the intended template and icon IDs, titles differ as requested, and the saved instances retain those references. Existing template children and image bytes remain unchanged unless the user requested a shared-template edit. Render the cards to verify content and layout. If the template cannot expose the required content, report that limitation before choosing a supported structural change.

### One reward panel with three states

**Request:** Make the reward panel display locked, claimable and claimed states.

| State | Button text | Grayed | Touchable | Claimed mark |
|---|---|---|---|---|
| Locked | Not available | Yes | No | Hidden |
| Claimable | Claim reward | No | Yes | Hidden |
| Claimed | Claimed | Yes | No | Visible |

Inspect any existing state Controller first. Use the appropriate text/look/display Gears for the requested properties, preserving unrelated pages, actions and bindings. The application owns the state transition and reward issuance.

**Accept:** Saved page/Gear mappings match the table. In a fresh preview, switch Locked → Claimable → Claimed → Locked and inspect exposed properties and fresh images. Check actual input separately when clickability is required; gray appearance or `enabled: false` alone is insufficient. Do not infer reward issuance from a UI click or Controller change.

### Resize a panel and add an entrance

**Request:** Widen a panel, keep its close button at the right margin and its content aligned, then add a one-shot fade/slide entrance.

Inspect current geometry, Relations, Controllers and Transitions. Establish the requested initial layout and relevant Relations; add the entrance using the installed timing/target semantics. Preserve existing state behavior and resource references. Keep the entrance's final position consistent with the layout, and check whether the selected targets permit repeat playback without accumulating offsets.

**Accept:** Reopened geometry, relations, timing and targets match the request. Preview the intended widths and representative longer text, check clipping/margins, replay the entrance and recheck existing states. Confirm observed start/end behavior where available; distinguish that from exact timing or alpha measurements, which require additional runtime evidence. Use Player only after a real published artifact is available and record its identity separately from the Viewer source.

## Source of truth

Use installed OpenFairyGUI documentation for current operation grammar and capability limits; keep this reference free of copied schemas. For FairyGUI concepts, consult the official [components](https://www.fairygui.com/docs/editor/component), [Controllers and Gears](https://www.fairygui.com/docs/editor/controller), [Relations](https://www.fairygui.com/docs/editor/relation), [Transitions](https://www.fairygui.com/docs/editor/transition), [lists](https://www.fairygui.com/docs/editor/list) and [branches](https://www.fairygui.com/docs/editor/branch) documentation. Framework documentation does not establish Maker or installed SDK support.
