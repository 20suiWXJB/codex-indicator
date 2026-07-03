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

export interface EventPayload {
  status: IndicatorStatus;
  source: string;
  event: string;
  summary: string;
  detail: string;
  createdAt: string;
}

export interface StatusCopy {
  label: string;
  title: string;
  detail: string;
}

const DONE_SETTLE_MS = 3500;
const FALLBACK_LABELS: Record<IndicatorStatus, string> = {
  waiting: "等待批准",
  running: "运行中",
  done: "已完成",
  error: "异常",
  interrupted: "已中断",
  idle: "空闲",
  connecting: "连接中",  // 新增：连接中状态标签
};

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
