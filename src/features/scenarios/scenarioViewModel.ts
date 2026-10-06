import { simulateProject } from "../../shared/domain/simulation";
import type {
  LatencyProject,
  RequestNode,
  ScenarioSnapshot,
  SimulationMode,
  SimulationResult,
} from "../../shared/domain/types";

export const CURRENT_BUDGET_VERSION = 2 as const;

export interface ScenarioComparison {
  deltaMs: number;
  changes: string[];
  outcome: "faster" | "slower" | "equal";
}

/**
 * 旧快照锁定的完成预算不随后续口径调整而改变。
 * 这里仅按当前口径重算一份用于对照，差额可以明确归因：
 * - 参数完全相同、仅 budgetVersion 不同 → 差额来自口径调整（如下游降级折算补全）；
 * - 重算值与锁定值一致 → 口径调整对该方案无影响。
 */
export interface SnapshotRecalibration {
  lockedMs: number;
  recomputedMs: number;
  deltaMs: number;
  lockedVersion: 1 | 2;
  /** 差额是否纯粹来自口径版本（参数快照未变） */
  caliberOnly: boolean;
  mode: SimulationMode;
}

export function recalibrateSnapshot(
  snapshot: ScenarioSnapshot,
): SnapshotRecalibration {
  const mode: SimulationMode = snapshot.simulationMode ?? "expected";
  const project: LatencyProject = {
    id: `recalc-${snapshot.id}`,
    title: snapshot.name,
    nodes: snapshot.nodes,
    concurrencyLimit: snapshot.concurrencyLimit,
    scenarios: [],
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.createdAt,
  };
  const result = simulateProject(project, mode);
  const lockedVersion = snapshot.budgetVersion ?? 1;
  const recomputedMs = Math.round(result.completionMs);
  return {
    lockedMs: Math.round(snapshot.completionMs),
    recomputedMs,
    deltaMs: recomputedMs - Math.round(snapshot.completionMs),
    lockedVersion,
    caliberOnly: lockedVersion < CURRENT_BUDGET_VERSION,
    mode,
  };
}

export function describeRecalibration(
  recalibration: SnapshotRecalibration,
): string | undefined {
  if (recalibration.deltaMs === 0) return undefined;
  const sign = recalibration.deltaMs > 0 ? "+" : "-";
  const reason = recalibration.caliberOnly
    ? "差额来自降级下游折算口径调整（v1 → v2），非参数变化"
    : "差额来自当前口径重算";
  return `按 v2 口径重算 ${recalibration.recomputedMs} ms（${sign}${Math.abs(recalibration.deltaMs)} ms），${reason}`;
}

function describeNodeChanges(
  before: RequestNode,
  after: RequestNode,
): string[] {
  const changes: string[] = [];
  if (before.durationMs !== after.durationMs)
    changes.push(
      `${before.name} · 耗时 ${before.durationMs} → ${after.durationMs} ms`,
    );
  if (before.jitterMs !== after.jitterMs)
    changes.push(
      `${before.name} · 波动 ±${before.jitterMs} → ±${after.jitterMs} ms`,
    );
  if (before.timeoutMs !== after.timeoutMs)
    changes.push(
      `${before.name} · 超时 ${before.timeoutMs} → ${after.timeoutMs} ms`,
    );
  if (before.retryCount !== after.retryCount)
    changes.push(
      `${before.name} · 重试 ${before.retryCount} → ${after.retryCount} 次`,
    );
  if (before.failureRate !== after.failureRate)
    changes.push(
      `${before.name} · 失败率 ${before.failureRate} → ${after.failureRate}%`,
    );
  if (before.fallbackNodeId !== after.fallbackNodeId)
    changes.push(`${before.name} · 降级目标已调整`);
  if (before.dependencyIds.join("|") !== after.dependencyIds.join("|"))
    changes.push(`${before.name} · 前置依赖已调整`);
  return changes;
}

export function compareScenarios(
  baseline: ScenarioSnapshot,
  comparison: ScenarioSnapshot,
): ScenarioComparison {
  const baselineNodes = new Map(baseline.nodes.map((node) => [node.id, node]));
  const comparisonNodes = new Map(
    comparison.nodes.map((node) => [node.id, node]),
  );
  const changes = [
    ...baseline.nodes.flatMap((node) => {
      const next = comparisonNodes.get(node.id);
      return next
        ? describeNodeChanges(node, next)
        : [`${node.name} · 已从对照方案移除`];
    }),
    ...comparison.nodes
      .filter((node) => !baselineNodes.has(node.id))
      .map((node) => `${node.name} · 新增请求节点`),
  ];
  if (baseline.concurrencyLimit !== comparison.concurrencyLimit)
    changes.unshift(
      `并发上限 · ${baseline.concurrencyLimit ?? "不限"} → ${comparison.concurrencyLimit ?? "不限"}`,
    );
  return {
    deltaMs: comparison.completionMs - baseline.completionMs,
    changes,
    outcome:
      comparison.completionMs < baseline.completionMs
        ? "faster"
        : comparison.completionMs > baseline.completionMs
          ? "slower"
          : "equal",
  };
}

export function saveScenario(
  project: LatencyProject,
  result: SimulationResult,
  name: string,
): LatencyProject {
  if (
    result.warnings.some(
      (warning) => warning.includes("检测到循环") || warning.includes("不能"),
    )
  )
    return project;
  const snapshot: ScenarioSnapshot = {
    id: crypto.randomUUID(),
    name: name.trim() || `方案 ${project.scenarios.length + 1}`,
    createdAt: Date.now(),
    concurrencyLimit: project.concurrencyLimit,
    nodes: structuredClone(project.nodes),
    completionMs: result.completionMs,
    criticalPath: [...result.criticalPath],
    budgetVersion: CURRENT_BUDGET_VERSION,
    simulationMode: result.mode,
  };
  return {
    ...project,
    scenarios: [snapshot, ...project.scenarios],
    updatedAt: Date.now(),
  };
}

export function removeScenario(
  project: LatencyProject,
  scenarioId: string,
): LatencyProject {
  return {
    ...project,
    scenarios: project.scenarios.filter(
      (scenario) => scenario.id !== scenarioId,
    ),
    updatedAt: Date.now(),
  };
}

export function restoreScenario(
  project: LatencyProject,
  scenarioId: string,
): LatencyProject {
  const snapshot = project.scenarios.find(
    (scenario) => scenario.id === scenarioId,
  );
  if (!snapshot) return project;
  return {
    ...project,
    nodes: structuredClone(snapshot.nodes),
    concurrencyLimit: snapshot.concurrencyLimit,
    updatedAt: Date.now(),
  };
}
