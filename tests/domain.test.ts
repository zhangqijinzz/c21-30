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
    expect(high.entries[0]?.modeledDurationMs).toBe(1650);
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

  it("splits completion budget into guaranteed and failure-probated parts", () => {
    const result = simulateProject(EXAMPLE_PROJECT, "expected");
    const recommend = result.entries.find(
      (entry) => entry.nodeId === "recommend",
    );
    expect(recommend).toBeDefined();
    // 必然 = 首次请求；重试折算单独成段（0.05×630 请求 + 0.05×200 退避）
    expect(recommend!.guaranteedMs).toBeCloseTo(630, 6);
    expect(recommend!.retryMs).toBeCloseTo(41.5, 6);
    // catalog 自身期望耗时 = 830 + 0.02×830 + 0.02×200 = 850.6
    expect(recommend!.fallbackMs).toBeCloseTo(850.6 * 0.0025, 6);
    expect(
      recommend!.guaranteedMs +
        recommend!.retryMs +
        recommend!.fallbackMs,
    ).toBeCloseTo(recommend!.modeledDurationMs, 6);
    // 完成预算两段相加等于 completionMs，且降级独立成路径呈现
    expect(
      result.budget.guaranteedMs + result.budget.fallbackMs,
    ).toBeCloseTo(result.completionMs, 6);
    expect(result.budget.fallbackBranches.length).toBeGreaterThan(0);
    expect(
      result.budget.fallbackBranches[0]?.terminalFailureProbability,
    ).toBeCloseTo(0.0025, 6);
    expect(result.modelVersion).toBe(2);
  });

  it("composes probabilities along a chained fallback (target also degrades)", () => {
    const a = {
      id: "a",
      name: "a",
      durationMs: 100,
      jitterMs: 0,
      dependencyIds: [],
      timeoutMs: 500,
      retryCount: 0,
      failureRate: 50,
      fallbackNodeId: "b",
    };
    const b = {
      ...a,
      id: "b",
      name: "b",
      failureRate: 40,
      fallbackNodeId: "c",
    };
    const c = {
      ...a,
      id: "c",
      name: "c",
      failureRate: 0,
      fallbackNodeId: undefined,
    };
    const project = { ...EXAMPLE_PROJECT, nodes: [a, b, c] };
    const result = simulateProject(project, "expected");
    const branch = result.entries[0]?.fallbackBranches[0];
    expect(branch).toBeDefined();
    expect(branch?.segments).toHaveLength(2);
    // 第一段：0.5 概率进入 b；第二段：0.5 × 0.4 = 0.2 概率继续到 c
    expect(branch?.segments[0]?.probability).toBeCloseTo(0.5, 6);
    expect(branch?.segments[0]?.weightedMs).toBeCloseTo(50, 6);
    expect(branch?.segments[1]?.probability).toBeCloseTo(0.2, 6);
    expect(branch?.segments[1]?.weightedMs).toBeCloseTo(20, 6);
    expect(branch?.weightedMs).toBeCloseTo(70, 6);
    expect(result.entries[0]?.modeledDurationMs).toBeCloseTo(170, 6);
  });

  it("does not double-count the fallback target's main-path downstream requests", () => {
    // recommend 失败降级到 catalog；catalog 有下游 x 依赖它。
    // x 无论是否降级都会执行，只能在主路径计一次，降级路径点名但不折算。
    const x = {
      id: "after-catalog",
      name: "目录埋点",
      durationMs: 100,
      jitterMs: 0,
      dependencyIds: ["catalog"],
      timeoutMs: 500,
      retryCount: 0,
      failureRate: 0,
    };
    const project = {
      ...EXAMPLE_PROJECT,
      nodes: [...EXAMPLE_PROJECT.nodes, x],
    };
    const result = simulateProject(project, "expected");
    const recommend = result.entries.find(
      (entry) => entry.nodeId === "recommend",
    );
    const branch = recommend?.fallbackBranches[0];
    expect(branch?.sharedDownstreamIds).toContain("after-catalog");
    // 降级折算只含 catalog 自身（850.6），不含 x 的 100ms
    expect(branch?.weightedMs).toBeCloseTo(850.6 * 0.0025, 6);
  });

  it("rejects fallback cycles independently from the dependency DAG", () => {
    const a = {
      id: "a",
      name: "a",
      durationMs: 100,
      jitterMs: 0,
      dependencyIds: [],
      timeoutMs: 500,
      retryCount: 0,
      failureRate: 10,
      fallbackNodeId: "b",
    };
    const b = { ...a, id: "b", name: "b", failureRate: 0, fallbackNodeId: "a" };
    const project = { ...EXAMPLE_PROJECT, nodes: [a, b] };
    expect(analyzeGraph(project).fallbackCycle.length).toBeGreaterThan(0);
    expect(analyzeGraph(project).validation.errors.join(" ")).toContain(
      "降级链路存在循环",
    );
    expect(simulateProject(project).entries).toHaveLength(0);
  });
});
