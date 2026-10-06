import { CornerDownRight } from "lucide-react";
import type {
  FallbackBranch,
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
  if (probability <= 0) return "0%";
  if (probability < 0.0001) return "<0.01%";
  return `${(probability * 100).toFixed(2)}%`;
}

interface BranchRowProps {
  project: LatencyProject;
  branch: FallbackBranch;
  anchorStartMs: number;
  max: number;
  critical: boolean;
}

function BranchRow({
  project,
  branch,
  anchorStartMs,
  max,
  critical,
}: BranchRowProps) {
  const node = project.nodes.find((item) => item.id === branch.targetId);
  let cursor = anchorStartMs;
  const targetNames = branch.segments.map(
    (segment) =>
      project.nodes.find((item) => item.id === segment.nodeId)?.name ??
      segment.nodeId,
  );
  const downstreamNames = branch.sharedDownstreamIds
    .map(
      (id) => project.nodes.find((item) => item.id === id)?.name ?? id,
    )
    .slice(0, 3);
  const weightedEndMs = anchorStartMs + branch.weightedMs;
  return (
    <div className="timeline-row timeline-branch-row">
      <div className="timeline-name branch-name">
        <CornerDownRight size={14} className="branch-glyph" />
        <span>
          <b>降级路径 · {targetNames.join(" → ") || node?.name}</b>
          <small>
            {branch.cycleTruncated ? (
              <em className="branch-cycle-note">降级成环，已截断折算</em>
            ) : (
              <>
                仅在主请求最终失败时执行 · 触发概率{" "}
                {formatPercent(branch.terminalFailureProbability)}
              </>
            )}
          </small>
        </span>
      </div>
      <div className="timeline-track">
        <div className="timeline-grid" />
        <div
          className={`branch-anchor ${critical ? "is-critical" : ""}`}
          style={{ left: `${(anchorStartMs / max) * 100}%` }}
        />
        {branch.segments.map((segment) => {
          const left = (cursor / max) * 100;
          const width = Math.max(1.2, (segment.weightedMs / max) * 100);
          cursor += segment.weightedMs;
          const actual = project.nodes.find(
            (item) => item.id === segment.nodeId,
          );
          return (
            <div
              key={segment.nodeId}
              className={`branch-bar ${segment.kind === "chained" ? "is-chained" : ""} ${critical ? "is-critical" : ""}`}
              style={{
                left: `${left}%`,
                width: `${Math.min(width, 100 - left)}%`,
              }}
              title={`${actual?.name ?? segment.nodeId}：实际耗时 ${formatTime(segment.ownMs)}，触发概率 ${formatPercent(segment.probability)}，折算 ${formatTime(segment.weightedMs)}`}
            />
          );
        })}
        <span
          className="branch-bar-label"
          style={{ left: `${(weightedEndMs / max) * 100}%` }}
        >
          折算 {formatTime(branch.weightedMs)}
        </span>
      </div>
      <div className="timeline-end branch-end">
        {downstreamNames.length > 0 && (
          <small title="这些下游请求无论是否降级都会按主排布执行，不重复折算">
            {downstreamNames.join("、")}
            {branch.sharedDownstreamIds.length > downstreamNames.length
              ? " 等"
              : ""}
            {" "}主路径已计
          </small>
        )}
      </div>
    </div>
  );
}

export default function Timeline({ project, result }: Props) {
  const max = Math.max(1, result.completionMs);
  const critical = new Set(result.criticalPath);
  const criticalBranches = new Set(
    result.budget.fallbackBranches.map(
      (branch) => `${branch.ownerId}>${branch.targetId}`,
    ),
  );
  const marks = [0, 0.25, 0.5, 0.75, 1];
  return (
    <div className="timeline-card">
      <div className="timeline-head">
        <div>
          <span className="section-label">执行时序</span>
          <span className="timeline-caption">
            主路径必然发生，降级路径仅在失败链路上发生（已按概率折算）
          </span>
        </div>
        <div className="timeline-legend">
          <span>
            <i className="legend-normal" /> 必然耗时
          </span>
          <span>
            <i className="legend-retry" /> 重试折算
          </span>
          <span>
            <i className="legend-fallback" /> 降级折算
          </span>
          <span>
            <i className="legend-critical" /> 关键路径
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
        <div className="axis-end">EXPECTED</div>
      </div>
      {result.entries.map((entry, index) => {
        const node = project.nodes.find((item) => item.id === entry.nodeId);
        if (!node) return null;
        const isCritical = critical.has(entry.nodeId);
        const start = (entry.startMs / max) * 100;
        const ownMs = entry.guaranteedMs + entry.retryMs;
        const ownWidth = Math.max(1.2, (ownMs / max) * 100);
        return (
          <div className="timeline-row-group" key={entry.nodeId}>
            <div className="timeline-row">
              <div className="timeline-name">
                <span className={`timeline-icon tone-${index % 4}`}>
                  {node.name.slice(0, 1)}
                </span>
                <span>
                  <b>{node.name}</b>
                  <small>
                    {entry.retryMs > 0
                      ? `必然 ${formatTime(entry.guaranteedMs)} + 重试折算 ${formatTime(entry.retryMs)}`
                      : `必然发生 · ${formatTime(entry.guaranteedMs)}`}
                    {entry.waitMs > 0 && ` · 排队 ${formatTime(entry.waitMs)}`}
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
                  className={`duration-bar ${isCritical ? "is-critical" : ""} tone-${index % 4}`}
                  style={{
                    left: `${start}%`,
                    width: `${Math.min(ownWidth, 100 - start)}%`,
                  }}
                  title={`主路径期望耗时 ${formatTime(ownMs)}（必然 ${formatTime(entry.guaranteedMs)} + 重试折算 ${formatTime(entry.retryMs)}）`}
                >
                  <span
                    className="bar-segment bar-guaranteed"
                    style={{ flexGrow: entry.guaranteedMs }}
                  />
                  {entry.retryMs > 0 && (
                    <span
                      className="bar-segment bar-retry"
                      style={{ flexGrow: entry.retryMs }}
                    />
                  )}
                  <span className="bar-time-label">{formatTime(ownMs)}</span>
                </div>
              </div>
              <div className="timeline-end">{formatTime(entry.endMs)}</div>
            </div>
            {entry.fallbackBranches.map((branch) => (
              <BranchRow
                key={`${branch.ownerId}>${branch.targetId}`}
                project={project}
                branch={branch}
                anchorStartMs={entry.startMs + ownMs}
                max={max}
                critical={criticalBranches.has(
                  `${branch.ownerId}>${branch.targetId}`,
                )}
              />
            ))}
          </div>
        );
      })}
      {!result.entries.length && (
        <div className="timeline-empty">修复链路配置后即可生成时序预览。</div>
      )}
    </div>
  );
}
