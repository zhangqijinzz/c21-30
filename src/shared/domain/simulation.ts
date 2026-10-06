import { analyzeGraph } from "./graph";
import type {
  FallbackPathBudget,
  LatencyProject,
  RequestNode,
  SimulationMode,
  SimulationResult,
  TimelineEntry,
} from "./types";

/**
 * 预算口径 v2：
 * - 主路径（请求自身 + 超时截断 + 重试 + 退避）：节点一旦被执行就必然发生，按确定性期望值计入；
 * - 降级路径：仅在主路径全部尝试最终失败时触发，按最终失败概率折算，单独成行展示；
 * - 降级目标若仍有下游降级，则其下游分支只在“目标也最终失败”时才继续，
 *   触发概率需要再乘上目标自身的最终失败概率（条件概率连乘）。
 *
 * 数值上每个节点的期望总耗时仍为「主路径 + 各降级分支折算耗时」，
 * 因此对没有下游降级的既有配置，completionMs 与 v1 口径完全一致，
 * 只是把按概率折算的部分从主路径条上拆出来表达归属。
 */

function serviceTime(node: RequestNode, mode: SimulationMode): number {
  const jitterFactor = mode === "low" ? 0 : mode === "high" ? 1 : 0.5;
  return Math.min(
    node.durationMs + node.jitterMs * jitterFactor,
    node.timeoutMs || Number.POSITIVE_INFINITY,
  );
}

/** 主路径耗时：截断后的请求耗时按失败重试概率加权 + 指数退避（必然发生的期望投入）。 */
export function expectedAttempts(
  node: RequestNode,
  mode: SimulationMode,
): number {
  const serviceMs = serviceTime(node, mode);
  const failure = node.failureRate / 100;
  let elapsed = 0;
  let priorFailures = 1;
  for (let attempt = 0; attempt <= node.retryCount; attempt += 1) {
    elapsed += priorFailures * serviceMs;
    priorFailures *= failure;
    if (attempt < node.retryCount)
      elapsed += priorFailures * Math.min(200 * 2 ** attempt, 2_000);
  }
  return elapsed;
}

/** 主路径所有尝试（含重试）最终失败的概率，即降级被触发的概率。 */
export function terminalFailureProbability(node: RequestNode): number {
  return (node.failureRate / 100) ** (node.retryCount + 1);
}

interface FallbackBranch {
  ownerId: string;
  /** 直接承接的降级目标 */
  targetId: string;
  /** 直接降级目标的主路径原始耗时（未折算） */
  rawMs: number;
  /** 直接降级的触发概率 = owner 最终失败概率 */
  triggerProbability: number;
  /** 目标自身也失败后继续降级时的下游目标 */
  chainedTargetId?: string;
  /** 下游目标的主路径原始耗时（未折算） */
  chainedRawMs?: number;
  /** 下游分支触发概率 = owner 失败概率 × 目标失败概率（条件概率连乘） */
  chainedTriggerProbability?: number;
  /** 降级链是否回到链上节点（成环则在成环处截断） */
  cycle: boolean;
}

function buildFallbackBranches(
  project: LatencyProject,
  byId: Map<string, RequestNode>,
  mode: SimulationMode,
): { branches: FallbackBranch[]; warnings: string[] } {
  const warnings: string[] = [];
  const baseMs = new Map(
    project.nodes.map((node) => [node.id, expectedAttempts(node, mode)]),
  );
  const branches: FallbackBranch[] = [];

  for (const owner of project.nodes) {
    const targetId = owner.fallbackNodeId;
    if (!targetId) continue;
    const target = byId.get(targetId);
    if (!target) continue;

    const ownerFail = terminalFailureProbability(owner);
    const branch: FallbackBranch = {
      ownerId: owner.id,
      targetId: target.id,
      rawMs: baseMs.get(target.id) ?? 0,
      triggerProbability: ownerFail,
      cycle: false,
    };

    // 目标自身还有下游降级时，只在“目标也最终失败”后才继续，概率再乘一层。
    const chainedId = target.fallbackNodeId;
    if (chainedId) {
      if (chainedId === owner.id || chainedId === target.id) {
        branch.cycle = true;
      } else {
        const chained = byId.get(chainedId);
        if (chained) {
          branch.chainedTargetId = chained.id;
          branch.chainedRawMs = baseMs.get(chained.id) ?? 0;
          branch.chainedTriggerProbability =
            ownerFail * terminalFailureProbability(target);
        }
      }
    }
    branches.push(branch);
  }

  for (const branch of branches) {
    if (branch.cycle) {
      const ownerName =
        project.nodes.find((node) => node.id === branch.ownerId)?.name ??
        branch.ownerId;
      warnings.push(
        `${ownerName}: 降级链回到了链上节点，成环处不再继续折算降级耗时`,
      );
    }
  }
  return { branches, warnings };
}

