ALTER TABLE account_connections DROP CONSTRAINT IF EXISTS account_connections_platform_check;
ALTER TABLE account_connections ADD CONSTRAINT account_connections_platform_check CHECK (platform IN ('xiaohongshu','weibo','douyin','zhihu'));
