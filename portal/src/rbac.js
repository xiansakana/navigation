import { hasPermission, resolveUserPermissions } from '../../shared/auth/permissions.js';
export { hasPermission, resolveUserPermissions } from '../../shared/auth/permissions.js';
import { PORTAL_MODULES, moduleMenu } from './modules.js';
import { ensureAccessPolicy } from './access-policy.js';
import crypto from 'node:crypto';
import { getDatabase } from '../../shared/db/index.js';
import { loadRbacBlob, saveRbacBlob, rbacRevision, copyRbac } from '../../shared/db/rbac-store.js';

var rbacCache = null;
var rbacCacheConfigKey = null;

function configServicesKey(config) {
    return JSON.stringify((config.services || []).map(function(s) { return s.id; }));
}

var STOCK_MANAGE_SERVICE_ID = 'stock-manage';
var QQQ_DIP_SERVICE_ID = 'qqq-dip';
var NOTIFICATIONS_SERVICE_ID = 'notifications';

var STOCK_MANAGE_HOLDINGS_COLUMNS = [
    { key: 'type', name: '类型' },
    { key: 'account', name: '账户' },
    { key: 'symbol', name: '代码' },
    { key: 'name', name: '名称' },
    { key: 'shares', name: '股数' },
    { key: 'cost', name: '成本' },
    { key: 'price', name: '现价' },
    { key: 'pnl', name: '盈亏' },
    { key: 'pnlPct', name: '盈亏比例' },
    { key: 'dailyPnl', name: '当日盈亏' },
    { key: 'dailyPnlPct', name: '当日盈亏比例' },
    { key: 'position', name: '持仓' },
    { key: 'weight', name: '仓位 / 占比' },
    { key: 'optinfo', name: '期权信息' },
    { key: 'actions', name: '操作' }
];

var STOCK_MANAGE_FEATURES = [
    { feature: 'tab-quant', name: '进入量化分析', action: 'view', permissionPath: ['量化分析'] },
    { feature: 'tab-yolo', name: '进入梭哈平台', action: 'view', permissionPath: ['梭哈'] },
    { feature: 'yolo-dashboard', name: '查看1DTE数据库', action: 'view', permissionPath: ['梭哈', '数据采集'] },
    { feature: 'yolo-control', name: '控制1DTE数据采集', action: 'edit', permissionPath: ['梭哈', '数据采集'] },
    { feature: 'yolo-backtest', name: '查看1DTE回测', action: 'view', permissionPath: ['梭哈', '真实报价回测'] },
    { feature: 'yolo-backtest-run', name: '运行1DTE回测', action: 'edit', permissionPath: ['梭哈', '真实报价回测'] },
    { feature: 'quant-settings', name: '读取用户量化设置', action: 'view', permissionPath: ['量化分析', '通用数据'] },
    { feature: 'quant-history', name: '查看 K 线', action: 'view', permissionPath: ['量化分析', '通用数据'] },
    { feature: 'quant-watchlist', name: '保存分析标的', action: 'edit', permissionPath: ['量化分析', '分析标的'] },
    { feature: 'quant-dashboard', name: '进入量化仪表盘', action: 'view', permissionPath: ['量化分析', '量化仪表盘'] },
    { feature: 'quant-analysis-run', name: '运行量化分析', action: 'edit', permissionPath: ['量化分析', '量化仪表盘'] },
    { feature: 'quant-strategy', name: '进入策略参数页', action: 'view', permissionPath: ['量化分析', '策略参数页'] },
    { feature: 'quant-config', name: '保存策略参数', action: 'edit', permissionPath: ['量化分析', '策略参数页'] },
    { feature: 'quant-backtest', name: '进入历史回测页', action: 'view', permissionPath: ['量化分析', '历史回测页'] },
    { feature: 'quant-backtest-run', name: '运行历史回测', action: 'edit', permissionPath: ['量化分析', '历史回测页'] },
    { feature: 'quant-backtest-delete', name: '删除回测记录', action: 'edit', permissionPath: ['量化分析', '历史回测页'] },
    { feature: 'quant-paper', name: '进入模拟盘页', action: 'view', permissionPath: ['量化分析', '模拟盘'] },
    { feature: 'quant-paper-settings', name: '保存模拟盘设置', action: 'edit', permissionPath: ['量化分析', '模拟盘'] },
    { feature: 'quant-paper-sync', name: '执行模拟盘同步', action: 'edit', permissionPath: ['量化分析', '模拟盘'] },
    { feature: 'quant-paper-reset', name: '重置模拟盘', action: 'edit', permissionPath: ['量化分析', '模拟盘'] },
    { feature: 'dashboard', name: '显示看板', action: 'view', permissionPath: ['持仓', '看板'] },
    { feature: 'pnl', name: '查询盈亏', action: 'view', permissionPath: ['持仓', '看板'] },
    { feature: 'pnl-toggle', name: '盈亏显隐', action: 'view', permissionPath: ['持仓', '看板'] },
    { feature: 'trades', name: '交易记录', action: 'view', permissionPath: ['持仓', '交易记录'] },
    { feature: 'accounts', name: '查看证券账户', action: 'view', permissionPath: ['持仓', '账户管理'] },
    { feature: 'accounts', name: '管理证券账户及绑定', action: 'edit', permissionPath: ['持仓', '账户管理'] },
    { feature: 'trade-review', name: '交易复盘', action: 'view', permissionPath: ['持仓', '交易记录', '交易复盘'] },
    { feature: 'export', name: '导出交易', action: 'view', permissionPath: ['持仓', '交易记录'] },
    { feature: 'import', name: '导入交易', action: 'edit', permissionPath: ['持仓', '交易记录'] },
    { feature: 'columns', name: '列数据显隐控制', action: 'view', permissionPath: ['持仓', '持仓明细'] },
    { feature: 'trade', name: '记一笔', action: 'edit', permissionPath: ['持仓', '持仓操作'] },
    { feature: 'refresh', name: '刷新价格', action: 'edit', permissionPath: ['持仓', '持仓操作'] },
    { feature: 'cash', name: '查看现金', action: 'view', permissionPath: ['持仓', '资金'] },
    { feature: 'cash', name: '编辑现金', action: 'edit', permissionPath: ['持仓', '持仓操作'] },
    { feature: 'meta', name: '编辑持仓分组', action: 'edit', permissionPath: ['持仓', '持仓操作'] },
    { feature: 'row-trade', name: '行内买卖/记录', action: 'edit', permissionPath: ['持仓', '持仓操作'] }
].concat(STOCK_MANAGE_HOLDINGS_COLUMNS.map(function(col) {
    return {
        feature: 'col-' + col.key,
        name: col.name,
        action: 'view',
        featureGroup: 'holdings-field',
        permissionPath: ['持仓', '持仓明细字段'],
        columnKey: col.key
    };
}));