/**
 * 降级目标与正常请求的归属判定：DAG 中每个节点都会作为正常请求被调度
 * （没有依赖边的节点是入口请求）；fallback 边只决定“失败后转给谁”，
 * 不改变目标节点本身是否执行。因此调度仍按完整拓扑序进行，
 * 降级折算只体现在拥有 fallbackNodeId 的节点上，并单独成行展示。
 */
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
      fallbacks: [],
      warnings: analysis.validation.errors,
      budgetVersion: 2,
    };
  }

  const byId = new Map(project.nodes.map((node) => [node.id, node]));
  const baseDurations = new Map(
    project.nodes.map((node) => [node.id, expectedAttempts(node, mode)]),
  );
  const { branches, warnings: fallbackWarnings } = buildFallbackBranches(
    project,
    byId,
    mode,
  );
  const branchByOwner = new Map(
    branches.map((branch) => [branch.ownerId, branch]),
  );

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
        !latest || entry.scheduledEndMs > latest.scheduledEndMs
          ? entry
          : latest,
      undefined,
    );
    const startMs = Math.max(slot.endMs, latestDependency?.scheduledEndMs ?? 0);
    const resourceBlocked =
      slot.endMs > (latestDependency?.scheduledEndMs ?? 0);
    const predecessor = resourceBlocked
      ? slot.nodeId
      : latestDependency?.nodeId;
    const mainDurationMs = baseDurations.get(id) ?? 0;
    const branch = branchByOwner.get(id);
    const fallbackWeightedMs = branch
      ? branch.rawMs * branch.triggerProbability +
        (branch.chainedRawMs !== undefined && branch.chainedTriggerProbability
          ? branch.chainedRawMs * branch.chainedTriggerProbability
          : 0)
      : 0;
    const scheduledEndMs = startMs + mainDurationMs + fallbackWeightedMs;
    entries.push({
      kind: "main",
      nodeId: id,
      startMs,
      endMs: startMs + mainDurationMs,
      modeledDurationMs: mainDurationMs,
      fallbackWeightedMs,
      scheduledEndMs,
      waitMs: Math.max(
        0,
        startMs -
          dependencyEntries.reduce(
            (end, entry) => Math.max(end, entry.scheduledEndMs),
            0,
          ),
      ),
      ...(predecessor ? { criticalPredecessorId: predecessor } : {}),
    });
    slot.endMs = scheduledEndMs;
    slot.nodeId = id;
  }

  // 降级路径预算：紧接主节点主路径之后排布（条件时序），独立成行，
  // 只用于表达归属与折算口径；折算值已经包含在主节点的期望占用里，不再叠加进 completionMs。
  const fallbacks: FallbackPathBudget[] = [];
  for (const branch of branches) {
    const ownerEntry = entries.find((entry) => entry.nodeId === branch.ownerId);
    if (!ownerEntry) continue;
    const mainEnd = ownerEntry.endMs;
    const weightedMs = branch.rawMs * branch.triggerProbability;
    const direct: FallbackPathBudget = {
      kind: "fallback",
      ownerNodeId: branch.ownerId,
      targetNodeId: branch.targetId,
      startMs: mainEnd,
      endMs: mainEnd + weightedMs,
      rawDurationMs: branch.rawMs,
      modeledDurationMs: weightedMs,
      triggerProbability: branch.triggerProbability,
    };
    fallbacks.push(direct);
    if (
      branch.chainedTargetId &&
      branch.chainedRawMs !== undefined &&
      branch.chainedTriggerProbability !== undefined
    ) {
      const chainedWeighted =
        branch.chainedRawMs * branch.chainedTriggerProbability;
      fallbacks.push({
        kind: "fallback",
        ownerNodeId: branch.ownerId,
        targetNodeId: branch.chainedTargetId,
        startMs: direct.endMs,
        endMs: direct.endMs + chainedWeighted,
        rawDurationMs: branch.chainedRawMs,
        modeledDurationMs: chainedWeighted,
        triggerProbability: branch.chainedTriggerProbability,
        chained: true,
      });
    }
  }

  const lastEntry = entries.reduce<TimelineEntry | undefined>(
    (latest, entry) =>
      !latest || entry.scheduledEndMs > latest.scheduledEndMs ? entry : latest,
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
  const warnings = [...analysis.validation.warnings, ...fallbackWarnings];
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
  return {
    mode,
    completionMs: lastEntry?.scheduledEndMs ?? 0,
    criticalPath: lastEntry ? (pathById.get(lastEntry.nodeId) ?? []) : [],
    entries,
    fallbacks,
    warnings,
    budgetVersion: 2,
  };
}
