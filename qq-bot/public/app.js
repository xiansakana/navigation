var currentConfig = null;
var byId = function(id) { return document.getElementById(id); };

async function api(path, options) {
    var response = await fetch(path, options || {});
    var data = await response.json();
    if (!response.ok || data.ok === false) throw new Error(data.error || response.statusText);
    return data;
}

function toast(message, isError) {
    var el = byId('toast');
    el.textContent = message;
    el.className = 'toast' + (isError ? ' error' : '');
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function() { el.hidden = true; }, 3200);
}

function updateTargetFields() {
    var group = byId('qq-type').value === 'group';
    byId('qq-user-wrap').classList.toggle('hidden', group);
    byId('qq-group-wrap').classList.toggle('hidden', !group);
    byId('qq-at-wrap').classList.toggle('hidden', !group);
}

function fill(data) {
    currentConfig = data.config;
    var config = data.config;
    byId('qq-enabled').checked = !!config.channels.qq.enabled;
    byId('qq-base-url').value = config.napcat.baseUrl || '';
    byId('qq-token').placeholder = config.napcat.hasAccessToken ? '已设置，留空则保持原值' : '尚未设置';
    byId('qq-type').value = config.defaultTarget.type || 'private';
    byId('qq-user-id').value = config.defaultTarget.userId || '';
    byId('qq-group-id').value = config.defaultTarget.groupId || '';
    byId('qq-at-user-id').value = config.defaultTarget.atUserId || '';
    byId('email-enabled').checked = !!config.channels.email.enabled;
    byId('smtp-host').value = config.channels.email.smtp.host || '';
    byId('smtp-port').value = config.channels.email.smtp.port || 465;
    byId('smtp-secure').checked = config.channels.email.smtp.secure !== false;
    byId('smtp-user').value = config.channels.email.smtp.user || '';
    byId('smtp-pass').placeholder = config.channels.email.smtp.hasPassword ? '已设置，留空则保持原值' : '尚未设置';
    byId('email-from').value = config.channels.email.from || '';
    byId('email-to').value = config.channels.email.to || '';
    updateTargetFields();
    renderStatus(data.channels || []);
}

function renderStatus(channels) {
    var enabled = channels.filter(function(item) { return item.enabled; }).length;
    var ready = channels.filter(function(item) { return item.enabled && item.ready; }).length;
    byId('summary').textContent = enabled ? ready + ' / ' + enabled + ' 个已启用渠道就绪' : '尚未启用通知渠道';
    channels.forEach(function(status) {
        var card = document.querySelector('[data-channel="' + status.id + '"]');
        card.classList.toggle('ready', status.enabled && status.ready);
        card.classList.toggle('not-ready', status.enabled && !status.ready);
        card.querySelector('.status-text').textContent = !status.enabled ? '已停用' : status.ready ? '配置已就绪' : '配置不完整';
    });
}

function payload() {
    return {
        napcat: { baseUrl: byId('qq-base-url').value, accessToken: byId('qq-token').value },
        defaultTarget: {
            type: byId('qq-type').value,
            userId: byId('qq-user-id').value,
            groupId: byId('qq-group-id').value,
            atUserId: byId('qq-at-user-id').value
        },
        channels: {
            qq: { enabled: byId('qq-enabled').checked },
            email: {
                enabled: byId('email-enabled').checked,
                from: byId('email-from').value,
                to: byId('email-to').value,
                smtp: {
                    host: byId('smtp-host').value,
                    port: Number(byId('smtp-port').value),
                    secure: byId('smtp-secure').checked,
                    user: byId('smtp-user').value,
                    pass: byId('smtp-pass').value
                }
            }
        }
    };
}

byId('qq-type').addEventListener('change', updateTargetFields);
document.querySelectorAll('input,select').forEach(function(input) {
    input.addEventListener('input', function() { byId('save-state').textContent = '有尚未保存的修改'; });
});

byId('save').addEventListener('click', async function() {
    var button = byId('save');
    button.disabled = true;
    try {
        var data = await api('api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload()) });
        byId('qq-token').value = '';
        byId('smtp-pass').value = '';
        fill(data);
        byId('save-state').textContent = '配置已保存';
        toast('通知渠道配置已保存');
    } catch (err) { toast(err.message, true); }
    finally { button.disabled = false; }
});

document.querySelectorAll('[data-test]').forEach(function(button) {
    button.addEventListener('click', async function() {
        var channel = button.dataset.test;
        button.disabled = true;
        try {
            await api('api/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: channel, message: byId('test-message').value }) });
            toast((channel === 'qq' ? 'QQ' : '邮件') + '测试通知已发送');
        } catch (err) { toast(err.message, true); }
        finally { button.disabled = false; }
    });
});

api('api/config').then(fill).catch(function(err) { toast('加载失败：' + err.message, true); });
