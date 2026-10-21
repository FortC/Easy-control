-- v1 小红书只提供内容助手和真人交付。停止旧版自动化入口，并清理平台会话。
UPDATE schedules
   SET active = false
 WHERE platform = 'xiaohongshu' AND active = true;

UPDATE tasks
   SET status = 'CANCELLED',
       updated_at = now(),
       last_error = jsonb_build_object(
         'code', 'human_delivery_only',
         'message', '此版本小红书仅支持内容助手与真人交付；未执行的自动化任务已取消。'
       )
 WHERE platform = 'xiaohongshu'
   AND status IN ('SCHEDULED', 'PREFLIGHT', 'WAITING_RUNNER');

UPDATE tasks
   SET status = 'UNKNOWN',
       updated_at = now(),
       last_error = jsonb_build_object(
         'code', 'human_delivery_only',
         'message', '升级时任务已在运行；请人工核对平台状态，不要自动重试。'
       )
 WHERE platform = 'xiaohongshu' AND status = 'RUNNING';

UPDATE account_connections
   SET secret_encrypted = NULL,
       secret_ref = NULL,
       channel = 'simulator',
       capabilities = '["human_review", "content_export"]'::jsonb,
       paused = true,
       paused_reason = '小红书第一版仅支持真人交付，旧版自动化授权已停用'
 WHERE platform = 'xiaohongshu' AND channel = 'redbook';

UPDATE capability_grants
   SET channel = 'simulator', enabled = false
 WHERE platform = 'xiaohongshu' AND channel = 'redbook';

UPDATE account_connections
   SET secret_encrypted = NULL,
       secret_ref = NULL
 WHERE platform = 'xiaohongshu' AND secret_encrypted IS NOT NULL;

ALTER TABLE account_connections DROP CONSTRAINT IF EXISTS account_connections_channel_check;
ALTER TABLE account_connections
  ADD CONSTRAINT account_connections_channel_check CHECK (channel IN ('simulator', 'weibo_cli', 'douyin_api'));
