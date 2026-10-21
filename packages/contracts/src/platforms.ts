export const PLATFORMS = ["xiaohongshu", "weibo", "douyin", "zhihu"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const CHANNELS = ["simulator", "weibo_cli", "douyin_api"] as const;
export type Channel = (typeof CHANNELS)[number];

export const ACTIONS = [
  "publish_image_note",
  "publish_post",
  "publish_video",
  "reply_comment",
  "pull_metrics",
] as const;
export type Action = (typeof ACTIONS)[number];

export const PLATFORM_LABELS: Record<Platform, string> = {
  xiaohongshu: "小红书",
  weibo: "微博",
  douyin: "抖音",
  zhihu: "知乎",
};

export const CHANNEL_LABELS: Record<Channel, string> = {
  simulator: "模拟器（演示通道）",
  weibo_cli: "微博官方 CLI",
  douyin_api: "抖音官方 API",
};

/** 每个通道可以执行的平台。 */
export const CHANNEL_PLATFORMS: Record<Channel, readonly Platform[]> = {
  simulator: ["xiaohongshu", "weibo", "douyin", "zhihu"],
  weibo_cli: ["weibo"],
  douyin_api: ["douyin"],
};

/** 平台的默认真实通道（连接账号时使用）。 */
export function defaultChannelFor(platform: Platform): Channel {
  switch (platform) {
    case "xiaohongshu":
      return "simulator";
    case "weibo":
      return "weibo_cli";
    case "douyin":
      return "douyin_api";
    case 'zhihu':
      return 'simulator';
  }
}

/** 平台与发布动作的对应关系（内容工作台按此生成平台版本）。 */
export const PUBLISH_ACTION_BY_PLATFORM: Record<Platform, Action> = {
  xiaohongshu: "publish_image_note",
  weibo: "publish_post",
  douyin: "publish_video",
  zhihu: 'publish_post',
};

export function isPlatform(value: unknown): value is Platform {
  return typeof value === "string" && (PLATFORMS as readonly string[]).includes(value);
}

export function isChannel(value: unknown): value is Channel {
  return typeof value === "string" && (CHANNELS as readonly string[]).includes(value);
}
