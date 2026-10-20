export const EVENT_TYPES = [
  "task.created",
  "task.state_changed",
  "task.needs_human",
  "task.missed",
  "task.cancelled",
  "publication.submitted",
  "publication.status_changed",
  "account.paused",
  "account.resumed",
  "incident.opened",
  "incident.resolved",
  "runner.online",
  "runner.offline",
  "workspace.notice",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_TYPE_LABELS: Record<EventType, string> = {
  "task.created": "任务创建",
  "task.state_changed": "任务状态更新",
  "task.needs_human": "任务需人工处理",
  "task.missed": "任务错过执行窗口",
  "task.cancelled": "任务已取消",
  "publication.submitted": "内容已提交平台",
  "publication.status_changed": "发布状态更新",
  "account.paused": "账号已暂停",
  "account.resumed": "账号已恢复",
  "incident.opened": "异常登记",
  "incident.resolved": "异常已处理",
  "runner.online": "执行设备上线",
  "runner.offline": "执行设备离线",
  "workspace.notice": "通知",
};

export interface AppEvent {
  id: number;
  workspaceId: string;
  taskId?: string | null;
  type: EventType;
  payload: Record<string, unknown>;
  createdAt: string;
}
