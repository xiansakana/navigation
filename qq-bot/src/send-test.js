import { loadConfig } from './config.js';
import { getLoginInfo, sendMessage } from './napcat.js';

function parseArgs(argv) {
    var userId = null;
    var groupId = null;
    var type = null;
    var parts = [];

    for (var i = 0; i < argv.length; i++) {
        var arg = argv[i];
        if (arg === '--user' && argv[i + 1]) {
            userId = argv[++i];
            type = 'private';
        } else if (arg === '--group' && argv[i + 1]) {
            groupId = argv[++i];
            type = 'group';
        } else {
            parts.push(arg);
        }
    }

    return {
        message: parts.join(' ') || 'NapCat 测试消息 - Torn QQ Bot',
        target: {
            type: type || null,
            userId: userId,
            groupId: groupId
        }
    };
}

async function main() {
    var config = loadConfig();
    var parsed = parseArgs(process.argv.slice(2));
    var target = {
        type: parsed.target.type || config.defaultTarget.type || 'private',
        userId: parsed.target.userId || config.defaultTarget.userId,
        groupId: parsed.target.groupId || config.defaultTarget.groupId
    };

    console.log('检查 NapCat 登录状态...');
    var login = await getLoginInfo(config.napcat.baseUrl, config.napcat.accessToken);
    console.log('已登录 QQ:', login.data && login.data.user_id, login.data && login.data.nickname);

    console.log('发送消息:', parsed.message);
    console.log('目标:', target.type === 'group' ? ('群 ' + target.groupId) : ('私聊 ' + target.userId));

    var result = await sendMessage(config.napcat, target, parsed.message);
    console.log('发送成功:', JSON.stringify(result, null, 2));
}

main().catch(function(err) {
    console.error('发送失败:', err.message);
    process.exit(1);
});
