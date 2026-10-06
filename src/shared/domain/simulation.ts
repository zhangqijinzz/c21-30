import { analyzeGraph } from "./graph";
import { BUDGET_MODEL_VERSION } from "./types";
import type {
  FallbackBranch,
  LatencyProject,
  RequestNode,
  SimulationMode,
  SimulationResult,
  TimelineEntry,
} from "./types";

interface NodeCost {
  /** 截断后的单次请求耗时。 */
  serviceMs: number;
  /** 必然发生：首次请求耗时。 */
  guaranteedMs: number;
  /** 按逐层失败概率折算：额外重试请求与指数退避。 */
  retryMs: number;
  /** 自身总耗时（guaranteed + retry），不含降级。 */
  ownMs: number;
  /** 重试全部失败的概率 f^(retryCount+1)，即降级路径触发概率。 */
  terminalFailureProbability: number;
}

/**
 * 把一个节点拆成三段口径：
 * - guaranteed：第一次请求一定发生；
 * - retry：第 n 次重试只在前 n 次都失败时发生，按概率折算，退避同理；
 * - terminalFailure：所有尝试都失败的概率，降级只在这条链路上发生。
 */
function nodeCost(node: RequestNode, mode: SimulationMode): NodeCost {
  const jitterFactor = mode === "low" ? 0 : mode === "high" ? 1 : 0.5;
  const serviceMs = Math.min(
    node.durationMs + node.jitterMs * jitterFactor,
    node.timeoutMs || Number.POSITIVE_INFINITY,
  );
  const failure = node.failureRate / 100;
  let elapsed = 0;
  let priorFailures = 1;
  for (let attempt = 0; attempt <= node.retryCount; attempt += 1) {
    elapsed += priorFailures * serviceMs;
    priorFailures *= failure;
    if (attempt < node.retryCount)
      elapsed += priorFailures * Math.min(200 * 2 ** attempt, 2_000);
  }
  return {
    serviceMs,
    guaranteedMs: serviceMs,
    retryMs: elapsed - serviceMs,
    ownMs: elapsed,
    terminalFailureProbability: priorFailures,
  };
}

/**
 * 展开一条降级路径。入口概率是 owner 重试全部失败的概率 p；
 * 链上每多一级“降级目标自己再降级”，该段触发概率再乘上目标自身的
 * 最终失败概率——每一级都只在前面的失败链路上发生，所以概率逐级连乘。
 * 降级成环（理论上已在校验阶段拦截）时截断并标记，避免无限展开。
 */
function buildFallbackBranch(
  owner: RequestNode,
  byId: Map<string, RequestNode>,
  costs: Map<string, NodeCost>,
  sharedDownstreamIds: string[],
): FallbackBranch {
  const entryProbability =
    costs.get(owner.id)?.terminalFailureProbability ?? 0;
  const segments = [];
  let weightedMs = 0;
  let probability = entryProbability;
  const chainVisited = new Set<string>([owner.id]);
  let currentId = owner.fallbackNodeId;
  let cycleTruncated = false;
  let first = true;
  while (currentId) {
    const target = byId.get(currentId);
    if (!target) break;
    if (chainVisited.has(currentId)) {
      cycleTruncated = true;
      break;
    }
    chainVisited.add(currentId);
    const ownMs = costs.get(currentId)?.ownMs ?? 0;
    const segmentWeighted = probability * ownMs;
    weightedMs += segmentWeighted;
    segments.push({
      nodeId: currentId,
      probability,
      weightedMs: segmentWeighted,
      ownMs,
      kind: first ? ("target" as const) : ("chained" as const),
    });
    const nextProbability =
      costs.get(currentId)?.terminalFailureProbability ?? 0;
    currentId = target.fallbackNodeId;
    probability *= nextProbability;
    first = false;
  }
  return {
    ownerId: owner.id,
    targetId: segments[0]?.nodeId ?? owner.fallbackNodeId ?? "",
    terminalFailureProbability: entryProbability,
    weightedMs,
    segments,
    sharedDownstreamIds,
    ...(cycleTruncated ? { cycleTruncated: true } : {}),
  };
}

