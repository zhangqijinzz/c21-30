import { describe, expect, it } from "vitest";
import {
  createProject,
  duplicateProject,
  selectProject,
} from "../src/features/projects/projectViewModel";
import {
  compareScenarios,
  describeRecalibration,
  recalibrateSnapshot,
  restoreScenario,
  saveScenario,
} from "../src/features/scenarios/scenarioViewModel";
import { simulateProject } from "../src/shared/domain/simulation";
import { EXAMPLE_PROJECT } from "../src/shared/domain/types";

describe("project and scenario view models", () => {
  it("creates a project and switches the active project", () => {
    const initial = {
      version: 1 as const,
      activeProjectId: EXAMPLE_PROJECT.id,
      projects: [EXAMPLE_PROJECT],
    };
    const created = createProject(initial, 100);
    expect(created.projects).toHaveLength(2);
    expect(created.activeProjectId).not.toBe(EXAMPLE_PROJECT.id);
    expect(selectProject(created, EXAMPLE_PROJECT.id).activeProjectId).toBe(
      EXAMPLE_PROJECT.id,
    );
  });

  it("duplicates a project and remaps its dependency identities", () => {
    const initial = {
      version: 1 as const,
      activeProjectId: EXAMPLE_PROJECT.id,
      projects: [EXAMPLE_PROJECT],
    };
    const duplicated = duplicateProject(initial, EXAMPLE_PROJECT, 10);
    const copy = duplicated.projects[0];
    expect(copy?.nodes[2]?.dependencyIds).toEqual([copy?.nodes[0]?.id]);
    expect(copy?.nodes[4]?.fallbackNodeId).toBe(copy?.nodes[3]?.id);
    expect(copy?.id).not.toBe(EXAMPLE_PROJECT.id);
    expect(copy?.scenarios).toEqual([]);
  });

  it("saves a complete snapshot and restores its parameters", () => {
    const baseline = {
      ...EXAMPLE_PROJECT,
      nodes: EXAMPLE_PROJECT.nodes.slice(0, 2),
    };
    const result = simulateProject(baseline);
    const saved = saveScenario(baseline, result, "并发方案");
    expect(saved.scenarios).toHaveLength(1);
    const changed = {
      ...saved,
      nodes: saved.nodes.map((node) => ({ ...node, durationMs: 999 })),
    };
    const restored = restoreScenario(changed, saved.scenarios[0]?.id ?? "");
    expect(restored.nodes[0]?.durationMs).toBe(baseline.nodes[0]?.durationMs);
  });

  it("describes node and concurrency differences between snapshots", () => {
    const baseline = {
      ...EXAMPLE_PROJECT,
      nodes: EXAMPLE_PROJECT.nodes.slice(0, 2),
    };
    const baselineSnapshot = saveScenario(
      baseline,
      simulateProject(baseline),
      "不限并发",
    ).scenarios[0];
    const changed = {
      ...baseline,
      concurrencyLimit: 1,
      nodes: baseline.nodes.map((node, index) =>
        index === 0 ? { ...node, durationMs: 900 } : node,
      ),
    };
    const changedSnapshot = saveScenario(
      changed,
      simulateProject(changed),
      "串行优化",
    ).scenarios[0];
    if (!baselineSnapshot || !changedSnapshot)
      throw new Error("Scenario fixtures should be saved");
    const comparison = compareScenarios(baselineSnapshot, changedSnapshot);
    expect(comparison.deltaMs).toBeGreaterThan(0);
    expect(comparison.changes.join(" ")).toContain("并发上限");
    expect(comparison.changes.join(" ")).toContain("耗时");
  });

  it("locks legacy v1 completion time and attributes any recompute delta to caliber", () => {
    // a（400ms，50% 失败）→ b（200ms，50% 失败）→ c（300ms），三者均为入口请求。
    // v1 只折算单层降级：a = 400 + 200×0.5 = 500（b 自身 350、c 300 均不占优）；
    // v2 补上下游条件概率：a = 400 + 100 + 300×(0.5×0.5)=75 = 575，成为新的完成时刻。
    const nodes = [
      {
        id: "a",
        name: "主请求",
        durationMs: 400,
        jitterMs: 0,
        dependencyIds: [],
        timeoutMs: 100_000,
        retryCount: 0,
        failureRate: 50,
        fallbackNodeId: "b",
      },
      {
        id: "b",
        name: "一级降级",
        durationMs: 200,
        jitterMs: 0,
        dependencyIds: [],
        timeoutMs: 100_000,
        retryCount: 0,
        failureRate: 50,
        fallbackNodeId: "c",
      },
      {
        id: "c",
        name: "二级降级",
        durationMs: 300,
        jitterMs: 0,
        dependencyIds: [],
        timeoutMs: 100_000,
        retryCount: 0,
        failureRate: 0,
      },
    ];

    // 旧快照：存储里没有 budgetVersion / simulationMode 字段，
    // 读取后按 v1 处理，锁定的 completionMs 保持 500 不被改写。
    const migrated = {
      id: "legacy-1",
      name: "旧方案",
      createdAt: 1_728_000_000_000,
      concurrencyLimit: null,
      nodes: structuredClone(nodes),
      completionMs: 500,
      criticalPath: ["a"],
    };

    const recalibration = recalibrateSnapshot(migrated);
    expect(recalibration.lockedMs).toBe(500); // 锁定值不被改写
    expect(recalibration.recomputedMs).toBe(575); // v2: 400 + 100 + 75
    expect(recalibration.deltaMs).toBe(75);
    expect(recalibration.lockedVersion).toBe(1);
    expect(recalibration.caliberOnly).toBe(true);
    const note = describeRecalibration(recalibration);
    expect(note).toContain("口径");
    expect(note).toContain("75");

    // 单层降级（b 不再有下游）时，v2 与 v1 折算口径一致 → 不产生调整说明。
    const singleLayer = {
      ...migrated,
      nodes: structuredClone(nodes).map((node) =>
        node.id === "b" ? { ...node, fallbackNodeId: undefined } : node,
      ),
    };
    expect(
      describeRecalibration(recalibrateSnapshot(singleLayer)),
    ).toBeUndefined();
  });

  it("saves new snapshots with budget version 2", () => {
    const result = simulateProject(EXAMPLE_PROJECT);
    const saved = saveScenario(EXAMPLE_PROJECT, result, "新方案");
    expect(saved.scenarios[0]?.budgetVersion).toBe(2);
    expect(saved.scenarios[0]?.simulationMode).toBe("expected");
    expect(saved.scenarios[0]?.completionMs).toBe(result.completionMs);
  });
});
