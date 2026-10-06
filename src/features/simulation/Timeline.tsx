import type {
  FallbackPathBudget,
  LatencyProject,
  SimulationResult,
} from "../../shared/domain/types";

interface Props {
  project: LatencyProject;
  result: SimulationResult;
}

function formatTime(value: number): string {
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(2)} s`;
}

function formatPercent(probability: number): string {
  const percent = probability * 100;
  if (percent >= 0.05) return `${percent.toFixed(percent < 10 ? 1 : 0)}%`;
  return `${percent.toFixed(2)}%`;
}

function nodeName(project: LatencyProject, id: string): string {
  return project.nodes.find((item) => item.id === id)?.name ?? id;
}

interface FallbackRow {
  fallback: FallbackPathBudget;
  ownerName: string;
  targetName: string;
}

export default function Timeline({ project, result }: Props) {
  const max = Math.max(1, result.completionMs);
  const critical = new Set(result.criticalPath);
  const marks = [0, 0.25, 0.5, 0.75, 1];

  // 一个主节点可能对应直连降级 + 下游降级两行；按主节点出现顺序归组展示。
  const fallbackGroups = new Map<string, FallbackRow[]>();
  for (const fallback of result.fallbacks) {
    const group = fallbackGroups.get(fallback.ownerNodeId) ?? [];
    group.push({
      fallback,
      ownerName: nodeName(project, fallback.ownerNodeId),
      targetName: nodeName(project, fallback.targetNodeId),
    });
    fallbackGroups.set(fallback.ownerNodeId, group);
  }

  return (
    <div className="timeline-card">
      <div className="timeline-head">
        <div>
          <span className="section-label">执行时序</span>
          <span className="timeline-caption">
            主路径与降级路径分行 · 降级条按失败概率折算
          </span>
        </div>
        <div className="timeline-legend">
          <span>
            <i className="legend-normal" /> 主路径（必然发生）
          </span>
          <span>
            <i className="legend-critical" /> 关键路径
          </span>
          <span>
            <i className="legend-fallback" /> 降级路径（按概率折算）
          </span>
          <span>
            <i className="legend-wait" /> 等待
          </span>
        </div>
      </div>
      <div className="timeline-axis">
        <div className="axis-label">REQUEST / FALLBACK</div>
        <div className="axis-track">
          {marks.map((mark) => (
            <span key={mark} style={{ left: `${mark * 100}%` }}>
              {formatTime(max * mark)}
            </span>
          ))}
        </div>
        <div className="axis-end">DURATION</div>
      </div>
      {result.entries.map((entry, index) => {
        const node = project.nodes.find((item) => item.id === entry.nodeId);
        if (!node) return null;
        const start = (entry.startMs / max) * 100;
        const width = Math.max(1.2, (entry.modeledDurationMs / max) * 100);
        const rows = fallbackGroups.get(entry.nodeId) ?? [];
        return (
          <div className="timeline-lane-group" key={entry.nodeId}>
            <div className="timeline-row">
              <div className="timeline-name">
                <span className={`timeline-icon tone-${index % 4}`}>
                  {node.name.slice(0, 1)}
                </span>
                <span>
                  <b>{node.name}</b>
                  <small>
                    {entry.waitMs > 0
                      ? `排队 ${formatTime(entry.waitMs)} · 主路径必然执行`
                      : "主路径 · 必然执行"}
                  </small>
                </span>
              </div>
              <div className="timeline-track">
                <div className="timeline-grid" />
                {entry.waitMs > 0 && (
                  <div
                    className="wait-bar"
                    style={{
                      left: `${Math.max(0, ((entry.startMs - entry.waitMs) / max) * 100)}%`,
                      width: `${(entry.waitMs / max) * 100}%`,
                    }}
                  />
                )}
                <div
                  className={`duration-bar ${critical.has(entry.nodeId) ? "is-critical" : ""} tone-${index % 4}`}
                  style={{
                    left: `${start}%`,
                    width: `${Math.min(width, 100 - start)}%`,
                  }}
                >
                  <span>{formatTime(entry.modeledDurationMs)}</span>
                </div>
                {entry.fallbackWeightedMs > 0 && (
                  <div
                    className="main-fallback-slot"
                    style={{
                      left: `${(entry.endMs / max) * 100}%`,
                      width: `${(entry.fallbackWeightedMs / max) * 100}%`,
                    }}
                    title={`该节点折算后的降级占用共 ${formatTime(entry.fallbackWeightedMs)}，明细见下方降级行`}
                  />
                )}
              </div>
              <div className="timeline-end">
                {formatTime(entry.scheduledEndMs)}
              </div>
            </div>
            {rows.map(({ fallback, ownerName, targetName }, rowIndex) => {
              const fbStart = (fallback.startMs / max) * 100;
              const fbWidth = Math.max(
                0.8,
                (fallback.modeledDurationMs / max) * 100,
              );
              const isChained = fallback.chained === true;
              return (
                <div
                  className={`timeline-row timeline-row-fallback${isChained ? " is-chained" : ""}`}
                  key={`${fallback.ownerNodeId}-${fallback.targetNodeId}-${rowIndex}`}
                >
                  <div className="timeline-name fallback-name">
                    <span className="fallback-branch-icon">
                      {isChained ? "⇝" : "↳"}
                    </span>
                    <span>
                      <b>
                        {isChained ? "下游降级 · " : "失败降级 · "}
                        {targetName}
                      </b>
                      <small>
                        仅“{ownerName}”最终失败时触发 · 触发概率{" "}
                        {formatPercent(fallback.triggerProbability)}
                      </small>
                    </span>
                  </div>
                  <div className="timeline-track">
                    <div className="timeline-grid" />
                    <div
                      className="fallback-bar"
                      style={{
                        left: `${fbStart}%`,
                        width: `${Math.min(fbWidth, 100 - fbStart)}%`,
                      }}
                      title={`原始耗时 ${formatTime(fallback.rawDurationMs)} × 触发概率 ${formatPercent(fallback.triggerProbability)} = 折算 ${formatTime(fallback.modeledDurationMs)}`}
                    >
                      <span className="fallback-label">
                        {formatTime(fallback.rawDurationMs)} ×{" "}
                        {formatPercent(fallback.triggerProbability)} ={" "}
                        <b>{formatTime(fallback.modeledDurationMs)}</b>
                      </span>
                    </div>
                  </div>
                  <div className="timeline-end fallback-end">
                    {formatPercent(fallback.triggerProbability)}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
      {!result.entries.length && (
        <div className="timeline-empty">修复链路配置后即可生成时序预览。</div>
      )}
    </div>
  );
}
