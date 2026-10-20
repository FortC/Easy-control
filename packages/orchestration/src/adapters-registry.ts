import type { Channel } from "@aipeople/contracts";
import { SimulatorAdapter } from "@aipeople/connector-simulator";
import { RedbookAdapter } from "@aipeople/connector-redbook";
import { WeiboCliAdapter } from "@aipeople/connector-weibo";
import { DouyinAdapter } from "@aipeople/connector-douyin";
import type { AdapterCapability, PlatformAdapter } from "@aipeople/contracts";

/** 通道 → 适配器实例注册表（Runner 与 Worker 共用同一实现）。 */
const douyinConfig =
  process.env.DOUYIN_CLIENT_KEY && process.env.DOUYIN_CLIENT_SECRET
    ? { clientKey: process.env.DOUYIN_CLIENT_KEY, clientSecret: process.env.DOUYIN_CLIENT_SECRET }
    : null;

const registry: Record<Channel, PlatformAdapter> = {
  simulator: new SimulatorAdapter(),
  redbook: new RedbookAdapter(),
  weibo_cli: new WeiboCliAdapter(),
  douyin_api: new DouyinAdapter(douyinConfig),
};

export function adapterFor(channel: Channel): PlatformAdapter {
  return registry[channel];
}

export function channelCapabilities(channel: Channel): AdapterCapability[] {
  return registry[channel].capabilities();
}