function stockManageFeaturePermissionId(feature, action) {
    return 'service:' + STOCK_MANAGE_SERVICE_ID + ':' + feature + ':' + action;
}

function buildStockManagePermissions() {
    return STOCK_MANAGE_FEATURES.map(function(item) {
        return {
            id: stockManageFeaturePermissionId(item.feature, item.action),
            name: item.featureGroup === 'holdings-field' ? ('字段·' + item.name) : item.name,
            group: '股票管理',
            serviceId: STOCK_MANAGE_SERVICE_ID,
            feature: item.feature,
            action: item.action,
            featureGroup: item.featureGroup || null,
            columnKey: item.columnKey || null,
            permissionPath: item.permissionPath || null
        };
    });
}

var QQQ_DIP_FEATURES = [
    { feature: 'tab-monitor', name: '进入抄底监控', action: 'view', permissionPath: ['抄底监控'] },
    { feature: 'docs', name: '手册预览', action: 'view', permissionPath: ['抄底监控', '行情与规则'] },
    { feature: 'buy-preview', name: '预览买入', action: 'view', permissionPath: ['抄底监控', '行情与规则'] },
    { feature: 'refresh', name: '刷新行情', action: 'edit', permissionPath: ['抄底监控', '行情与规则'] },
    { feature: 'monitor-control', name: '开始/停止监听', action: 'edit', permissionPath: ['抄底监控', '行情与规则'] },
    { feature: 'cash', name: '弹药现金录入', action: 'edit', permissionPath: ['抄底监控', '资金与仓位'] },
    { feature: 'lots', name: '查看抄底仓位金额', action: 'view', permissionPath: ['抄底监控', '资金与仓位'] },
    { feature: 'lots-edit', name: '登记/删除仓位', action: 'edit', permissionPath: ['抄底监控', '资金与仓位'] },
    { feature: 'settings', name: '规则开关', action: 'edit', permissionPath: ['抄底监控', '规则执行'] },
    { feature: 'tier-exec', name: '标记档位已执行', action: 'edit', permissionPath: ['抄底监控', '规则执行'] },
    { feature: 'actions', name: '查看操作记录', action: 'view', permissionPath: ['抄底监控', '操作记录'] },
    { feature: 'actions-note', name: '手动记一笔', action: 'edit', permissionPath: ['抄底监控', '操作记录'] },
    { feature: 'tab-qq', name: '进入 QQ 提醒', action: 'view', permissionPath: ['QQ 提醒'] },
    { feature: 'qq-config', name: '查看 QQ 配置', action: 'view', permissionPath: ['QQ 提醒', '通知配置'] },
    { feature: 'qq-save', name: '保存 QQ 配置', action: 'edit', permissionPath: ['QQ 提醒', '通知配置'] },
    { feature: 'qq-test', name: '测试 QQ 通知', action: 'edit', permissionPath: ['QQ 提醒', '通知配置'] },
    { feature: 'qq-monitor', name: '监听控制', action: 'edit', permissionPath: ['QQ 提醒', '监听控制'] }
];

function qqqDipFeaturePermissionId(feature, action) {
    return 'service:' + QQQ_DIP_SERVICE_ID + ':' + feature + ':' + action;
}

function buildQqqDipPermissions() {
    return QQQ_DIP_FEATURES.map(function(item) {
        return {
            id: qqqDipFeaturePermissionId(item.feature, item.action),
            name: item.name,
            group: '抄底监控',
            serviceId: QQQ_DIP_SERVICE_ID,
            feature: item.feature,
            action: item.action,
            permissionPath: item.permissionPath || null
        };
    });
}

var NOTIFICATION_FEATURES = [
    { feature: 'slack-test', name: '发送 Slack 测试', action: 'edit', permissionPath: ['Slack 通知'] },
    { feature: 'business-save', name: '保存业务提醒配置', action: 'edit', permissionPath: ['业务提醒'] },
    { feature: 'business-test', name: '发送业务提醒测试', action: 'edit', permissionPath: ['业务提醒'] }
];

function buildNotificationPermissions() {
    return NOTIFICATION_FEATURES.map(function(item) {
        return {
            id: 'service:' + NOTIFICATIONS_SERVICE_ID + ':' + item.feature + ':' + item.action,
            name: item.name,
            group: '通知管理',
            serviceId: NOTIFICATIONS_SERVICE_ID,
            feature: item.feature,
            action: item.action,
            permissionPath: item.permissionPath
        };
    });
}

