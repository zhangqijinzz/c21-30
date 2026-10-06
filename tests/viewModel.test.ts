import { describe, expect, it } from "vitest";
import {
  createProject,
  duplicateProject,
  selectProject,
} from "../src/features/projects/projectViewModel";
import {
  compareScenarios,
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

  it("stamps new snapshots with model v2 and keeps legacy completion frozen", () => {
    const result = simulateProject(EXAMPLE_PROJECT, "expected");
    const saved = saveScenario(
      EXAMPLE_PROJECT,
      result,
      "新口径方案",
    ).scenarios[0];
    expect(saved?.modelVersion).toBe(2);
    expect(saved?.simulationMode).toBe("expected");
    expect(saved?.completionMs).toBe(result.completionMs);

    // 旧快照（无 modelVersion）按 v1 处理，完成时间不被重算改动
    const legacy = {
      ...saved!,
      id: "legacy",
      name: "旧口径方案",
      modelVersion: undefined,
      completionMs: 4242,
    };
    const comparison = compareScenarios(legacy, saved!);
    expect(comparison.baselineModelVersion).toBe(1);
    expect(comparison.comparisonModelVersion).toBe(2);
    expect(comparison.deltaMs).toBe(result.completionMs - 4242);
    expect(comparison.methodologyNotes.join(" ")).toContain("口径");
  });

  it("does not flag methodology differences between two new-metric snapshots", () => {
    const result = saveScenario(
      EXAMPLE_PROJECT,
      simulateProject(EXAMPLE_PROJECT),
      "a",
    );
    const a = result.scenarios[0]!;
    const b = {
      ...a,
      id: "b",
      name: "b",
      completionMs: a.completionMs + 100,
    };
    expect(compareScenarios(a, b).methodologyNotes).toEqual([]);
  });
});
