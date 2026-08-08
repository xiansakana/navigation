<?php
return [
    'app_name' => '思源笔记分享',
    'allow_registration' => true,
    'default_storage_limit_mb' => 1024,
    'session_lifetime_days' => 30,
    'chunk_ttl_seconds' => 7200,
    'chunk_cleanup_probability' => 0.05,
    'chunk_cleanup_limit' => 20,
    'min_chunk_size_kb' => 256,
    'max_chunk_size_mb' => 8,
    // 自建 IP 访问时可关闭验证码，减少注册/登录摩擦
    'captcha_enabled' => false,
    'email_verification_enabled' => false,
    'email_from' => 'no-reply@example.com',
    'email_from_name' => '思源笔记分享',
    'email_subject' => '邮箱验证码',
    'email_reset_subject' => '重置密码验证码',
    'smtp_enabled' => false,
    'smtp_host' => '',
    'smtp_port' => 587,
    'smtp_secure' => 'tls',
    'smtp_user' => '',
    'smtp_pass' => '',

    'site_version' => '0.5.5',
    'central_stats_url' => 'https://share.b0x.top',
];