var SYSTEM_PERMISSIONS = [
    ...[
        ['view', '查看自己的帮派筛选列表与结果', [], 'view'],
        ['config:edit', '配置自己的 Leader networth 筛选', ['保存配置'], 'edit'],
        ['control:edit', '启动、暂停和重置自己的帮派筛选批次', ['扫描控制'], 'edit']
    ].map(([id, name, parts, action]) => ({ id: 'torn-factions:' + id, name, group: 'Torn 工具箱', serviceId: 'torn-toolbox', action, permissionPath: ['首页', 'Torn 工具箱', 'Chain 监控', '帮派筛选', ...parts] })),
    { id: 'admin:data-policy:view', name: '查看模块授权和数据范围', group: '系统', action: 'view', resource: 'admin:data-policy', permissionPath: ['权限管理', '模块与数据范围'] },
    { id: 'admin:data-policy:edit', name: '配置模块授权和数据范围', group: '系统', action: 'edit', resource: 'admin:data-policy', permissionPath: ['权限管理', '模块与数据范围', '保存'] },
    ...[
        ['view', '查看自己的 Chain 监控', [], 'view'],
        ['config:edit', '保存自己的 Chain 范围、Bonus hit、Leader 筛选和 Key', ['配置'], 'edit'],
        ['control:edit', '启动或停止自己的 Chain 监控', ['监控控制'], 'edit'],
        ['history:edit', '清空自己的 Chain 报告记录', ['报告记录', '清空'], 'edit']
    ].map(([id, name, parts, action]) => ({ id: 'torn-chain:' + id, name, group: 'Torn 工具箱', serviceId: 'torn-toolbox', action, permissionPath: ['首页', 'Torn 工具箱', 'Chain 监控', ...parts] })),
    ...[
        ['notify:view', '查看自己的 Chain 通知配置', 'view', []],
        ['notify:edit', '保存自己的 Chain 通知配置', 'edit', ['保存配置']],
        ['notify:test:edit', '测试自己的 Chain 通知', 'edit', ['发送测试']]
    ].map(([id, name, action, parts]) => ({ id: 'torn-chain:' + id, name, action, group: '通知管理', serviceId: 'notifications', permissionPath: ['首页', '通知管理', '业务提醒', 'Chain 冷却', ...parts] })),
    ...[
        ['view','进入Codex CLI模块',[],'view'],
        ['usage:view','查看服务器账户额度',['账户与额度'],'view'],
        ['settings:edit','保存服务器Codex默认设置',['服务器默认设置','保存'],'edit'],
        ['runtime:edit','保存自己的QQ模型和强度',['我的QQ设置','保存'],'edit'],
        ['sessions:view','查看自己的Codex会话',['会话工作台'],'view'],
        ['sessions:server:view','查看服务器全部CLI会话',['会话工作台','服务器全部会话'],'view'],
        ['sessions:create','新建Codex会话',['会话工作台','新建会话'],'create'],
        ['messages:send','发送消息并执行Codex任务',['会话工作台','发送消息'],'execute'],
        ['sessions:manage','重命名与归档自己的会话',['会话工作台','管理会话'],'edit'],
        ['tasks:stop','停止自己的Codex任务',['会话工作台','停止任务'],'execute'],
        ['todos:view','查看自己的指令待办',['Todo'],'view'],
        ['todos:edit','新增编辑与删除指令待办',['Todo','管理待办'],'edit'],
        ['todos:run','启用待办自动执行或重试',['Todo','自动执行'],'execute'],
        ['todos:order','调整待办执行顺序',['Todo','调整顺序'],'edit'],
        ['todos:stop','暂停待办与停止执行',['Todo','暂停'],'execute']
    ].map(([id,name,parts,action])=>({id:'codex-cli:'+id,name,group:'Codex CLI',serviceId:'codex-cli',action,permissionPath:['首页','Codex CLI',...parts]})),
    { id: 'qq-codex:settings:view', name: '查看自己的QQ Codex群聊设置', group: '通知管理', serviceId: NOTIFICATIONS_SERVICE_ID, action: 'view', permissionPath: ['首页', '通知管理', 'QQ Codex'] },
    { id: 'qq-codex:settings:edit', name: '配置自己的QQ Codex群聊', group: '通知管理', serviceId: NOTIFICATIONS_SERVICE_ID, action: 'edit', permissionPath: ['首页', '通知管理', 'QQ Codex', '保存群聊配置'] },
    { id: 'qq-codex:execute', name: '通过QQ执行Codex任务', group: '通知管理', serviceId: NOTIFICATIONS_SERVICE_ID, action: 'edit', permissionPath: ['首页', '通知管理', 'QQ Codex', '执行任务'] },
    ...[
        ['view', '进入和检索自己的知识库', []],
        ['notes:view', '查看、搜索和分页浏览自己的学习笔记', ['笔记']],
        ['storage:edit', '重试保存自己的原视频', ['笔记', '原视频', '重试保存']],
        ['source:view', '回看自己的原视频', ['笔记', '原视频']],
        ['transcript:view', '查看和搜索时间线转写', ['笔记', '时间线转写']],
        ['transcript:script:view', '切换简体与原始转写文字', ['笔记', '时间线转写', '文字显示']],
        ['asr:edit', '设置语音模型、语言与术语提示', ['处理设置', '语音转写', '保存设置']],
        ['frames:view', '查看关键画面', ['笔记', '关键画面']],
        ['upload:edit', '上传视频和继续上传', ['上传视频']],
        ['import:edit', '解析和导入B站视频链接', ['上传视频', '链接导入']],
        ['bilibili:view', '查看自己的B站绑定状态', ['处理设置', 'B站账号']],
        ['bilibili:edit', '扫码绑定和解除自己的B站账号', ['处理设置', 'B站账号', '绑定管理']],
        ['quality:edit', '设置默认视频清晰度和降级策略', ['处理设置', '视频清晰度']],
        ['local-input:edit', '将上传的视频直送本机GPU处理', ['上传视频', '本机GPU直送']],
        ['process:edit', '生成笔记和重试失败任务', ['生成笔记']],
        ['process:batch:edit', '一键重试自己全部失败的笔记任务', ['笔记', '失败任务', '一键重试全部失败']],
        ['reanalysis:edit', '重新分析自己的已有笔记', ['笔记', '重新分析']],
        ['reanalysis:batch:edit', '批量重新分析自己的已有笔记', ['笔记', '重新分析', '批量重新分析']],
        ['history:view', '查看自己笔记的历史正文', ['笔记', '历史版本']],
        ['history:restore', '恢复自己笔记的历史版本', ['笔记', '历史版本', '恢复']],
        ['notes:edit', '编辑标题、分类、标签和笔记', ['笔记', '编辑']],
        ['publish:edit', '公开和撤回自己笔记的正文', ['笔记', '可见范围']],
        ['publish:batch:edit', '批量设置自己笔记的可见范围', ['笔记', '可见范围', '批量设置']],
        ['concurrency:edit', '设置视频转写和总结并发数', ['处理设置', '并发设置']],
        ['queue:view', '查看自己的上传队列', ['上传队列', '查看']],
        ['queue:edit', '添加批量视频任务', ['上传队列', '添加任务']],
        ['queue:manage', '重试和取消等待任务', ['上传队列', '管理任务']],
        ['delete:edit', '删除自己的视频和笔记', ['笔记', '删除']],
        ['export:view', '导出自己的 Markdown 笔记', ['笔记', '导出']],
        ['settings:edit', '切换默认总结后端', ['设置', '总结后端']],
        ['model:edit', '设置视频总结模型和推理强度', ['设置', '总结模型和推理强度']],
        ['worker:edit', '生成或轮换旧版共享工作器凭据', ['设置', '高级设置', '旧版凭据']],
        ['devices:view', '查看自己的视频处理设备', ['设置', '处理设备']],
        ['devices:install', '下载安装视频工作器', ['设置', '处理设备', '安装并连接']],
        ['devices:install-zip', '下载ZIP脚本安装包并连接设备', ['设置', '处理设备', '安装并连接', 'ZIP脚本安装包']],
        ['devices:edit', '绑定或停用自己的处理设备', ['设置', '处理设备', '管理设备']]
    ].map(([action, name, parts]) => ({ id: 'knowledge:' + action, name, group: '知识库', serviceId: 'knowledge', action: action.endsWith(':edit') || action.startsWith('devices:install') ? 'edit' : 'view', permissionPath: ['首页', '知识库', ...parts] })),
    { id: 'mingli:categories:view', name: '查看分类和分类筛选', group: '命理', serviceId: 'mingli', action: 'view', permissionPath: ['首页', '命理', '案例库', '分类管理'] },
    { id: 'mingli:categories:edit', name: '新增、重命名和删除分类', group: '命理', serviceId: 'mingli', action: 'edit', permissionPath: ['首页', '命理', '案例库', '分类管理', '编辑分类'] },
    { id: 'mingli:cases:classify', name: '设置和批量移动案例分类', group: '命理', serviceId: 'mingli', action: 'edit', permissionPath: ['首页', '命理', '案例库', '设置分类'] },
    { id: 'mingli:cases:import', name: '预览并导入问真案例', group: '命理', serviceId: 'mingli', action: 'edit', permissionPath: ['首页', '命理', '案例库', '导入案例'] },
    { id: 'mingli:view', name: '进入命理模块', group: '命理', serviceId: 'mingli', action: 'view', permissionPath: ['首页', '命理'] },
    { id: 'mingli:chart:calculate', name: '八字排盘', group: '命理', serviceId: 'mingli', action: 'edit', permissionPath: ['首页', '命理', '八字排盘'] },
    { id: 'mingli:cases:view', name: '查看和搜索自己的案例', group: '命理', serviceId: 'mingli', action: 'view', permissionPath: ['首页', '命理', '案例库'] },
    { id: 'mingli:cases:filter', name: '高级筛选自己的案例', group: '命理', serviceId: 'mingli', action: 'view', permissionPath: ['首页', '命理', '案例库', '高级筛选'] },
    { id: 'mingli:knowledge:view', name: '查看、分页检索自动归集的知识库案例和来源', group: '命理', serviceId: 'mingli', action: 'view', permissionPath: ['首页', '命理', '知识库案例'] },
    { id: 'mingli:knowledge:filter', name: '高级筛选知识库案例', group: '命理', serviceId: 'mingli', action: 'view', permissionPath: ['首页', '命理', '知识库案例', '高级筛选'] },
    { id: 'mingli:cases:edit', name: '保存案例和编辑笔记', group: '命理', serviceId: 'mingli', action: 'edit', permissionPath: ['首页', '命理', '案例库', '保存案例'] },
    { id: 'mingli:cases:delete', name: '删除自己的案例', group: '命理', serviceId: 'mingli', action: 'edit', permissionPath: ['首页', '命理', '案例库', '删除案例'] },
    { id: 'bookkeeping:location:edit', name: '获取记账当前位置', group: '记账', serviceId: 'bookkeeping', action: 'edit', permissionPath: ['首页', '记账', '明细与统计', '记一笔', '当前位置'] },
    { id: 'bookkeeping:qq:edit', name: '绑定 QQ 和使用指令记账', group: '记账', serviceId: 'bookkeeping', action: 'edit', permissionPath: ['首页', '记账', 'QQ记账'] },
    { id: 'bookkeeping:view', name: '查看记账明细与统计', group: '记账', serviceId: 'bookkeeping', action: 'view', permissionPath: ['首页', '记账', '明细与统计'] },
    { id: 'bookkeeping:entries:edit', name: '新增、编辑和删除账单', group: '记账', serviceId: 'bookkeeping', action: 'edit', permissionPath: ['首页', '记账', '明细与统计', '记一笔'] },
    { id: 'bookkeeping:accounts:view', name: '查看资产账户', group: '记账', serviceId: 'bookkeeping', action: 'view', permissionPath: ['首页', '记账', '资产'] },
    { id: 'bookkeeping:accounts:edit', name: '管理账户及余额调整', group: '记账', serviceId: 'bookkeeping', action: 'edit', permissionPath: ['首页', '记账', '资产', '管理账户'] },
    { id: 'bookkeeping:import:edit', name: '预览并导入 iCost 账单', group: '记账', serviceId: 'bookkeeping', action: 'edit', permissionPath: ['首页', '记账', '导入导出', '导入'] },
    { id: 'bookkeeping:export:view', name: '导出账单', group: '记账', serviceId: 'bookkeeping', action: 'view', permissionPath: ['首页', '记账', '导入导出', '导出'] },
    { id: 'bookkeeping:settings:edit', name: '设置预算及折算汇率', group: '记账', serviceId: 'bookkeeping', action: 'edit', permissionPath: ['首页', '记账', '统计', '预算与汇率'] },
    { id: 'bookkeeping:fx:edit', name: '更新参考汇率', group: '记账', serviceId: 'bookkeeping', action: 'edit', permissionPath: ['首页', '记账', '统计', '预算与汇率'] },
    { id: 'bookkeeping:analysis:view', name: '查看趋势、消费总结与统计穿透', group: '记账', serviceId: 'bookkeeping', action: 'view', permissionPath: ['首页', '记账', '统计', '趋势与消费分析'] },
    { id: 'bookkeeping:categories:view', name: '查看分类管理', group: '记账', serviceId: 'bookkeeping', action: 'view', permissionPath: ['首页', '记账', '分类管理'] },
    { id: 'bookkeeping:categories:edit', name: '新增、编辑、排序、停用和合并分类', group: '记账', serviceId: 'bookkeeping', action: 'edit', permissionPath: ['首页', '记账', '分类管理'] },
    { id: 'service:resources:view', name: '查看资源管理', group: '资源管理', serviceId: 'resources', action: 'view', permissionPath: ['首页', '资源管理'] },
    { id: 'service:resources:edit', name: '访问资源管理监控', group: '资源管理', serviceId: 'resources', action: 'edit', permissionPath: ['首页', '资源管理', '编辑'] },
    { id: 'blog:feed:view', name: '查看和搜索博客动态', group: '博客', serviceId: 'blog', feature: 'feed', action: 'view', permissionPath: ['首页', '博客'] },
    { id: 'blog:post:edit', name: '发布和编辑自己的博客（含可见范围、标签与富文本）', group: '博客', serviceId: 'blog', feature: 'post', action: 'edit', permissionPath: ['首页', '博客', '我的文章'] },
    { id: 'blog:manage:edit', name: '查看和管理所有博客（含私密及可见时间外动态）', group: '博客', serviceId: 'blog', feature: 'manage', action: 'edit', permissionPath: ['首页', '博客', '所有文章'] },
    { id: 'blog:comment:view', name: '查看评论', group: '博客', serviceId: 'blog', feature: 'comment', action: 'view', permissionPath: ['首页', '博客', '评论'] },
    { id: 'blog:comment:edit', name: '发表评论及管理自己博客的评论（登录用户默认拥有）', group: '博客', serviceId: 'blog', feature: 'comment', action: 'edit', permissionPath: ['首页', '博客', '评论'] },
    { id: 'blog:comment-manage:edit', name: '管理可见博客的评论', group: '博客', serviceId: 'blog', feature: 'comment-manage', action: 'edit', permissionPath: ['首页', '博客', '评论管理'] },
    { id: 'admin:access:view', name: '查看管理后台', group: '系统', action: 'view', resource: 'admin:access' },
    { id: 'admin:access:edit', name: '编辑管理后台', group: '系统', action: 'edit', resource: 'admin:access' },
    { id: 'admin:users:view', name: '查看用户', group: '系统', action: 'view', resource: 'admin:users' },
    { id: 'admin:users:edit', name: '编辑用户', group: '系统', action: 'edit', resource: 'admin:users' },
    { id: 'admin:roles:view', name: '查看角色', group: '系统', action: 'view', resource: 'admin:roles' },
    { id: 'admin:roles:edit', name: '编辑角色', group: '系统', action: 'edit', resource: 'admin:roles' },
    { id: 'admin:menus:view', name: '查看菜单', group: '系统', action: 'view', resource: 'admin:menus' },
    { id: 'admin:menus:edit', name: '编辑菜单', group: '系统', action: 'edit', resource: 'admin:menus' }
];

