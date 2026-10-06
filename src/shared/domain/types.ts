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
  /** 保存时锁定的完成预算，不随后续口径调整而改变（旧方案即 v1 口径） */
  completionMs: number;
  criticalPath: string[];
  /**
   * 保存该快照时使用的预算口径。缺省视为 1（降级耗时并入主节点）；
   * 2 为主路径 / 降级路径拆分折算。
   */
  budgetVersion?: 1 | 2;
  /**
   * 按当前口径重算的完成预算，仅用于和锁定值 completionMs 对照；
   * 旧快照首次被读取时由仓库补齐，不覆盖原锁定值。
   */
  recomputedCompletionMs?: number;
  /** 重算口径版本；与 budgetVersion 不同即说明差额来自口径调整而非参数变化 */
  recomputedBudgetVersion?: 1 | 2;
  /** 保存快照时使用的波动情境（旧快照缺省按 expected 重算） */
  simulationMode?: SimulationMode;
}

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

/**
 * 主路径预算：请求本身（含超时截断、重试与退避），只要走到该节点就必然发生。
 */
export interface MainPathBudget {
  kind: "main";
  nodeId: string;
  startMs: number;
  /** 主路径自身结束时刻（不含折算降级），降级条从这里开始 */
  endMs: number;
  /** 主路径自身耗时（必然发生，不做概率折算） */
  modeledDurationMs: number;
  /** 折算后的降级耗时（含下游降级），用于调度占位与口径汇总 */
  fallbackWeightedMs: number;
  /** 该节点在期望调度口径下占用到的时刻 = endMs + fallbackWeightedMs */
  scheduledEndMs: number;
  waitMs: number;
  criticalPredecessorId?: string;
}

/**
 * 降级路径预算：仅在主路径所有尝试最终失败后触发，按最终失败概率折算。
 * 与主路径在时间线上分行呈现，避免被误读为每次必然执行。
 */
export interface FallbackPathBudget {
  kind: "fallback";
  /** 触发降级的主节点 id */
  ownerNodeId: string;
  /** 实际承接的降级目标节点 id（沿 fallback 链解析到的第一个可达目标） */
  targetNodeId: string;
  startMs: number;
  endMs: number;
  /** 原始耗时：降级真正被触发时，目标链路实际占用的时间 */
  rawDurationMs: number;
  /** 折算耗时 = rawDurationMs × triggerProbability */
  modeledDurationMs: number;
  /** 触发概率：主节点全部尝试（含重试）最终失败的概率 0–1 */
  triggerProbability: number;
  /** 是否为降级目标继续向下游的第二级降级 */
  chained?: boolean;
}

export type TimelineEntry = MainPathBudget;

export interface SimulationResult {
  mode: SimulationMode;
  completionMs: number;
  criticalPath: string[];
  entries: TimelineEntry[];
  /** 降级路径预算，与主路径分行呈现；金额均按触发概率折算 */
  fallbacks: FallbackPathBudget[];
  warnings: string[];
  /** 预算口径版本：v1 为旧口径（降级耗时并入主节点），v2 为主/降级拆分 */
  budgetVersion: 2;
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
