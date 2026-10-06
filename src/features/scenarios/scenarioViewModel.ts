import {
  BUDGET_MODEL_VERSION,
  type LatencyProject,
  type RequestNode,
  type ScenarioSnapshot,
  type SimulationResult,
} from "../../shared/domain/types";

export interface ScenarioComparison {
  deltaMs: number;
  changes: string[];
  outcome: "faster" | "slower" | "equal";
  /** 两侧快照分别使用的预算口径版本。 */
  baselineModelVersion: number;
  comparisonModelVersion: number;
  /**
   * 完成时间数字是否可直接对比。旧快照（v1）的完成时间按保存时口径冻结，
   * 跨口径时 delta 仍取冻结值，但会附口径说明，避免“无故变化”或误读。
   */
  methodologyNotes: string[];
}

const MODEL_LABELS: Record<number, string> = {
  1: "旧口径（降级单层加权，与主路径混排）",
  2: "新口径（主/降级路径分列，降级链逐级折算）",
};

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
  const baselineModelVersion = baseline.modelVersion ?? 1;
  const comparisonModelVersion = comparison.modelVersion ?? 1;
  const methodologyNotes: string[] = [];
  if (baselineModelVersion !== comparisonModelVersion) {
    methodologyNotes.push(
      `两份方案的预算口径不同：基准为「${MODEL_LABELS[baselineModelVersion] ?? `v${baselineModelVersion}`}」，对照为「${MODEL_LABELS[comparisonModelVersion] ?? `v${comparisonModelVersion}`}」。完成时间均按各自保存时的口径冻结展示，时间差混合了参数变化与口径变化；如需纯参数对比，请用相同口径重新保存基准方案。`,
    );
  } else if (baselineModelVersion < BUDGET_MODEL_VERSION) {
    methodologyNotes.push(
      `两份方案均按「${MODEL_LABELS[baselineModelVersion] ?? `v${baselineModelVersion}`}」保存，完成时间维持原值不变；新口径下重新保存才会按主/降级分列展示。`,
    );
  }
  return {
    deltaMs: comparison.completionMs - baseline.completionMs,
    changes,
    outcome:
      comparison.completionMs < baseline.completionMs
        ? "faster"
        : comparison.completionMs > baseline.completionMs
          ? "slower"
          : "equal",
    baselineModelVersion,
    comparisonModelVersion,
    methodologyNotes,
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
    modelVersion: result.modelVersion,
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