function newId(prefix) {
    return prefix + '_' + crypto.randomBytes(6).toString('hex');
}

export function hashPassword(password, salt) {
    return crypto.scryptSync(password, salt, 64).toString('hex');
}

export function createPasswordRecord(password) {
    var salt = crypto.randomBytes(16).toString('hex');
    return { salt: salt, passwordHash: hashPassword(password, salt) };
}

export function verifyPassword(password, record) {
    if (!record?.salt || !record?.passwordHash) return false;
    var hash = hashPassword(password, record.salt);
    try {
        return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(record.passwordHash, 'hex'));
    } catch (e) {
        return false;
    }
}

function serviceViewPermissionId(serviceId) {
    return 'service:' + serviceId + ':view';
}

function serviceEditPermissionId(serviceId) {
    return 'service:' + serviceId + ':edit';
}

function buildServicePermissions(services) {
    return (services || []).flatMap(function(service) {
        var title = service.title || service.id;
        return [
            {
                id: serviceViewPermissionId(service.id),
                name: '查看「' + title + '」',
                group: '服务',
                serviceId: service.id,
                action: 'view'
            },
            {
                id: serviceEditPermissionId(service.id),
                name: '编辑「' + title + '」',
                group: '服务',
                serviceId: service.id,
                action: 'edit'
            }
        ];
    });
}

