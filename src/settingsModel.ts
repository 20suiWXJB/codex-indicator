export type LanguageSetting = "zh-CN" | "en-US";
export type ThemeSetting = "system" | "light" | "dark";
export type PathModeSetting = "auto" | "custom";
export type WindowKind = "main" | "settings";

export interface AppSettings {
  language: LanguageSetting;
  theme: ThemeSetting;
  showMainWindowOnLaunch: boolean;
  alwaysOnTop: boolean;
  rememberWindowState: boolean;
  minimizeToTray: boolean;
  panelExpandedHeight: number;
  edgeDockEnabled: boolean;
  dockHideDelayMs: number;
  stateDirMode: PathModeSetting;
  stateDir: string;
  codexSessionsDirMode: PathModeSetting;
  codexSessionsDir: string;
  pollIntervalMs: number;
  instanceActiveWindowMinutes: number;
  /** session 文件多少秒内有写入才算"运行中"，超时降级为空闲 */
  sessionRunningTtlSeconds: number;
  /** 展开面板顶部是否显示活跃实例列表 */
  showInstanceList: boolean;
  /** 最近事件行是否加"项目名:"前缀 */
  eventInstancePrefix: boolean;
  notifyOnWaiting: boolean;
  notifyOnError: boolean;
  showDoneSettleMs: number;
  /** 运行中呼吸灯开关 */
  runningBreathEnabled: boolean;
  /** 呼吸一次完整周期(ms)，越小越急促 */
  runningBreathPeriodMs: number;
  /** 状态切换闪烁开关 */
  statusBlinkEnabled: boolean;
  /** 闪烁次数 */
  statusBlinkCount: number;
}

export interface SettingsDiagnostics {
  settingsFile: string;
  stateDir: string;
  logsDir: string;
  codexSessionsDir: string;
}

export interface SettingsSnapshot {
  settings: AppSettings;
  loadError?: string | null;
  diagnostics?: SettingsDiagnostics;
}

export type SettingInput = "select" | "toggle" | "number" | "path";
export type SettingAction =
  | "openStateDir"
  | "openLogsDir"
  | "clearEvents"
  | "resetDefaults"
  | "toggleDiagnostics";

export interface SettingOption {
  value: string;
  label: string;
}

