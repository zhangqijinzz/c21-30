export interface RequestNode {
  id: string;
  name: string;
  durationMs: number;
  jitterMs: number;
  dependencyIds: string[];
  timeoutMs: number;
  retryCount: number;
  failureRate: number;
  fallbackNodeId?: string;
}

export interface ScenarioSnapshot {
  id: string;
  name: string;
  createdAt: number;
  concurrencyLimit: number | null;
  nodes: RequestNode[];
  completionMs: number;
  criticalPath: string[];
  /** 快照保存时使用的预算口径版本；缺省视为 1（旧口径）。 */
  modelVersion?: number;
  /** 保存时所选波动情境，用于对照口径差异时重算。 */
  simulationMode?: SimulationMode;
}

/** 预算口径版本：1 = 旧口径（仅单层、按最终失败概率加权）；2 = 主/降级路径分列且递归折算。 */
export const BUDGET_MODEL_VERSION = 2;

export interface LatencyProject {
  id: string;
  title: string;
  nodes: RequestNode[];
  concurrencyLimit: number | null;
  scenarios: ScenarioSnapshot[];
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceDocument {
  version: 1;
  activeProjectId: string;
  projects: LatencyProject[];
}

export type SimulationMode = "low" | "expected" | "high";

/** 降级链上的一段条件执行：目标请求自身或其继续降级的目标。 */
export interface FallbackSegment {
  nodeId: string;
  /** 进入到这一段时的累计触发概率（各上游最终失败概率连乘）。 */
  probability: number;
  /** 按触发概率折算后的耗时贡献。 */
  weightedMs: number;
  /** 折算前该段自身的期望耗时。 */
  ownMs: number;
  kind: "target" | "chained";
}

/**
 * 一条降级路径：仅当 owner 节点重试全部失败（概率 terminalFailureProbability）
 * 时才进入。整条路径都按该失败概率折算，不与主路径必然耗时混排。
 */
export interface FallbackBranch {
  ownerId: string;
  targetId: string;
  terminalFailureProbability: number;
  /** 折算后的路径总耗时。 */
  weightedMs: number;
  segments: FallbackSegment[];
  /**
   * 目标请求在主排布里也有下游依赖（它们无论降级与否都会执行），
   * 因此不重复计入降级折算，仅在此点名说明口径。
   */
  sharedDownstreamIds: string[];
  /** 降级成环时被截断，结果不可信。 */
  cycleTruncated?: boolean;
}

export interface TimelineEntry {
  nodeId: string;
  startMs: number;
  endMs: number;
  modeledDurationMs: number;
  waitMs: number;
  criticalPredecessorId?: string;
  /** 必然发生：首次请求的截断耗时。 */
  guaranteedMs: number;
  /** 按逐层失败概率折算：重试请求与指数退避。 */
  retryMs: number;
  /** 按最终失败概率折算：该节点触发的降级路径。 */
  fallbackMs: number;
  /** 该节点拥有（触发）的降级路径，时序上独立成行呈现。 */
  fallbackBranches: FallbackBranch[];
}

export interface BudgetBreakdown {
  /** 主路径必然发生的关键链耗时（含概率折算后的重试）。 */
  guaranteedMs: number;
  /** 关键链上按失败概率折算的降级耗时。 */
  fallbackMs: number;
  /** 对应关键链上的降级路径明细。 */
  fallbackBranches: FallbackBranch[];
}

export interface SimulationResult {
  mode: SimulationMode;
  completionMs: number;
  criticalPath: string[];
  entries: TimelineEntry[];
  warnings: string[];
  /** 完成预算的口径分解：必然部分 vs 失败折算部分。 */
  budget: BudgetBreakdown;
  modelVersion: number;
}

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

export const EXAMPLE_PROJECT: LatencyProject = {
  id: "project-latency-demo",
  title: "商品详情页 · 首屏预算",
  concurrencyLimit: null,
  createdAt: 1_728_000_000_000,
  updatedAt: 1_728_000_000_000,
  scenarios: [],
  nodes: [
    {
      id: "session",
      name: "会话校验",
      durationMs: 280,
      jitterMs: 80,
      dependencyIds: [],
      timeoutMs: 800,
      retryCount: 1,
      failureRate: 1,
    },
    {
      id: "flags",
      name: "功能开关",
      durationMs: 210,
      jitterMs: 50,
      dependencyIds: [],
      timeoutMs: 700,
      retryCount: 0,
      failureRate: 0,
    },
    {
      id: "profile",
      name: "用户资料",
      durationMs: 460,
      jitterMs: 120,
      dependencyIds: ["session"],
      timeoutMs: 1200,
      retryCount: 1,
      failureRate: 3,
    },
    {
      id: "catalog",
      name: "商品目录",
      durationMs: 740,
      jitterMs: 180,
      dependencyIds: ["session"],
      timeoutMs: 1400,
      retryCount: 1,
      failureRate: 2,
    },
    {
      id: "recommend",
      name: "个性推荐",
      durationMs: 520,
      jitterMs: 220,
      dependencyIds: ["flags", "profile"],
      timeoutMs: 1500,
      retryCount: 1,
      failureRate: 5,
      fallbackNodeId: "catalog",
    },
  ],
};

export function createEmptyProject(now = Date.now()): LatencyProject {
  return {
    id: `project-${crypto.randomUUID()}`,
    title: "未命名链路",
    nodes: [],
    concurrencyLimit: null,
    scenarios: [],
    createdAt: now,
    updatedAt: now,
  };
}