export function simulateProject(
  project: LatencyProject,
  mode: SimulationMode = "expected",
): SimulationResult {
  const analysis = analyzeGraph(project);
  if (analysis.validation.errors.length) {
    return {
      mode,
      completionMs: 0,
      criticalPath: [],
      entries: [],
      warnings: analysis.validation.errors,
      budget: { guaranteedMs: 0, fallbackMs: 0, fallbackBranches: [] },
      modelVersion: BUDGET_MODEL_VERSION,
    };
  }

  const byId = new Map(project.nodes.map((node) => [node.id, node]));
  const costs = new Map(
    project.nodes.map((node) => [node.id, nodeCost(node, mode)]),
  );

  // 反向依赖：target 在主排布里的下游。这些请求无论是否走到降级都会
  // 正常执行，降级路径不把它们再算一遍，只在 branch 上点名说明。
  const dependents = new Map<string, string[]>();
  for (const node of project.nodes)
    for (const dependencyId of node.dependencyIds) {
      const list = dependents.get(dependencyId) ?? [];
      list.push(node.id);
      dependents.set(dependencyId, list);
    }
  const collectDownstream = (startId: string, ownerId: string): string[] => {
    const reached = new Set<string>();
    const queue = [startId];
    while (queue.length) {
      const id = queue.shift()!;
      for (const next of dependents.get(id) ?? []) {
        if (reached.has(next) || next === ownerId) continue;
        reached.add(next);
        queue.push(next);
      }
    }
    // 按稳定拓扑顺序输出，便于界面展示
    return analysis.order.filter((id) => reached.has(id));
  };

  // 每个节点“拥有”一条以其降级目标为入口的条件路径。
  const branches = new Map<string, FallbackBranch>();
  for (const node of project.nodes) {
    if (!node.fallbackNodeId) continue;
    branches.set(
      node.id,
      buildFallbackBranch(
        node,
        byId,
        costs,
        collectDownstream(node.fallbackNodeId, node.id),
      ),
    );
  }

  const durations = new Map<string, number>();
  for (const node of project.nodes) {
    const cost = costs.get(node.id)!;
    durations.set(
      node.id,
      cost.ownMs + (branches.get(node.id)?.weightedMs ?? 0),
    );
  }

  const concurrency =
    project.concurrencyLimit ?? Math.max(1, project.nodes.length);
  const slots = Array.from(
    { length: Math.max(1, Math.min(concurrency, project.nodes.length || 1)) },
    (_, index) => ({
      index,
      endMs: 0,
      nodeId: undefined as string | undefined,
    }),
  );
  const entries: TimelineEntry[] = [];
  for (const id of analysis.order) {
    const node = byId.get(id);
    if (!node) continue;
    const cost = costs.get(id)!;
    const branch = branches.get(id);
    const slot = slots.reduce(
      (best, candidate) => (candidate.endMs < best.endMs ? candidate : best),
      slots[0]!,
    );
    const dependencyEntries = node.dependencyIds
      .map((dependencyId) =>
        entries.find((entry) => entry.nodeId === dependencyId),
      )
      .filter((entry): entry is TimelineEntry => Boolean(entry));
    const latestDependency = dependencyEntries.reduce<
      TimelineEntry | undefined
    >(
      (latest, entry) =>
        !latest || entry.endMs > latest.endMs ? entry : latest,
      undefined,
    );
    const startMs = Math.max(slot.endMs, latestDependency?.endMs ?? 0);
    const resourceBlocked = slot.endMs > (latestDependency?.endMs ?? 0);
    const predecessor = resourceBlocked
      ? slot.nodeId
      : latestDependency?.nodeId;
    const fallbackMs = branch?.weightedMs ?? 0;
    const modeledDurationMs = durations.get(id) ?? 0;
    const endMs = startMs + modeledDurationMs;
    entries.push({
      nodeId: id,
      startMs,
      endMs,
      modeledDurationMs,
      waitMs: Math.max(
        0,
        startMs -
          dependencyEntries.reduce(
            (end, entry) => Math.max(end, entry.endMs),
            0,
          ),
      ),
      guaranteedMs: cost.guaranteedMs,
      retryMs: cost.retryMs,
      fallbackMs,
      fallbackBranches: branch ? [branch] : [],
      ...(predecessor ? { criticalPredecessorId: predecessor } : {}),
    });
    slot.endMs = endMs;
    slot.nodeId = id;
  }

  const lastEntry = entries.reduce<TimelineEntry | undefined>(
    (latest, entry) => (!latest || entry.endMs > latest.endMs ? entry : latest),
    undefined,
  );
  const pathById = new Map<string, string[]>();
  for (const entry of entries)
    pathById.set(entry.nodeId, [
      ...(entry.criticalPredecessorId
        ? (pathById.get(entry.criticalPredecessorId) ?? [])
        : []),
      entry.nodeId,
    ]);
  const criticalPath = lastEntry
    ? (pathById.get(lastEntry.nodeId) ?? [])
    : [];
  const criticalEntries = criticalPath.map(
    (id) => entries.find((entry) => entry.nodeId === id)!,
  );
  // 完成预算口径：关键链上“必然部分”（首次请求 + 失败折算的重试）
  // 与“失败链路上才发生”的降级折算分列，二者相加等于完成预算。
  const budget = {
    guaranteedMs: criticalEntries.reduce(
      (sum, entry) => sum + entry.guaranteedMs + entry.retryMs,
      0,
    ),
    fallbackMs: criticalEntries.reduce(
      (sum, entry) => sum + entry.fallbackMs,
      0,
    ),
    fallbackBranches: criticalEntries.flatMap((entry) => entry.fallbackBranches),
  };
  const warnings = [...analysis.validation.warnings];
  if (
    project.nodes.some(
      (node) =>
        node.timeoutMs > 0 &&
        node.durationMs +
          node.jitterMs *
            (mode === "high" ? 1 : mode === "expected" ? 0.5 : 0) >
          node.timeoutMs,
    )
  ) {
    warnings.push("部分节点会触发超时截断，已计入重试与退避预算");
  }
  if (analysis.fallbackCycle.length) {
    warnings.push(
      `降级链路存在循环：${analysis.fallbackCycle
        .map((id) => byId.get(id)?.name ?? id)
        .join(" → ")}，降级折算已在成环处截断`,
    );
  }
  return {
    mode,
    completionMs: lastEntry?.endMs ?? 0,
    criticalPath,
    entries,
    warnings,
    budget,
    modelVersion: BUDGET_MODEL_VERSION,
  };
}
