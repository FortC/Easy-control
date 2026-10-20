import { describe, expect, it } from "vitest";
import {
  computeContentHash,
  TaskEnvelopeSchema,
  verifyEnvelopeBinding,
  type TaskEnvelope,
} from "./envelope.js";

function sampleEnvelope(overrides: Partial<TaskEnvelope> = {}): TaskEnvelope {
  return TaskEnvelopeSchema.parse({
    taskId: "task_001",
    attemptId: "att_001",
    workspaceId: "ws_001",
    platform: "xiaohongshu",
    channel: "simulator",
    accountId: "acc_001",
    accountUid: "sim_xhs_001",
    action: "publish_image_note",
    contentVersionId: "cv_001",
    contentHash: "sha256:abcdef1234567890",
    approvalId: "apr_001",
    scheduledAt: "2026-10-21T10:00:00+08:00",
    expiresAt: "2026-10-21T10:30:00+08:00",
    runnerId: "runner_001",
    content: {
      title: "示例标题",
      body: "示例正文",
      topics: ["测试"],
      assetPaths: [],
      declarations: { aiGenerated: true, commercial: false },
    },
    ...overrides,
  });
}

describe("任务信封", () => {
  it("解析并填充默认值", () => {
    const env = sampleEnvelope();
    expect(env.timezone).toBe("Asia/Shanghai");
    expect(env.content.topics).toEqual(["测试"]);
    expect(env.content.declarations.aiGenerated).toBe(true);
  });

  it("拒绝未知平台与通道", () => {
    expect(() => sampleEnvelope({ platform: "twitter" as never })).toThrow();
    expect(() => sampleEnvelope({ channel: "puppet" as never })).toThrow();
    expect(() => TaskEnvelopeSchema.parse({ taskId: "" })).toThrow();
  });

  it("拒绝缺字段", () => {
    const { content, ...rest } = sampleEnvelope();
    const bad = { ...rest, content: { title: "缺正文" } };
    expect(() => TaskEnvelopeSchema.parse(bad)).toThrow();
  });
});

describe("内容哈希", () => {
  const base = {
    title: "标题",
    body: "正文",
    topics: ["a", "b"],
    assetIds: ["x", "y"],
    declarations: { aiGenerated: true, commercial: false },
  };

  it("话题与素材顺序不影响哈希", () => {
    const h1 = computeContentHash(base);
    const h2 = computeContentHash({ ...base, topics: ["b", "a"], assetIds: ["y", "x"] });
    expect(h1).toBe(h2);
  });

  it("关键字段变更改变哈希", () => {
    expect(computeContentHash(base)).not.toBe(computeContentHash({ ...base, title: "新标题" }));
    expect(computeContentHash(base)).not.toBe(
      computeContentHash({ ...base, declarations: { aiGenerated: false, commercial: false } }),
    );
    expect(computeContentHash(base)).not.toBe(computeDeclarationChangedBody());
  });

  function computeDeclarationChangedBody(): string {
    return computeContentHash({ ...base, body: "新正文" });
  }
});

describe("信封绑定校验", () => {
  const env = sampleEnvelope();

  it("绑定一致时通过", () => {
    expect(
      verifyEnvelopeBinding(env, {
        runnerId: "runner_001",
        workspaceId: "ws_001",
        accountIds: ["acc_001"],
      }),
    ).toEqual({ ok: true });
  });

  it("设备、工作空间或账号不符时拒绝", () => {
    expect(
      verifyEnvelopeBinding(env, { runnerId: "runner_002", workspaceId: "ws_001", accountIds: ["acc_001"] }).ok,
    ).toBe(false);
    expect(
      verifyEnvelopeBinding(env, { runnerId: "runner_001", workspaceId: "ws_999", accountIds: ["acc_001"] }).ok,
    ).toBe(false);
    expect(
      verifyEnvelopeBinding(env, { runnerId: "runner_001", workspaceId: "ws_001", accountIds: ["acc_404"] }).ok,
    ).toBe(false);
  });
});
