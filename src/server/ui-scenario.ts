import { setTimeout as delay } from "node:timers/promises"
import type { z } from "zod"
import type { RenderCommandResult, ViewerObjectSnapshot, ViewerObservation } from "../viewer-protocol"
import { checkBudget, RUNTIME_LIMITS } from "../runtime/resource-budget"
import type { ViewerRenderBroker, uiScenarioConditionSchema, uiScenarioInputSchema } from "./viewer"

type Condition = z.infer<typeof uiScenarioConditionSchema>
type Input = z.infer<typeof uiScenarioInputSchema>

function inspectCondition(condition: Exclude<Condition, { kind: "interaction" }>, observation: ViewerObservation) {
  if (!observation?.objectTree || !Array.isArray(observation.controllers)) throw new Error("observation_invalid: renderer returned no object tree")
  if (condition.kind === "controller") {
    checkBudget(observation.controllers.length, RUNTIME_LIMITS.observationEntries, "observation_controllers")
    const matches = observation.controllers.filter((controller) => controller.targetId === condition.targetId && controller.name === condition.controllerName)
    if (matches.length > 1) throw new Error("target_ambiguous: controller selector is not unique")
    if (matches[0]) {
      if (typeof matches[0].pageId !== "string") throw new Error("observation_invalid: malformed Controller page")
      checkBudget(matches[0].pageId.length, RUNTIME_LIMITS.stringLength, "observation_string")
    }
    return { matched: matches.length === 1 && matches[0].pageId === condition.pageId, actual: matches[0]?.pageId ?? null }
  }
  const pending = [observation.objectTree]
  let target: ViewerObjectSnapshot | undefined
  let count = 0
  while (pending.length) {
    checkBudget(++count, RUNTIME_LIMITS.nodes, "observation_nodes")
    const node = pending.pop()!
    if (!node || typeof node.id !== "string" || !node.id || (node.children !== undefined && !Array.isArray(node.children))) {
      throw new Error("observation_invalid: malformed object tree")
    }
    if (node.id === condition.targetId) {
      if (target) throw new Error("target_ambiguous: object ID is not unique")
      target = node
    }
    if (node.children) {
      checkBudget(count + pending.length + node.children.length, RUNTIME_LIMITS.nodes, "observation_nodes")
      pending.push(...node.children)
    }
  }
  if (condition.kind === "exists") return { matched: Boolean(target) === condition.exists, actual: Boolean(target) }
  const actual = target?.[condition.property]
  if (typeof actual === "string") checkBudget(actual.length, RUNTIME_LIMITS.stringLength, "observation_string")
  if (typeof actual === "number" && !Number.isFinite(actual)) throw new Error("observation_invalid: non-finite property")
  return { matched: !!target && actual === condition.equals, actual: actual ?? null }
}