function defaultAdminRole(servicePerms) {
    return {
        id: 'role_admin',
        name: '管理员',
        description: '拥有全部权限',
        permissions: ['*'].concat(servicePerms.map(function(p) { return p.id; }))
    };
}

function defaultUserRole() {
    return {
        id: 'role_user',
        name: '普通用户',
        description: '由管理员分配可见服务',
        permissions: []
    };
}

function buildDefaultGuestPermissions(services) {
    var perms = new Set([
        'service:torn-toolbox:view',
        'service:torn-undercut:view',
        'service:torn-company:view',
        'service:stock-manage:view',
        'service:qqq-dip:view',
        'service:notes:view'
    ]);
    (services || []).forEach(function(service) {
        if (!service.hidden && service.id && service.id !== 'siyuan-share') {
            perms.add(serviceViewPermissionId(service.id));
        }
    });
    buildStockManagePermissions().forEach(function(item) {
        if (item.action === 'view' && item.feature !== 'cash') perms.add(item.id);
    });
    buildQqqDipPermissions().forEach(function(item) {
        if (item.action === 'view') perms.add(item.id);
    });
    return Array.from(perms);
}

function ensureGuestAccess(data, config) {
    if (!data.roles) data.roles = [];
    if (!data.users) data.users = [];
    var guestUsername = config?.auth?.guestUsername || 'guest';

    var guestRole = data.roles.find(function(r) { return r.id === 'role_guest'; });
    var newGuestRole = !guestRole;
    if (!guestRole) {
        var initialPermissions = new Set(buildDefaultGuestPermissions(config?.services));
        [
            'service:napcat:view',
            'service:napcat:edit',
            'service:notifications:view',
            'service:notifications:edit',
            'service:piclist:view',
            'service:piclist:edit'
        ].forEach(function(permission) { initialPermissions.delete(permission); });
        guestRole = {
            id: 'role_guest',
            name: '游客',
            description: '未登录访客的默认权限',
            permissions: Array.from(initialPermissions)
        };
        data.roles.push(guestRole);
    }
    // Grant the safe public surfaces once; later administrator revocations remain effective.
    if (newGuestRole || !data.guestModuleBrowsingVersion) {
        guestRole.permissions = Array.from(new Set((guestRole.permissions || []).concat(
            'codex-cli:view', 'knowledge:view', 'knowledge:notes:view', 'mingli:view', 'mingli:chart:calculate'
        )));
        data.guestModuleBrowsingVersion = 1;
    }
    if (newGuestRole || !data.guestChainBrowsingVersion) {
        guestRole.permissions = Array.from(new Set((guestRole.permissions || []).concat('torn-chain:view')));
        data.guestChainBrowsingVersion = 1;
    }
    if (!data.guestCashPermissionsMigrated) guestRole.permissions = (guestRole.permissions || []).filter(function(permission) {
        return permission !== stockManageFeaturePermissionId('cash', 'view')
            && permission !== stockManageFeaturePermissionId('cash', 'edit');
    });
    data.guestCashPermissionsMigrated = true;

    var guestUser = data.users.find(function(u) { return u.username === guestUsername; });
    data.guestUserId = guestUser?.id || 'usr_guest';
    if (!guestUser) {
        data.users.push({
            id: 'usr_guest',
            username: guestUsername,
            roleIds: ['role_guest'],
            enabled: true,
            createdAt: new Date().toISOString()
        });
    } else if (!Array.isArray(guestUser.roleIds)) guestUser.roleIds = ['role_guest'];
}

