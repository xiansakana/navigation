(function() {
    window.createBlogVisibility = function(root, initial) {
        root.className = 'blog-visibility';
        var audience = document.createElement('select');
        audience.setAttribute('aria-label', '可见范围');
        [['public', '所有有博客访问权限的人'], ['members', '仅登录用户'], ['self', '仅自己']].forEach(function(item) {
            audience.add(new Option(item[1], item[0]));
        });
        var period = document.createElement('select');
        period.setAttribute('aria-label', '可见时间');
        [['always', '时间不限'], ['3d', '发布后 3 天'], ['1m', '发布后 30 天'], ['6m', '发布后 180 天'], ['custom', '自定义时间']].forEach(function(item) {
            period.add(new Option(item[1], item[0]));
        });
        function field(text, control) {
            var label = document.createElement('label');
            label.append(document.createTextNode(text), control);
            return label;
        }
        var dates = document.createElement('div'); dates.className = 'blog-visibility-dates';
        var start = document.createElement('input'); start.type = 'datetime-local'; start.setAttribute('aria-label', '开始可见时间');
        var end = document.createElement('input'); end.type = 'datetime-local'; end.setAttribute('aria-label', '结束可见时间');
        dates.append(field('开始（可留空）', start), field('结束（可留空）', end));
        var hint = document.createElement('p'); hint.className = 'blog-visibility-hint';
        hint.textContent = '作者始终可见。到期后其他人无法查看；自定义时间按当前设备时区设置。';
        root.append(field('可见范围', audience), field('可见时间', period), dates, hint);
        function update() { dates.hidden = period.value !== 'custom'; }
        period.addEventListener('change', update);
        function local(value) {
            if (!value) return '';
            var date = new Date(value);
            return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        }
        function set(value) {
            value = value || {};
            audience.value = value.audience || 'public'; period.value = value.period || 'always';
            start.value = local(value.startsAt); end.value = local(value.endsAt); update();
        }
        set(initial);
        return {
            value: function() {
                var startsAt = period.value === 'custom' && start.value ? new Date(start.value).toISOString() : null;
                var endsAt = period.value === 'custom' && end.value ? new Date(end.value).toISOString() : null;
                if (period.value === 'custom' && !startsAt && !endsAt) throw new Error('请至少设置一个可见时间');
                if (startsAt && endsAt && startsAt >= endsAt) throw new Error('结束时间必须晚于开始时间');
                return { audience: audience.value, period: period.value, startsAt: startsAt, endsAt: endsAt };
            },
            clear: function() { set({}); }
        };
    };
})();
