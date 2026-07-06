export type IndicatorStatus =
  | "waiting"
  | "running"
  | "done"
  | "error"
  | "interrupted"
  | "idle"
  | "connecting";  // 新增：连接中状态

export interface StatusPayload {
  status: IndicatorStatus;
  source: string;
  event: string;
  summary: string;
  detail: string;
  updatedAt: string;
  ttlMs: number;
}

export interface InstanceStatus {
  id: string;
  label: string;
  cwd: string;
  status: IndicatorStatus;
  summary: string;
  detail: string;
  updatedAt: string;
  ttlMs: number;
}

export interface MultiStatusPayload {
  aggregate: StatusPayload;
  instances: InstanceStatus[];
}

export interface EventPayload {
  status: IndicatorStatus;
  source: string;
  event: string;
  summary: string;
  detail: string;
  createdAt: string;
  instance?: string;
  label?: string;
  cwd?: string;
}

export interface StatusCopy {
  label: string;
  title: string;
  detail: string;
}

const DONE_SETTLE_MS = 3500;
const FALLBACK_LABELS: Record<IndicatorStatus, string> = {
  waiting: "等待输入",
  running: "运行中",
  done: "已完成",
  error: "异常",
  interrupted: "已中断",
  idle: "空闲",
  connecting: "连接中",  // 新增：连接中状态标签
};
const COUNT_LABELS: Partial<Record<IndicatorStatus, string>> = {
  running: "运行",
  waiting: "等待",
  error: "异常",
  interrupted: "中断",
  done: "完成",
  idle: "空闲",
};
const COUNT_ORDER: IndicatorStatus[] = ["running", "waiting", "error", "interrupted", "done", "idle"];

export function resolveDisplayStatus(
  payload: StatusPayload,
  nowMs = Date.now(),
  doneSettleMs = DONE_SETTLE_MS,
): IndicatorStatus {
  if (payload.status !== "done") {
    return payload.status;
  }

  const updatedMs = Date.parse(payload.updatedAt);
  if (Number.isNaN(updatedMs)) {
    return "done";
  }

  return nowMs - updatedMs >= doneSettleMs ? "idle" : "done";
}

export function describeStatus(payload: StatusPayload): StatusCopy {
  return {
    label: FALLBACK_LABELS[payload.status] ?? FALLBACK_LABELS.idle,
    title: payload.summary || FALLBACK_LABELS[payload.status] || FALLBACK_LABELS.idle,
    detail: payload.detail || [payload.source, payload.event].filter(Boolean).join(" / "),
  };
}

export function formatAggregateSubtitle(instances: InstanceStatus[]): string {
  const counts = new Map<IndicatorStatus, number>();
  for (const instance of instances) {
    counts.set(instance.status, (counts.get(instance.status) ?? 0) + 1);
  }

  const parts = COUNT_ORDER
    .map((status) => {
      const count = counts.get(status) ?? 0;
      return count > 0 ? `${count}${COUNT_LABELS[status]}` : "";
    })
    .filter(Boolean);

  return parts.length > 0 ? parts.join(" ") : "无活动";
}

export function describeInstanceStatus(instance: InstanceStatus): StatusCopy {
  const statusCopy = describeStatus({
    status: instance.status,
    source: "codex",
    event: "",
    summary: instance.summary,
    detail: instance.detail,
    updatedAt: instance.updatedAt,
    ttlMs: instance.ttlMs,
  });
  const detail = [instance.cwd, statusCopy.detail].filter(Boolean).join("\n");

  return {
    label: statusCopy.label,
    title: instance.label || statusCopy.title || instance.cwd || instance.id,
    detail,
  };
}

export function formatEventTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--:--:--";
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

export function trimText(value: string, maxLength = 72): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

/** 判断是否应该触发状态切换闪烁动画 */
export function shouldBlink(prev: IndicatorStatus, next: IndicatorStatus): boolean {
  // 相同状态不闪
  if (prev === next) return false;
  // 首次加载的初始化过渡（connecting → 真实状态），不是真实状态变化，不闪
  if (prev === "connecting") return false;
  // done→idle 是"完成后停留"的自动衰减，不是新事件，不闪
  if (prev === "done" && next === "idle") return false;
  // 其余状态切换触发闪烁
  return true;
}

export function idleStatus(summary = "无活动"): StatusPayload {
  return {
    status: "idle",
    source: "indicator",
    event: "",
    summary,
    detail: "",
    updatedAt: new Date().toISOString(),
    ttlMs: 0,
  };
}

// 新增：初始连接中状态
export function connectingStatus(): StatusPayload {
  return {
    status: "connecting",
    source: "indicator",
    event: "initializing",
    summary: "正在连接...",
    detail: "正在读取 Codex 状态",
    updatedAt: new Date().toISOString(),
    ttlMs: 0,
  };
}