function normalizeMenuPermission(menu) {
    if (!menu) return menu;
    if (menu.serviceId === 'codex-cli') { menu.permission = 'codex-cli:view'; return menu; }
    if (menu.serviceId) {
        menu.permission = serviceViewPermissionId(menu.serviceId);
        return menu;
    }
    if (menu.id === 'menu_admin' || ['/admin', '/admin/', '/admin.html', '/admin/index.html'].includes(menu.path)) {
        menu.path = '/admin/';
        menu.permission = 'admin:access:view';
        return menu;
    }
    if (menu.permission === 'admin:access') {
        menu.permission = 'admin:access:view';
        return menu;
    }
    var legacyService = /^service:([^:]+)$/.exec(menu.permission || '');
    if (legacyService) {
        menu.permission = serviceViewPermissionId(legacyService[1]);
    }
    return menu;
}

function mergeServiceMenu(base, override) {
    var menu = Object.assign({}, base, override || {});
    menu.title = base.title;
    menu.description = base.description;
    menu.icon = base.icon;
    menu.type = base.type;
    menu.serviceId = base.serviceId;
    menu.permission = base.permission;
    if (base.path) {
        menu.path = base.path;
        delete menu.url;
    } else if (base.url) {
        menu.url = base.url;
        delete menu.path;
    }
    if (override) {
        if (override.sort != null) menu.sort = override.sort;
        if (override.enabled != null) menu.enabled = override.enabled;
    }
    return normalizeMenuPermission(menu);
}

export function buildMenusFromServices(services, overrides) {
    var overrideMap = {};
    (overrides || []).forEach(function(item) {
        overrideMap[item.id] = item;
    });
    var menus = (services || [])
        .filter(function(service) { return !service.hidden; })
        .map(function(service, index) {
            var id = 'menu_' + service.id;
            var base = {
                id: id,
                title: service.title || service.id,
                description: service.description || '',
                icon: service.icon || '📦',
                type: service.type,
                serviceId: service.id,
                permission: serviceViewPermissionId(service.id),
                sort: (index + 1) * 10,
                enabled: true
            };
            if (service.type === 'external') base.url = service.url;
            else base.path = service.path;
            return mergeServiceMenu(base, overrideMap[id]);
        });
    var adminMenu = normalizeMenuPermission(Object.assign({
        id: 'menu_admin',
        title: '权限管理',
        description: '用户、角色、菜单与权限配置',
        icon: '🔐',
        path: '/admin/',
        permission: 'admin:access:view',
        sort: 9990,
        enabled: true
    }, overrideMap.menu_admin || {}));
    menus.push(adminMenu);
    for (const module of PORTAL_MODULES.filter(module => module.path)) {
        menus.push(moduleMenu(module, overrideMap['menu_' + module.id] || {}));
    }
    return menus.sort(function(a, b) { return (a.sort || 0) - (b.sort || 0); });
}

function createDefaultRbac(config) {
    var servicePerms = buildServicePermissions(config.services);
    var stockManagePerms = buildStockManagePermissions();
    var qqqDipPerms = buildQqqDipPermissions();
    var adminUser = config.auth || {};
    var pwd = createPasswordRecord(adminUser.password || 'change-me');
    var created = {
        users: [{
            id: 'usr_admin',
            username: adminUser.username || 'admin',
            salt: pwd.salt,
            passwordHash: pwd.passwordHash,
            roleIds: ['role_admin'],
            enabled: true,
            createdAt: new Date().toISOString()
        }],
        roles: [defaultAdminRole(servicePerms), defaultUserRole()],
        menus: buildMenusFromServices(config.services, []),
        permissions: SYSTEM_PERMISSIONS.concat(servicePerms).concat(stockManagePerms).concat(qqqDipPerms),
        userPrefs: {}
    };
    ensureGuestAccess(created, config);
    ensureAccessPolicy(created);
    return created;
}

export function loadRbac(config) {
    var db = getDatabase();
    var key = configServicesKey(config) + ':' + db.name + ':' + rbacRevision(db);
    if (rbacCache && rbacCacheConfigKey === key) {
        return copyRbac(rbacCache);
    }
    var data = loadRbacBlob(db);
    if (!data) {
        data = createDefaultRbac(config);
        saveRbac(data);
        rbacCache = data;
        rbacCacheConfigKey = configServicesKey(config) + ':' + db.name + ':' + rbacRevision(db);
        return copyRbac(data);
    }
    data = syncRbacPermissions(data, config);
    rbacCache = data;
    rbacCacheConfigKey = configServicesKey(config) + ':' + db.name + ':' + rbacRevision(db);
    return copyRbac(data);
}

export function saveRbac(data) {
    var db = getDatabase();
    saveRbacBlob(db, data);
    rbacCache = copyRbac(data);
    rbacCacheConfigKey = null;
}