export interface SettingItem {
  key?: keyof AppSettings;
  action?: SettingAction;
  title: string;
  description: string;
  compatibility?: string;
  input?: SettingInput;
  options?: SettingOption[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}

export interface SettingSection {
  id: string;
  title: string;
  items: SettingItem[];
}

export const DEFAULT_SETTINGS: AppSettings = {
  language: "zh-CN",
  theme: "system",
  showMainWindowOnLaunch: true,
  alwaysOnTop: true,
  rememberWindowState: true,
  minimizeToTray: true,
  panelExpandedHeight: 300,
  edgeDockEnabled: true,
  dockHideDelayMs: 600,
  stateDirMode: "auto",
  stateDir: "",
  codexSessionsDirMode: "auto",
  codexSessionsDir: "",
  pollIntervalMs: 500,
  instanceActiveWindowMinutes: 10,
  sessionRunningTtlSeconds: 120,
  showInstanceList: true,
  eventInstancePrefix: true,
  notifyOnWaiting: true,
  notifyOnError: true,
  showDoneSettleMs: 3500,
  runningBreathEnabled: true,
  runningBreathPeriodMs: 2400,
  statusBlinkEnabled: true,
  statusBlinkCount: 3,
};

const LANGUAGE_OPTIONS: SettingOption[] = [
  { value: "zh-CN", label: "简体中文" },
  { value: "en-US", label: "English" },
];

const THEME_OPTIONS: SettingOption[] = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

const PATH_MODE_OPTIONS: SettingOption[] = [
  { value: "auto", label: "自动检测" },
  { value: "custom", label: "自定义路径" },
];

export const SETTING_SECTIONS: SettingSection[] = [
  {
    id: "general",
    title: "常规",
    items: [
      {
        key: "language",
        title: "语言",
        description: "影响设置页和状态面板的显示语言；第一版默认中文，保留英文选项用于后续扩展。",
        compatibility: "不会修改系统区域设置，也不会影响 Codex 输出语言。",
        input: "select",
        options: LANGUAGE_OPTIONS,
      },
      {
        key: "theme",
        title: "主题",
        description: "决定设置窗口使用浅色、深色，或跟随操作系统的外观偏好。",
        compatibility: "悬浮指示器继续保持透明小窗样式，避免改变当前工作流。",
        input: "select",
        options: THEME_OPTIONS,
      },
      {
        key: "showMainWindowOnLaunch",
        title: "启动后显示主窗口",
        description: "控制应用启动后是否立即显示悬浮指示器窗口。",
        compatibility: "关闭后仍可从系统托盘重新显示，不影响后台状态读取。",
        input: "toggle",
      },
    ],
  },
  {
    id: "window",
    title: "窗口",
    items: [
      {
        key: "alwaysOnTop",
        title: "窗口置顶",
        description: "让悬浮指示器保持在其他窗口上方，便于在编码时观察状态变化。",
        compatibility: "不同桌面环境对置顶支持不完全一致；保存后会立即尝试应用到主窗口。",
        input: "toggle",
      },
      {
        key: "rememberWindowState",
        title: "记住窗口位置",
        description: "允许应用记录悬浮指示器上次的位置，重启后恢复到熟悉的位置。",
        compatibility: "当前由窗口状态插件处理，跨平台恢复效果取决于系统窗口管理器。",
        input: "toggle",
      },
      {
        key: "minimizeToTray",
        title: "隐藏到托盘",
        description: "点击主面板关闭按钮时隐藏窗口，应用继续在托盘中运行。",
        compatibility: "在不支持托盘的环境中，系统可能退化为普通关闭行为。",
        input: "toggle",
      },
      {
        key: "panelExpandedHeight",
        title: "面板展开高度",
        description: "控制主面板展开最近事件列表时的窗口高度。",
        compatibility: "仅影响展开态；折叠态继续保持 220px 小窗体验。",
        input: "number",
        min: 220,
        max: 620,
        step: 10,
        unit: "px",
      },
      {
        key: "edgeDockEnabled",
        title: "贴边收纳",
        description: "把指示器拖到屏幕左、右或上边缘可收纳成一颗状态灯珠，悬停展开。",
        compatibility: "关闭时若已收纳会自动恢复普通悬浮；不影响托盘和窗口置顶行为。",
        input: "toggle",
      },
      {
        key: "dockHideDelayMs",
        title: "收起延迟",
        description: "鼠标离开展开的贴边面板后，等待多久收回灯珠。",
        compatibility: "建议保持 200-3000ms；数值越小越贴近屏幕边缘常驻提示。",
        input: "number",
        min: 200,
        max: 3000,
        step: 100,
        unit: "ms",
      },
    ],
  },
  {
    id: "sources",
    title: "状态来源",
    items: [
      {
        key: "stateDirMode",
        title: "状态目录模式",
        description: "决定状态文件和事件记录使用自动应用数据目录，还是读取你指定的位置。",
        compatibility: "自动模式不会写死 Windows 路径，适合分享给其他用户。",
        input: "select",
        options: PATH_MODE_OPTIONS,
      },
      {
        key: "stateDir",
        title: "状态目录",
        description: "自定义状态目录时，应用会在该目录下读取 state/status.json、state/status/*.json 和 state/events.jsonl。",
        compatibility: "留空时自动模式生效；路径必须是当前系统可访问的本地路径。",
        input: "path",
      },
      {
        key: "codexSessionsDirMode",
        title: "Codex sessions 目录模式",
        description: "决定是否自动寻找用户目录下的 Codex sessions，或读取自定义 sessions 目录。",
        compatibility: "自动模式优先使用 ~/.codex/sessions；其他平台也沿用同一目录约定。",
        input: "select",
        options: PATH_MODE_OPTIONS,
      },
      {
        key: "codexSessionsDir",
        title: "Codex sessions 目录",
        description: "自定义 Codex 会话目录，用于推断运行中、等待批准和中断状态。",
        compatibility: "路径不存在时不会崩溃，只会回退到状态文件结果。",
        input: "path",
      },
      {
        key: "pollIntervalMs",
        title: "轮询频率",
        description: "控制主面板向后端读取状态的间隔，数值越小刷新越快。",
        compatibility: "过低的间隔会增加文件读取频率；保存时最低限制为 250ms。",
        input: "number",
        min: 250,
        max: 10000,
        step: 50,
        unit: "ms",
      },
    ],
  },
  {
    id: "instances",
    title: "多实例",
    items: [
      {
        key: "instanceActiveWindowMinutes",
        title: "实例活跃窗口",
        description: "控制最近多少分钟内有活动的 Codex 会话会显示为一个实例。",
        compatibility: "建议保持 1-60 分钟；过短可能让暂时停顿的实例消失，过长会保留更多历史会话。",
        input: "number",
        min: 1,
        max: 60,
        step: 1,
        unit: "分钟",
      },
      {
        key: "sessionRunningTtlSeconds",
        title: "运行判定窗口",
        description: "控制 session 文件多少秒内有写入才算运行中，超过后降级为空闲。",
        compatibility: "只影响 Codex sessions 推断链路；bridge 写入的状态文件仍沿用自身语义。",
        input: "number",
        min: 30,
        max: 1800,
        step: 30,
        unit: "秒",
      },
      {
        key: "showInstanceList",
        title: "显示实例列表",
        description: "展开主面板时在最近事件上方显示活跃 Codex 实例列表。",
        compatibility: "关闭后不影响聚合状态和最近事件，只减少展开面板里的实例占位。",
        input: "toggle",
      },
      {
        key: "eventInstancePrefix",
        title: "事件行实例前缀",
        description: "在最近事件文本前显示项目名，便于多实例同时运行时区分来源。",
        compatibility: "关闭后事件内容保持原文显示，事件文件中的实例信息不会被删除。",
        input: "toggle",
      },
    ],
  },
  {
    id: "notifications",
    title: "通知",
    items: [
      {
        key: "notifyOnWaiting",
        title: "等待批准时提醒",
        description: "当检测到 Codex 等待权限批准时，允许后续版本触发提醒。",
        compatibility: "第一版先保存偏好，不绑定 Windows 专属通知实现。",
        input: "toggle",
      },
      {
        key: "notifyOnError",
        title: "异常时提醒",
        description: "当状态进入异常时，允许后续版本根据此偏好显示提醒。",
        compatibility: "不会改变当前日志记录逻辑，只作为通知行为配置。",
        input: "toggle",
      },
      {
        key: "showDoneSettleMs",
        title: "完成后短暂显示",
        description: "Codex 完成后，主面板保持“已完成”状态的时间，然后回到空闲。",
        compatibility: "仅影响本地显示，不会修改状态文件中的原始事件。",
        input: "number",
        min: 500,
        max: 30000,
        step: 500,
        unit: "ms",
      },
    ],
  },
  {
    id: "effects",
    title: "效果",
    items: [
      {
        key: "runningBreathEnabled",
        title: "运行中呼吸灯",
        description: "AI 正在运行时，指示灯呈现透明度与光晕的周期性呼吸效果。",
        compatibility: "纯 CSS 动画实现，不增加轮询负担；关闭后指示灯保持静态常亮。",
        input: "toggle",
      },
      {
        key: "runningBreathPeriodMs",
        title: "呼吸周期",
        description: "呼吸灯完成一次明暗循环的时间，数值越小节奏越急促。",
        compatibility: "仅影响运行中状态的呼吸节奏，其他状态不受影响。",
        input: "number",
        min: 800,
        max: 6000,
        step: 200,
        unit: "ms",
      },
      {
        key: "statusBlinkEnabled",
        title: "状态切换闪烁",
        description: "AI 状态发生变化时（如等待→运行中），指示灯快速闪烁提醒你注意。",
        compatibility: "闪烁是一次性动画，完成后自动恢复当前状态对应的静态或呼吸效果。",
        input: "toggle",
      },
      {
        key: "statusBlinkCount",
        title: "闪烁次数",
        description: "状态变化时指示灯快速闪烁的次数，建议 2~5 次。",
        compatibility: "仅在状态切换闪烁开启时生效；不影响运行中呼吸灯等其他动效。",
        input: "number",
        min: 1,
        max: 10,
        step: 1,
        unit: "次",
      },
    ],
  },
  {
    id: "privacy",
    title: "数据与隐私",
    items: [
      {
        action: "openStateDir",
        title: "打开状态目录",
        description: "打开当前状态文件目录，便于检查 status.json、status/*.json 和 events.jsonl。",
        compatibility: "使用系统默认文件管理器；路径来自当前设置解析结果。",
      },
      {
        action: "openLogsDir",
        title: "打开日志目录",
        description: "打开应用日志目录，用于排查状态读取和窗口操作问题。",
        compatibility: "日志只保存在本机，不会上传到外部服务。",
      },
      {
        action: "clearEvents",
        title: "清理本地事件记录",
        description: "删除本地最近事件记录，主状态文件和配置不会被清空。",
        compatibility: "清理后新的事件仍会继续写入 events.jsonl。",
      },
    ],
  },
  {
    id: "advanced",
    title: "高级",
    items: [
      {
        action: "resetDefaults",
        title: "恢复默认设置",
        description: "将所有配置项恢复到应用内置默认值，适合排除配置导致的问题。",
        compatibility: "恢复默认会覆盖 settings.json，但不会删除日志和状态文件。",
      },
      {
        action: "toggleDiagnostics",
        title: "显示诊断信息",
        description: "显示当前设置文件、状态目录、日志目录和 Codex sessions 目录。",
        compatibility: "诊断信息只在本窗口展示，方便复制给维护者排查。",
      },
    ],
  },
];

export function completeSettings(input: Partial<AppSettings> | unknown): AppSettings {
  return normalizeSettings(input);
}

export function normalizeSettings(input: Partial<AppSettings> | unknown): AppSettings {
  const source = isRecord(input) ? input : {};

  return {
    language: enumValue(source.language, ["zh-CN", "en-US"], DEFAULT_SETTINGS.language),
    theme: enumValue(source.theme, ["system", "light", "dark"], DEFAULT_SETTINGS.theme),
    showMainWindowOnLaunch: boolValue(
      source.showMainWindowOnLaunch,
      DEFAULT_SETTINGS.showMainWindowOnLaunch,
    ),
    alwaysOnTop: boolValue(source.alwaysOnTop, DEFAULT_SETTINGS.alwaysOnTop),
    rememberWindowState: boolValue(source.rememberWindowState, DEFAULT_SETTINGS.rememberWindowState),
    minimizeToTray: boolValue(source.minimizeToTray, DEFAULT_SETTINGS.minimizeToTray),
    panelExpandedHeight: numberValue(
      source.panelExpandedHeight,
      DEFAULT_SETTINGS.panelExpandedHeight,
      220,
      620,
    ),
    edgeDockEnabled: boolValue(source.edgeDockEnabled, DEFAULT_SETTINGS.edgeDockEnabled),
    dockHideDelayMs: numberValue(
      source.dockHideDelayMs,
      DEFAULT_SETTINGS.dockHideDelayMs,
      200,
      3000,
    ),
    stateDirMode: enumValue(source.stateDirMode, ["auto", "custom"], DEFAULT_SETTINGS.stateDirMode),
    stateDir: stringValue(source.stateDir, DEFAULT_SETTINGS.stateDir),
    codexSessionsDirMode: enumValue(
      source.codexSessionsDirMode,
      ["auto", "custom"],
      DEFAULT_SETTINGS.codexSessionsDirMode,
    ),
    codexSessionsDir: stringValue(source.codexSessionsDir, DEFAULT_SETTINGS.codexSessionsDir),
    pollIntervalMs: numberValue(source.pollIntervalMs, DEFAULT_SETTINGS.pollIntervalMs, 250, 10000),
    instanceActiveWindowMinutes: numberValue(
      source.instanceActiveWindowMinutes,
      DEFAULT_SETTINGS.instanceActiveWindowMinutes,
      1,
      60,
    ),
    sessionRunningTtlSeconds: numberValue(
      source.sessionRunningTtlSeconds,
      DEFAULT_SETTINGS.sessionRunningTtlSeconds,
      30,
      1800,
    ),
    showInstanceList: boolValue(source.showInstanceList, DEFAULT_SETTINGS.showInstanceList),
    eventInstancePrefix: boolValue(source.eventInstancePrefix, DEFAULT_SETTINGS.eventInstancePrefix),
    notifyOnWaiting: boolValue(source.notifyOnWaiting, DEFAULT_SETTINGS.notifyOnWaiting),
    notifyOnError: boolValue(source.notifyOnError, DEFAULT_SETTINGS.notifyOnError),
    showDoneSettleMs: numberValue(
      source.showDoneSettleMs,
      DEFAULT_SETTINGS.showDoneSettleMs,
      500,
      30000,
    ),
    runningBreathEnabled: boolValue(source.runningBreathEnabled, DEFAULT_SETTINGS.runningBreathEnabled),
    runningBreathPeriodMs: numberValue(
      source.runningBreathPeriodMs,
      DEFAULT_SETTINGS.runningBreathPeriodMs,
      800,
      6000,
    ),
    statusBlinkEnabled: boolValue(source.statusBlinkEnabled, DEFAULT_SETTINGS.statusBlinkEnabled),
    statusBlinkCount: numberValue(
      source.statusBlinkCount,
      DEFAULT_SETTINGS.statusBlinkCount,
      1,
      10,
    ),
  };
}

export function formatSettingValue(key: keyof AppSettings, settings: AppSettings): string {
  const value = settings[key];

  switch (key) {
    case "language":
      return optionLabel(LANGUAGE_OPTIONS, value);
    case "theme":
      return optionLabel(THEME_OPTIONS, value);
    case "stateDirMode":
    case "codexSessionsDirMode":
      return optionLabel(PATH_MODE_OPTIONS, value);
    case "stateDir":
    case "codexSessionsDir":
      return value ? String(value) : "未指定，使用自动检测";
    case "panelExpandedHeight":
      return `${value}px`;
    case "pollIntervalMs":
    case "dockHideDelayMs":
    case "showDoneSettleMs":
    case "runningBreathPeriodMs":
      return `${value}ms`;
    case "instanceActiveWindowMinutes":
      return `${value}分钟`;
    case "sessionRunningTtlSeconds":
      return `${value}秒`;
    case "statusBlinkCount":
      return `${value}次`;
    default:
      return value ? "开启" : "关闭";
  }
}

export function resolveWindowKind(search: string, label?: string): WindowKind {
  const windowParam = new URLSearchParams(search).get("window");
  if (windowParam === "settings" || windowParam === "main") {
    return windowParam;
  }

  return label === "settings" ? "settings" : "main";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? (value as T) : fallback;
}

function boolValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function numberValue(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === "string" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.round(number)));
}

function optionLabel(options: SettingOption[], value: unknown): string {
  return options.find((option) => option.value === value)?.label ?? String(value);
}