export async function executeUiScenario(broker: ViewerRenderBroker, input: Input): Promise<RenderCommandResult> {
  const startingInteractionSeq = broker.getSession(input.renderSessionId)!.interactionSeq
  let stateVersion = input.expectedStateVersion
  let viewStateVersion = input.expectedViewStateVersion
  const deadline = performance.now() + input.timeoutMs
  const steps: Array<Record<string, unknown>> = []
  let screenshot: RenderCommandResult | undefined
  let screenshotStep: number | undefined
  let executionUncertain = false
  let index = 0
  let stepStarted = performance.now()

  const requireSession = () => {
    const session = broker.getSession(input.renderSessionId)
    if (!session) throw new Error(broker.getSessionError(input.renderSessionId))
    return session
  }
  const checkDeadline = () => {
    if (performance.now() >= deadline) throw new Error("scenario_timeout: overall scenario deadline exceeded")
    requireSession()
  }
  const command = async (kind: "observe" | "capture" | "update", operations?: Input["steps"][number] & { action: "update" }, until = deadline) => {
    checkDeadline()
    if (performance.now() >= until) throw new Error("condition_timeout: condition deadline exceeded")
    const pending = kind === "update"
      ? broker.executeForSession(input.renderSessionId, stateVersion, kind, { operations: operations!.operations })
      : broker.executeReadForSession(input.renderSessionId, stateVersion, kind, undefined, viewStateVersion)
    if (!pending) throw new Error("browser_required: renderer is not connected")
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([pending, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          executionUncertain = kind === "update"
          reject(new Error(`${until < deadline ? "condition_timeout" : "scenario_timeout"}: an in-flight renderer command did not answer before its deadline; reopen Viewer or Player`))
          broker.disconnectRenderer(input.renderSessionId)
        }, Math.max(1, until - performance.now()))
      })])
      stateVersion = result.semanticStateVersion
      viewStateVersion = result.viewStateVersion
      if (performance.now() >= until) throw new Error(`${until < deadline ? "condition_timeout" : "scenario_timeout"}: command completed after its deadline`)
      return result
    } catch (error) {
      if (kind === "update" && !broker.getSession(input.renderSessionId)) executionUncertain = true
      throw error
    } finally { clearTimeout(timeout) }
  }
  const condition = async (expected: Condition, until = deadline) => {
    if (expected.kind !== "interaction") {
      const observed = await command("observe", undefined, until)
      return inspectCondition(expected, observed.value.observation as ViewerObservation)
    }
    checkDeadline()
    if (performance.now() >= until) throw new Error("condition_timeout: condition deadline exceeded")
    const events = broker.getInteractionsSince(input.renderSessionId, startingInteractionSeq)
    const session = requireSession()
    stateVersion = session.semanticStateVersion
    viewStateVersion = session.viewStateVersion
    const event = events.find((event) => event.targetId === expected.targetId && event.event === expected.event)
    return { matched: !!event, actual: event ? { interactionSeq: event.interactionSeq, targetId: event.targetId, event: event.event } : null }
  }
  const result = (passed: boolean, error?: string): RenderCommandResult => {
    const current = broker.getSession(input.renderSessionId)
    const semanticStateVersion = current?.semanticStateVersion ?? stateVersion
    return {
      renderSessionId: input.renderSessionId,
      sourceRevision: input.sourceRevision,
      stateVersion: semanticStateVersion,
      semanticStateVersion,
      viewStateVersion: current?.viewStateVersion ?? viewStateVersion,
      value: {
        requestId: input.requestId, passed, steps,
        sessionAvailable: current !== null, executionUncertain,
        ...(error ? { failedStep: index, error, rollback: false } : {}),
        ...(screenshot ? {
          screenshotBase64: screenshot.value.screenshotBase64,
          capture: { stepIndex: screenshotStep, sourceRevision: screenshot.sourceRevision, semanticStateVersion: screenshot.semanticStateVersion,
            viewStateVersion: screenshot.viewStateVersion, component: screenshot.value.component, view: screenshot.value.view },
        } : {}),
      },
    }
  }

  try {
    for (const step of input.steps) {
      stepStarted = performance.now()
      checkDeadline()
      let assertion: { matched: boolean; actual: unknown } | undefined
      if (step.action === "update") await command("update", step)
      else if (step.action === "capture") {
        const captured = await command("capture")
        if (typeof captured.value.screenshotBase64 !== "string" || !captured.value.screenshotBase64) throw new Error("capture_missing: renderer returned no PNG")
        screenshot = captured
        screenshotStep = index
      } else {
        const until = step.action === "wait-for" ? Math.min(deadline, performance.now() + step.timeoutMs) : deadline
        do {
          assertion = await condition(step.condition, until)
          if (assertion.matched || step.action === "assert" || performance.now() >= until) break
          await delay(Math.min(100, Math.max(1, until - performance.now())))
          if (performance.now() >= until) break
        } while (true)
        if (!assertion.matched) {
          steps.push({ index, action: step.action, status: "failed", semanticStateVersion: stateVersion, viewStateVersion, ...assertion,
            durationMs: Math.round(performance.now() - stepStarted) })
          return result(false, step.action === "assert" ? "assertion_failed: condition did not match" : "condition_timeout: condition did not match before its deadline")
        }
      }
      steps.push({ index, action: step.action, status: "passed", semanticStateVersion: stateVersion, viewStateVersion,
        ...(assertion ?? {}), durationMs: Math.round(performance.now() - stepStarted) })
      index += 1
    }
    return result(true)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    executionUncertain ||= /execution status is unknown|render_state_uncertain|runtime command timed out/.test(message)
    steps.push({ index, action: input.steps[index]?.action, status: "failed", error: message,
      semanticStateVersion: stateVersion, viewStateVersion, durationMs: Math.round(performance.now() - stepStarted) })
    return result(false, message)
  }
}