function migrateRolePermissions(permissions) {
    if ((permissions || []).includes('*')) return ['*'];
    var out = new Set(permissions || []);
    var legacyMap = {
        'admin:access': ['admin:access:view', 'admin:access:edit'],
        'admin:users': ['admin:users:view', 'admin:users:edit'],
        'admin:roles': ['admin:roles:view', 'admin:roles:edit'],
        'admin:menus': ['admin:menus:view', 'admin:menus:edit']
    };
    (permissions || []).forEach(function(p) {
        if (legacyMap[p]) legacyMap[p].forEach(function(id) { out.add(id); });
        var serviceMatch = /^service:([^:]+)$/.exec(p);
        if (serviceMatch && !p.endsWith(':view') && !p.endsWith(':edit')) {
            out.add('service:' + serviceMatch[1] + ':view');
            out.add('service:' + serviceMatch[1] + ':edit');
        }
    });
    return Array.from(out);
}

export function syncRbacPermissions(data, config) {
    var before = JSON.stringify(data);
    ensureAccessPolicy(data);
    var servicePerms = buildServicePermissions(config.services);
    var stockManagePerms = buildStockManagePermissions();
    var qqqDipPerms = buildQqqDipPermissions();
    var notificationPerms = buildNotificationPermissions();
    var known = {};
    SYSTEM_PERMISSIONS.concat(servicePerms).concat(stockManagePerms).concat(qqqDipPerms).concat(notificationPerms).forEach(function(p) { known[p.id] = p; });
    (data.permissions || []).forEach(function(p) {
        if (!known[p.id] && !isRetiredStockColumnPermission(p.id)) known[p.id] = p;
    });
    data.permissions = Object.keys(known).map(function(id) { return known[id]; });
    data.permissions = data.permissions.filter(function(p) {
        if (p.id === 'admin:access' || p.id === 'admin:users' || p.id === 'admin:roles' || p.id === 'admin:menus') {
            return false;
        }
        return !/^service:[^:]+$/.test(p.id);
    });

    (data.roles || []).forEach(function(role) {
        role.permissions = migrateRolePermissions(role.permissions || []).filter(function(id) {
            return !isRetiredStockColumnPermission(id);
        });
    });

    var overrideMap = {};
    (data.menus || []).forEach(function(menu) { overrideMap[menu.id] = menu; });
    data.menus = buildMenusFromServices(config.services, Object.values(overrideMap));

    var adminRole = (data.roles || []).find(function(r) { return r.id === 'role_admin'; });
    if (adminRole && adminRole.permissions.includes('*')) {
        data.permissions.forEach(function(p) {
            if (!adminRole.permissions.includes(p.id)) adminRole.permissions.push(p.id);
        });
    }
    if (!data.userPrefs) data.userPrefs = {};
    ensureGuestAccess(data, config);
    if (JSON.stringify(data) !== before) {
        saveRbac(data);
    }
    return data;
}

function isRetiredStockColumnPermission(id) {
    return /^service:stock-manage:col-(target|signal):(view|edit)$/.test(id);
}

export function findUserByUsername(data, username) {
    return (data.users || []).find(function(u) {
        return u.username === username && u.enabled !== false;
    }) || null;
}

export function findUserById(data, userId) {
    return (data.users || []).find(function(u) { return u.id === userId; }) || null;
}

export function canViewAdmin(userPerms) {
    return hasPermission(userPerms, 'admin:access:view');
}

export function canEditAdminResource(userPerms, resource) {
    return hasPermission(userPerms, resource + ':edit');
}

export function canViewAdminResource(userPerms, resource) {
    return hasPermission(userPerms, resource + ':view') || canEditAdminResource(userPerms, resource);
}

export function authenticateUser(data, username, password) {
    var user = findUserByUsername(data, username);
    if (!user) return null;
    if (!user.passwordHash || !user.salt) return null;
    if (!verifyPassword(password, user)) return null;
    return user;
}

export function getVisibleMenus(data, userPerms) {
    return (data.menus || [])
        .filter(function(menu) { return menu.enabled !== false; })
        // Advertise these entries to everyone; their pages and APIs enforce access separately.
        .filter(function(menu) { return ['resources', 'bookkeeping', 'codex-cli', 'knowledge', 'mingli'].includes(menu.serviceId) || hasPermission(userPerms, menu.permission); })
        .sort(function(a, b) { return (a.sort || 0) - (b.sort || 0); });
}

export function canViewService(userPerms, serviceId) {
    return hasPermission(userPerms, serviceViewPermissionId(serviceId));
}

export function canEditService(userPerms, serviceId) {
    return hasPermission(userPerms, serviceEditPermissionId(serviceId));
}

export function canTestNotificationSlack(userPerms) {
    return canEditService(userPerms, NOTIFICATIONS_SERVICE_ID)
        || hasPermission(userPerms, 'service:notifications:slack-test:edit');
}

export function canManageBusinessNotification(userPerms, action) {
    return canEditService(userPerms, NOTIFICATIONS_SERVICE_ID)
        || hasPermission(userPerms, 'service:notifications:business-' + action + ':edit');
}

export function canWriteService(userPerms, serviceId) {
    if (canEditService(userPerms, serviceId)) return true;
    if ((userPerms || []).includes('*')) return true;
    if (serviceId === STOCK_MANAGE_SERVICE_ID) {
        return STOCK_MANAGE_FEATURES.some(function(item) {
            return item.action === 'edit'
                && userPerms.includes(stockManageFeaturePermissionId(item.feature, item.action));
        });
    }
    if (serviceId === QQQ_DIP_SERVICE_ID) {
        return QQQ_DIP_FEATURES.some(function(item) {
            return item.action === 'edit'
                && userPerms.includes(qqqDipFeaturePermissionId(item.feature, item.action));
        });
    }
    return false;
}

export function hasStockManageFeature(userPerms, feature, action) {
    if (!feature) return true;
    if ((userPerms || []).includes('*')) return true;
    if ((userPerms || []).includes(serviceEditPermissionId(STOCK_MANAGE_SERVICE_ID))) return true;
    var fid = stockManageFeaturePermissionId(feature, action);
    if (userPerms.includes(fid)) return true;
    if (action === 'view') {
        if (userPerms.includes(stockManageFeaturePermissionId(feature, 'edit'))) return true;
    }
    return false;
}

export function hasQqqDipFeature(userPerms, feature, action) {
    if (!feature) return true;
    if ((userPerms || []).includes('*')) return true;
    var fid = qqqDipFeaturePermissionId(feature, action);
    if (userPerms.includes(fid)) return true;
    if (action === 'view') {
        if (userPerms.includes(qqqDipFeaturePermissionId(feature, 'edit'))) return true;
    }
    return false;
}

