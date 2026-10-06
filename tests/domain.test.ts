import { describe, expect, it } from "vitest";
import { analyzeGraph } from "../src/shared/domain/graph";
import { EXAMPLE_PROJECT } from "../src/shared/domain/types";
import { simulateProject } from "../src/shared/domain/simulation";
import {
  addRequestNode,
  toggleDependency,
} from "../src/features/graph-editor/graphViewModel";

describe("request dependency graph", () => {
  it("orders a DAG and detects a cycle before simulation", () => {
    const project = structuredClone(EXAMPLE_PROJECT);
    expect(analyzeGraph(project).order).toHaveLength(project.nodes.length);
    const cyclic = {
      ...project,
      nodes: project.nodes.map((node) =>
        node.id === "session" ? { ...node, dependencyIds: ["profile"] } : node,
      ),
    };
    expect(analyzeGraph(cyclic).validation.errors.join(" ")).toContain(
      "循环依赖",
    );
    expect(simulateProject(cyclic).entries).toHaveLength(0);
  });

  it("rejects cyclic edges and accepts valid dependencies", () => {
    const project = {
      ...EXAMPLE_PROJECT,
      nodes: EXAMPLE_PROJECT.nodes.slice(0, 3),
    };
    const accepted = toggleDependency(project, "profile", "flags");
    expect(accepted.error).toBeUndefined();
    const rejected = toggleDependency(accepted.project, "flags", "profile");
    expect(rejected.error).toContain("循环");
    expect(rejected.project).toEqual(accepted.project);
  });

  it("schedules independent roots in parallel and serializes them at concurrency one", () => {
    const project = {
      ...EXAMPLE_PROJECT,
      nodes: EXAMPLE_PROJECT.nodes.slice(0, 2).map((node) => ({
        ...node,
        durationMs: 300,
        jitterMs: 0,
        timeoutMs: 1000,
        retryCount: 0,
        failureRate: 0,
      })),
    };
    const parallel = simulateProject(project);
    const serial = simulateProject({ ...project, concurrencyLimit: 1 });
    expect(parallel.completionMs).toBe(300);
    expect(serial.completionMs).toBe(600);
    expect(serial.entries[1]?.waitMs).toBe(300);
  });

  it("applies jitter modes, timeout caps, bounded retries, and fallback probability", () => {
    const node = {
      id: "a",
      name: "slow",
      durationMs: 1200,
      jitterMs: 400,
      dependencyIds: [],
      timeoutMs: 1000,
      retryCount: 1,
      failureRate: 50,
      fallbackNodeId: "b",
    };
    const fallback = {
      ...node,
      id: "b",
      name: "fallback",
      durationMs: 200,
      jitterMs: 0,
      timeoutMs: 500,
      retryCount: 0,
      failureRate: 0,
      fallbackNodeId: undefined,
    };
    const project = { ...EXAMPLE_PROJECT, nodes: [node, fallback] };
    const low = simulateProject(project, "low");
    const expected = simulateProject(project, "expected");
    const high = simulateProject(project, "high");
    expect(low.completionMs).toBeLessThanOrEqual(expected.completionMs);
    expect(expected.completionMs).toBeLessThanOrEqual(high.completionMs);
    expect(high.warnings.join(" ")).toContain("超时");
    // v2 口径：主路径（必然发生）与降级路径（按最终失败概率折算）拆开表达。
    // high 模式主路径 1600ms；最终失败概率 0.5²=0.25，降级目标 200ms × 0.25 = 50ms。
    const main = high.entries[0];
    expect(main?.modeledDurationMs).toBe(1600);
    expect(main?.fallbackWeightedMs).toBe(50);
    expect(main?.scheduledEndMs).toBe(1650);
    expect(high.completionMs).toBe(1650);
    expect(high.fallbacks).toHaveLength(1);
    expect(high.fallbacks[0]).toMatchObject({
      ownerNodeId: "a",
      targetNodeId: "b",
      rawDurationMs: 200,
      modeledDurationMs: 50,
      triggerProbability: 0.25,
    });
    // 降级条紧接主路径之后分行呈现，而不是并入主条。
    expect(high.fallbacks[0]?.startMs).toBe(main?.endMs);
    const invalid = {
      ...project,
      nodes: [{ ...node, retryCount: 9 }, fallback],
    };
    expect(simulateProject(invalid).entries).toHaveLength(0);
  });

  it("creates an editable request node with safe defaults", () => {
    const project = { ...EXAMPLE_PROJECT, nodes: [] };
    const next = addRequestNode(project);
    expect(next.nodes).toHaveLength(1);
    expect(next.nodes[0]?.durationMs).toBe(400);
    expect(next.nodes[0]?.dependencyIds).toEqual([]);
  });

  function fallbackNode(
    id: string,
    name: string,
    patch: Partial<{
      durationMs: number;
      failureRate: number;
      retryCount: number;
      fallbackNodeId: string;
    }> = {},
  ) {
    return {
      id,
      name,
      durationMs: 100,
      jitterMs: 0,
      dependencyIds: [],
      timeoutMs: 100_000,
      retryCount: 0,
      failureRate: 0,
      ...patch,
    };
  }

  it("weights chained fallbacks by the conditional probability along the chain", () => {
    // 单主节点 a 50% → b(200ms, 50%) → c(300ms)；b、c 仅作降级目标。
    const a = fallbackNode("a", "主请求", {
      durationMs: 100,
      failureRate: 50,
      fallbackNodeId: "b",
    });
    const b = fallbackNode("b", "一级降级", {
      durationMs: 200,
      failureRate: 50,
      fallbackNodeId: "c",
    });
    const c = fallbackNode("c", "二级降级", { durationMs: 300 });
    const project = { ...EXAMPLE_PROJECT, nodes: [a, b, c] };
    const result = simulateProject(project);
    const main = result.entries.find((entry) => entry.nodeId === "a")!;
    expect(main.modeledDurationMs).toBe(100); // 主路径不折算
    // 直连降级 200 × 0.5 = 100；下游 300 × (0.5 × 0.5) = 75
    expect(main.fallbackWeightedMs).toBe(175);
    expect(main.scheduledEndMs).toBe(275);
    // b、c 仍是 DAG 中的入口请求，按完整拓扑序各自调度（v1 即如此）。
    expect(result.entries).toHaveLength(3);
    // 归属到 a 的降级行：直连 + 下游两行，时序上紧接 a 的主路径。
    const ownedByA = result.fallbacks.filter((f) => f.ownerNodeId === "a");
    expect(ownedByA).toHaveLength(2);
    const direct = ownedByA[0]!;
    const chained = ownedByA[1]!;
    expect(direct).toMatchObject({
      ownerNodeId: "a",
      targetNodeId: "b",
      rawDurationMs: 200,
      modeledDurationMs: 100,
      triggerProbability: 0.5,
    });
    expect(direct.chained).toBeUndefined();
    expect(chained).toMatchObject({
      ownerNodeId: "a",
      targetNodeId: "c",
      rawDurationMs: 300,
      modeledDurationMs: 75,
      triggerProbability: 0.25,
      chained: true,
    });
    // 整体完成时刻：b 自身 200 + 其降级到 c 折算 150 = 350，与 a 的 275 并行取最晚。
    expect(result.completionMs).toBe(350);
  });

  it("cuts off fallback chains that loop back onto themselves", () => {
    const a = fallbackNode("a", "A", {
      failureRate: 50,
      fallbackNodeId: "b",
    });
    const b = fallbackNode("b", "B", {
      durationMs: 200,
      failureRate: 50,
      fallbackNodeId: "a",
    });
    const project = { ...EXAMPLE_PROJECT, nodes: [a, b] };
    const result = simulateProject(project);
    // 只保留直连降级，成环处不再向下折算
    expect(result.fallbacks).toHaveLength(2);
    expect(result.fallbacks.every((f) => f.chained !== true)).toBe(true);
    expect(result.warnings.join(" ")).toContain("降级链");
  });

  it("keeps main and fallback lanes on separate timeline rows", () => {
    const a = fallbackNode("a", "主请求", {
      durationMs: 400,
      failureRate: 100,
      retryCount: 0,
      fallbackNodeId: "b",
    });
    const b = fallbackNode("b", "降级", { durationMs: 100 });
    const project = { ...EXAMPLE_PROJECT, nodes: [a, b] };
    const result = simulateProject(project);
    const main = result.entries[0];
    expect(main?.endMs).toBe(400);
    expect(result.fallbacks[0]?.startMs).toBe(400); // 降级条紧接主路径结束
    expect(result.fallbacks[0]?.modeledDurationMs).toBe(100); // 100% 必失败 → 全额
  });
});