export function getStockManagePrefs(data, userId) {
    var raw = ((data.userPrefs || {})[userId] || {}).stockManage || {};
    return {
        dashboardVisible: raw.dashboardVisible !== false,
        colVis: raw.colVis && typeof raw.colVis === 'object' ? raw.colVis : null,
        pnlVisible: raw.pnlVisible !== false
    };
}

export function updateUserPrefs(data, userId, patch) {
    if (!userId) throw new Error('无效用户');
    if (!data.userPrefs) data.userPrefs = {};
    var current = data.userPrefs[userId] || {};
    var next = Object.assign({}, current);
    Object.keys(patch || {}).forEach(function(key) {
        if (patch[key] && typeof patch[key] === 'object' && !Array.isArray(patch[key])) {
            next[key] = Object.assign({}, current[key] || {}, patch[key]);
        } else {
            next[key] = patch[key];
        }
    });
    data.userPrefs[userId] = next;
    saveRbac(data);
    return next;
}

/** @deprecated use canViewService */
export function canAccessService(userPerms, serviceId) {
    return canViewService(userPerms, serviceId);
}

export function publicUser(user) {
    return {
        id: user.id,
        username: user.username,
        roleIds: user.roleIds || [],
        enabled: user.enabled !== false,
        createdAt: user.createdAt || null,
        oauthProviders: Object.keys(user.oauth || {})
    };
}

export function findUserByOAuth(data, provider, providerId) {
    return (data.users || []).find(function(user) {
        var link = (user.oauth || {})[provider];
        return link && String(link.id) === String(providerId);
    }) || null;
}

export function upsertOAuthUser(data, payload) {
    var provider = payload.provider;
    var providerId = String(payload.providerId || '');
    if (!provider || !providerId) throw new Error('OAuth 用户信息不完整');

    var existing = findUserByOAuth(data, provider, providerId);
    if (existing) {
        existing.oauth = existing.oauth || {};
        existing.oauth[provider] = {
            id: providerId,
            login: payload.login || null,
            email: payload.email || null,
            name: payload.name || null
        };
        if (payload.email) existing.email = payload.email;
        existing.enabled = true;
        return existing;
    }

    var username = payload.username || (provider + ':' + providerId);
    if (findUserByUsername(data, username)) {
        username = provider + ':' + providerId;
    }

    var user = {
        id: newId('usr'),
        username: username,
        roleIds: [payload.defaultRoleId || 'role_guest'],
        enabled: true,
        createdAt: new Date().toISOString(),
        oauth: {}
    };
    user.oauth[provider] = {
        id: providerId,
        login: payload.login || null,
        email: payload.email || null,
        name: payload.name || null
    };
    if (payload.email) user.email = payload.email;
    if (!data.users) data.users = [];
    data.users.push(user);
    return user;
}

export function sanitizeRbac(data) {
    return {
        users: (data.users || []).map(publicUser),
        roles: (data.roles || []).map(function(role) {
            return {
                id: role.id,
                name: role.name,
                description: role.description || '',
                permissions: role.permissions || []
            };
        }),
        menus: (data.menus || []).map(function(menu) {
            return Object.assign({}, menu);
        }),
        permissions: data.permissions || []
    };
}

export function upsertUser(data, payload) {
    if (!payload.username) throw new Error('用户名不能为空');
    var existing = (data.users || []).find(function(u) {
        return u.username === payload.username && u.id !== payload.id;
    });
    if (existing) throw new Error('用户名已存在');

    if (payload.id) {
        var user = findUserById(data, payload.id);
        if (!user) throw new Error('用户不存在');
        user.username = payload.username;
        user.roleIds = payload.roleIds || [];
        user.enabled = payload.enabled !== false;
        if (payload.password) {
            var pwd = createPasswordRecord(payload.password);
            user.salt = pwd.salt;
            user.passwordHash = pwd.passwordHash;
        }
        return user;
    }

    if (!payload.password) throw new Error('新建用户需要密码');
    var created = Object.assign({
        id: newId('usr'),
        createdAt: new Date().toISOString(),
        enabled: true,
        roleIds: ['role_user']
    }, payload);
    var record = createPasswordRecord(payload.password);
    created.salt = record.salt;
    created.passwordHash = record.passwordHash;
    delete created.password;
    data.users.push(created);
    return created;
}

export function deleteUser(data, userId) {
    if (userId === 'usr_admin') throw new Error('不能删除内置管理员');
    var idx = (data.users || []).findIndex(function(u) { return u.id === userId; });
    if (idx < 0) throw new Error('用户不存在');
    data.users.splice(idx, 1);
}

export function upsertRole(data, payload) {
    if (!payload.name) throw new Error('角色名不能为空');
    if (payload.id) {
        var role = (data.roles || []).find(function(r) { return r.id === payload.id; });
        if (!role) throw new Error('角色不存在');
        if (role.id === 'role_admin' && !(payload.permissions || []).includes('*')) {
            throw new Error('管理员角色必须保留全部权限');
        }
        role.name = payload.name;
        role.description = payload.description || '';
        role.permissions = payload.permissions || [];
        return role;
    }
    var created = {
        id: newId('role'),
        name: payload.name,
        description: payload.description || '',
        permissions: payload.permissions || []
    };
    data.roles.push(created);
    return created;
}

export function deleteRole(data, roleId) {
    if (roleId === 'role_admin' || roleId === 'role_user') {
        throw new Error('不能删除内置角色');
    }
    if ((data.users || []).some(function(u) { return (u.roleIds || []).includes(roleId); })) {
        throw new Error('仍有用户使用该角色');
    }
    data.roles = (data.roles || []).filter(function(r) { return r.id !== roleId; });
}

export function updateMenus(data, menus) {
    data.menus = (menus || []).map(function(menu, index) {
        return Object.assign({}, menu, { sort: menu.sort != null ? menu.sort : (index + 1) * 10 });
    });
}

export {
    SYSTEM_PERMISSIONS,
    STOCK_MANAGE_FEATURES,
    QQQ_DIP_FEATURES,
    serviceViewPermissionId,
    serviceEditPermissionId,
    stockManageFeaturePermissionId,
    qqqDipFeaturePermissionId,
    ensureGuestAccess,
    newId
};
