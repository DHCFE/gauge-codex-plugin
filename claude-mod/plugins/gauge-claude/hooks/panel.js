const LABELS = ['普通输入', '缓存读取', '缓存写入', '输出'];
const COLORS = ['#b5b5b5', '#969696', '#575757', '#333333'];
const RANGE = [
    { value: 'all', label: '全部历史' },
    { value: 'today', label: '今天' },
    { value: 'week', label: '本周额度窗口' },
    { value: 'month', label: '近 30 天' },
];
const SPEED = { standard: 'Standard', fast: 'Fast', unknown: '速度未记录' };
const WEEK = 7 * 24 * 60 * 60 * 1000;

export const count = value => value.toLocaleString('en-US');
export const sum = values => values.reduce((total, value) => total + value, 0);
const money = nanos => '$' + (nanos / 1e9).toFixed(nanos > 0 && nanos < 100_000 ? 6 : 4);
const date = timestamp => new Date(timestamp).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
const modelName = model => model.replace(/^claude-/, '').replace(/-\d{8}$/, '')
    .replace(/^(\w+)-(.*)$/, (_, family, version) => family[0].toUpperCase() + family.slice(1) + ' ' + version.replaceAll('-', '.'));

export function amount(data) {
    if (!data?.requests || (sum(data.tokens) && sum(data.missing) === sum(data.tokens))) return '—';
    return (data.unpriced ? '≥ ' : '') + money(sum(data.cost));
}

export function weeklyWindow(window, now = Date.now()) {
    const end = Date.parse(window?.resetsAt);
    return Number.isFinite(end) && now >= end - WEEK && now < end ? [end - WEEK, end] : [0, 0];
}

export function projection(account, window, now = Date.now()) {
    const [start, end] = weeklyWindow(window, now);
    const observed = account?.periods?.week;
    const percent = window?.percentUsed;
    if (!start || end !== account?.weekEnd || !observed?.requests ||
        !Number.isFinite(percent) || percent <= 0 || percent > 100 || sum(observed.cost) <= 0) return null;
    const cost = sum(observed.cost) / 1e9;
    const capacity = cost / (percent / 100);
    return { capacity, remaining: capacity - cost, cost, percent, partial: observed.unpriced > 0 };
}

function combine(items) {
    const result = { requests: 0, unpriced: 0, tokens: [0, 0, 0, 0], cost: [0, 0, 0, 0], missing: [0, 0, 0, 0] };
    for (const item of items) {
        result.requests += item.requests;
        result.unpriced += item.unpriced;
        for (const key of ['tokens', 'cost', 'missing']) item[key].forEach((value, index) => { result[key][index] += value; });
    }
    return result;
}

export function filteredSessions(account, filters) {
    const query = filters.query.toLocaleLowerCase().trim();
    return (account?.sessions ?? []).flatMap(session => {
        if (query && !(session.title + ' ' + session.project).toLocaleLowerCase().includes(query)) return [];
        const groups = filters.model ? session.models.filter(group => group.model === filters.model) : session.models;
        if (!groups.length) return [];
        const filtered = filters.range === 'all' ? combine(groups)
            : filters.model ? session.modelWindows[filters.model]?.[filters.range] : session.windows[filters.range];
        return filtered?.requests ? [{ ...session, filtered, groups }] : [];
    });
}

export function sessionsCsv(sessions) {
    const field = value => '"' + String(value).replaceAll('"', '""').replace(/^[=+\-@\t\r]/, "'$&") + '"';
    return [
        '对话,项目,日期,请求数,普通输入,缓存读取,缓存写入,输出,API 等价 USD,部分未计价',
        ...sessions.map(row => [
            row.title, row.project, new Date(row.updated * 1000).toISOString(), row.filtered.requests,
            ...row.filtered.tokens, (sum(row.filtered.cost) / 1e9).toFixed(9), row.filtered.unpriced,
        ].map(field).join(',')),
    ].join('\n');
}

export function drawPanel(ui, view, actions) {
    const { Box, Text, Button, Select, Input, Svg } = ui;
    const compact = view.width < 29;
    const graphicWidth = Math.max(96, Math.min(920, Math.floor(view.width * 8.4)));
    const text = (value, style = {}) => Text({ ...style, children: [value] });
    const subtle = (value, style = {}) => text(value, { dimColor: true, size: 'footnote', ...style });
    const number = (value, style = {}) => text(value, { tabular: true, ...style });
    const column = (children, props = {}) => Box({ flexDirection: 'column', ...props, children: children.filter(Boolean) });
    const row = (children, props = {}) => Box({ flexDirection: 'row', alignItems: 'center', ...props, children: children.filter(Boolean) });
    const control = (key, label, active) => Button({
        key: 'gauge-' + key, label, ...(active ? { variant: 'primary' } : { plain: true }),
        onPress: () => actions.select(key),
    });
    const rule = (width = graphicWidth, active = false) => Svg ? Svg({
        source: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 1" preserveAspectRatio="none"><rect width="100" height="1" fill="#818181" opacity="' + (active ? '1' : '.30') + '"/></svg>',
        width, height: active ? 2 : 1, alt: '',
    }) : null;
    const section = (name, children) => column([rule(), text(name, { size: 'heading', weight: 'semibold' }), ...children], {
        gap: 'sm', marginTop: 'lg',
    });
    const tabs = (options, selected) => row(options.map(([key, label]) => control(key, label, key === selected)), {
        gap: 'sm', flexWrap: 'wrap',
    });
    const nav = row([['conversation', '对话'], ['account', '账号']].map(([key, label]) =>
        column([control(key, label, !Svg && key === view.tab), key === view.tab ? rule(37, true) : null],
            { alignItems: 'center', gap: 'xs' })), { alignItems: 'flex-start', gap: 'md' });
    const usd = value => '$' + Math.round(value).toLocaleString('en-US');
    const totalText = data => data?.requests ? count(sum(data.tokens)) + ' tokens' : '';
    const readyText = view.error || '暂无用量记录';
    const compactTokens = data => {
        if (!data?.requests) return '';
        const tokens = sum(data.tokens);
        return tokens >= 1e6 ? (tokens / 1e6).toFixed(2) + 'M tokens'
            : tokens >= 1e4 ? (tokens / 1e3).toFixed(1) + 'K tokens' : totalText(data);
    };

    function metric(label, value, detail) {
        return column([subtle(label), number(value, { size: 'heading', weight: 'medium' }), detail ? subtle(detail) : null],
            { gap: 'xs', flexGrow: 1, flexShrink: 1, width: compact ? '100%' : '30%' });
    }

    function bar(items, alt, width = graphicWidth) {
        if (!Svg) return null;
        const rects = items.filter(item => item.width > 0).map(({ x, width, color, opacity = 1 }) =>
            '<rect x="' + x + '" y="3" width="' + width + '" height="7" fill="' + color + '" opacity="' + opacity + '"/>');
        return Svg({
            source: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 13" preserveAspectRatio="none">' + rects.join('') + '</svg>',
            width, height: 6, alt,
        });
    }

    function largeAmount(value) {
        if (!Svg || !/^(?:(?:≥ |至少约 |约 )?\$[\d,.]+)$/.test(value)) {
            return number(value, { size: 'title', weight: 'medium' });
        }
        const prefix = value.slice(0, value.indexOf('$') + 1);
        const figure = value.slice(prefix.length);
        const size = figure.length > 9 ? 34 : 41;
        return Svg({
            source: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + graphicWidth +
                ' 52" style="color-scheme:light dark"><text x="0" y="42" font-family="system-ui, -apple-system, sans-serif" font-size="' +
                size + '" font-weight="500" letter-spacing="-1.8" fill="currentColor" style="fill:light-dark(#171717,#f2f2f2)">' +
                '<tspan font-size="20" opacity=".58" letter-spacing="0">' + prefix +
                '</tspan><tspan dx="4">' + figure + '</tspan></text></svg>',
            width: graphicWidth, height: 52, alt: value,
        });
    }

    function hero(label, data, meta) {
        return column([
            subtle(label),
            largeAmount(amount(data)),
            subtle(data?.requests ? [totalText(data), meta].filter(Boolean).join(' · ') : readyText),
        ], { gap: 'sm', marginTop: 'lg', marginBottom: 'sm' });
    }

    function breakdown(data) {
        if (!data?.requests) return null;
        const all = sum(data.cost);
        let offset = 0;
        const pieces = data.cost.map((value, index) => {
            const width = all ? value / all * 100 : 0;
            const piece = { x: offset, width, color: COLORS[index] };
            offset += width;
            return piece;
        });
        return column([
            all ? bar(pieces, 'API 等价费用构成') : null,
            ...LABELS.map((name, index) => {
                const tokens = data.tokens[index];
                const partial = data.missing[index];
                const value = partial && partial === tokens ? '—' : (partial ? '≥ ' : '') + money(data.cost[index]);
                return column([
                    row([
                        column([text(name, { size: 'body' }), subtle(count(tokens) + ' tokens', { tabular: true })], { gap: 'xs', flexGrow: 1 }),
                        number(value, { size: 'body', mono: true }),
                    ], { gap: 'md', justifyContent: 'space-between', paddingY: 'xs' }),
                    index < LABELS.length - 1 ? rule() : null,
                ]);
            }),
        ], { marginTop: 'sm', gap: 'xs' });
    }

    function models(groups) {
        return groups.map(group => column([
            row([
                column([text(modelName(group.model), { weight: 'medium' }),
                    subtle(SPEED[group.speed] ?? group.speed)], { flexGrow: 1 }),
                column([number(amount(group), { mono: true }), subtle(totalText(group), { tabular: true })], { alignItems: 'flex-end' }),
            ], { gap: 'md', justifyContent: 'space-between', paddingY: 'xs' }),
            rule(),
        ]));
    }

    function chart(values, label) {
        const high = Math.max(0, ...values);
        if (!Svg || !high) return null;
        const step = 100 / values.length;
        const rects = values.map((value, index) => {
            const height = value / high * 37;
            return '<rect x="' + (index * step + step * .2) + '" y="' + (39 - height) +
                '" width="' + (step * .62) + '" height="' + height + '" fill="#858585"/>';
        });
        return Svg({
            source: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 41" preserveAspectRatio="none">' + rects.join('') + '</svg>',
            width: graphicWidth, height: 68, alt: label,
        });
    }

    function quotaCard(window, title) {
        const [, end] = window?.kind === 'seven_day' ? weeklyWindow(window) : [0, Date.parse(window?.resetsAt)];
        const used = end > Date.now() ? window?.percentUsed : null;
        const reset = used != null ? new Date(end).toLocaleString('zh-CN', {
            weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
        }) : null;
        const pct = Math.min(100, Math.max(0, used ?? 0));
        return column([
            subtle(title),
            number(used != null ? used + '%' : '—', { size: 'heading', weight: 'medium' }),
            bar([{ x: 0, width: 100, color: '#888888', opacity: .2 }, { x: 0, width: pct, color: '#707070' }], title + '已用比例', Math.floor(graphicWidth / 2 - 8)),
            reset ? subtle(reset + ' 重置') : null,
        ], { flexGrow: 1, flexShrink: 1, width: '46%', gap: 'xs' });
    }

    function accountOverview() {
        const data = view.account;
        const window = view.rates[1];
        const [start, end] = weeklyWindow(window);
        const week = end && end === data?.weekEnd ? data.periods.week : null;
        const estimate = projection(data, window);
        return [
            section('API 等价费用', [
                (compact ? column : row)([
                    metric('今日', amount(data?.periods?.today), compactTokens(data?.periods?.today)),
                    metric('本周窗口', amount(week), compactTokens(week)),
                    metric('近 30 天', amount(data?.periods?.month), compactTokens(data?.periods?.month)),
                ], { gap: 'md', alignItems: 'stretch' }),
                view.error ? subtle(view.error) : null,
            ].filter(Boolean)),
            section('官方额度 · 已用', [
                row([quotaCard(view.rates[0], '5 小时'), quotaCard(window, '7 天')], { gap: 'lg', alignItems: 'stretch' }),
            ]),
            section('周容量估算', [
                largeAmount(estimate ? (estimate.partial ? '至少约 ' : '约 ') + usd(estimate.capacity) : '—'),
                estimate ? subtle('剩余约 ' + usd(estimate.remaining) + ' · API 等价') : null,
                estimate ? subtle('本机 ' + money(estimate.cost * 1e9) + ' ÷ 官方已用 ' + estimate.percent + '%') : null,
                start ? subtle(date(start) + ' – ' + date(end) + ' · 按本机当前周的用法外推') : subtle('等待 Claude 提供周额度'),
            ].filter(Boolean)),
        ];
    }

    function accountDetails() {
        const sessions = filteredSessions(view.account, view.filters);
        const selected = sessions.find(item => item.id === view.accountSelection);
        if (selected) {
            return [
                control('back-to-sessions', '← 对话明细'),
                hero(selected.title, selected.filtered, selected.project),
                breakdown(selected.filtered),
                view.filters.range === 'all' ? section('模型与速度', models(selected.groups)) : null,
            ];
        }
        const modelOptions = [...new Set((view.account?.models ?? []).map(group => group.model))];
        const slice = sessions.slice(view.accountPage * view.pageSize, (view.accountPage + 1) * view.pageSize);
        return [
            section('本机对话', [
                Input ? Input({ key: 'gauge-search', placeholder: '搜索对话或项目', value: view.filters.query,
                    onSubmit: actions.search, onInput: actions.search }) : null,
                Select ? row([
                    Select({ key: 'gauge-range', label: '时间', options: RANGE, value: view.filters.range,
                        onSelect: value => actions.filter('range', value) }),
                    Select({ key: 'gauge-model', label: '模型',
                        options: [{ value: '', label: '全部模型' }, ...modelOptions.map(model => ({ value: model, label: modelName(model) }))],
                        value: view.filters.model, onSelect: value => actions.filter('model', value) }),
                ], { gap: 'sm', flexWrap: 'wrap' }) : null,
                row([subtle(sessions.length + ' 段对话'), sessions.length ? control('export', '复制 CSV') : null],
                    { justifyContent: 'space-between' }),
                ...slice.map(item => column([
                    row([
                        column([control('session-' + item.id, item.title),
                            subtle(item.project + (item.updated ? ' · ' + date(item.updated * 1000) : ''))], { flexGrow: 1 }),
                        number(amount(item.filtered), { size: 'footnote', mono: true }),
                    ], { gap: 'md', justifyContent: 'space-between' }),
                    rule(),
                ])),
                row([
                    view.accountPage ? control('account-newer', '上一页') : null,
                    (view.accountPage + 1) * view.pageSize < sessions.length ? control('account-older', '下一页') : null,
                ], { gap: 'sm' }),
            ].filter(Boolean)),
        ];
    }

    function accountAnalysis() {
        const data = view.account;
        if (!data?.total.requests) return [hero('本机累计 · API 等价', null)];
        const daily = new Map(data.days.map(day => [day.day, day]));
        const days = Array.from({ length: 30 }, (_, index) => {
            const point = new Date();
            point.setDate(point.getDate() - 29 + index);
            const key = [point.getFullYear(), point.getMonth() + 1, point.getDate()].map(
                (part, i) => i ? String(part).padStart(2, '0') : part).join('-');
            return sum(daily.get(key)?.cost ?? []);
        });
        return [
            hero('本机累计 · API 等价', data.total),
            section('近 30 天 · 每日费用', [
                chart(days, '近 30 天 API 等价费用趋势'),
                ...data.days.slice(-7).reverse().map(day => row([
                    subtle(day.day.slice(5)), number(amount(day), { mono: true }),
                ], { justifyContent: 'space-between' })),
            ].filter(Boolean)),
            section('模型与速度', models(data.models)),
            section('费用构成', [breakdown(data)]),
            section('按项目', data.projects.map(project => row([
                text(project.project), number(amount(project), { mono: true }),
            ], { justifyContent: 'space-between', gap: 'md', paddingY: 'xs' }))),
        ];
    }

    function conversationView() {
        const all = view.conversation;
        const turns = all?.turns ?? [];
        const chosen = turns.find(turn => turn.id === view.selectedTurn) ?? turns.at(-1);
        if (view.conversationTab === 'total') return [
            hero('对话累计 · API 等价', all?.total, turns.length ? turns.length + ' 轮' : ''),
            breakdown(all?.total),
            all?.models?.length ? section('模型与速度', models(all.models)) : null,
            all?.unassigned ? subtle(all.unassigned + ' 次请求计入对话累计') : null,
        ];
        if (view.conversationTab === 'trend') return [
            hero('对话累计 · API 等价', all?.total, turns.length ? turns.length + ' 轮' : ''),
            turns.length ? section('最近 12 轮 · Tokens', [
                chart(turns.slice(-12).map(turn => sum(turn.tokens)), '各轮 Token 用量'),
                ...turns.slice(-12).reverse().map(turn => row([
                    subtle('第 ' + turn.number + ' 轮'),
                    subtle(totalText(turn), { tabular: true }),
                    number(amount(turn), { size: 'footnote', mono: true }),
                ], { justifyContent: 'space-between', gap: 'md' })),
            ].filter(Boolean)) : null,
        ];
        const entries = turns.slice().reverse().slice(view.page * view.pageSize, (view.page + 1) * view.pageSize);
        const group = chosen?.models?.length === 1 ? chosen.models[0] : null;
        const meta = group ? modelName(group.model) + ' · ' + (SPEED[group.speed] ?? group.speed) :
            chosen?.requests ? chosen.requests + ' 次请求' : '';
        return [
            hero(chosen ? '第 ' + chosen.number + ' 轮 · API 等价' : '本轮 · API 等价', chosen, meta),
            breakdown(chosen),
            chosen?.models?.length > 1 ? section('模型与速度', models(chosen.models)) : null,
            entries.length ? section('全部轮次 · ' + turns.length, [
                ...entries.map(turn => row([
                    control('turn-' + turn.id, '第 ' + turn.number + ' 轮', turn.id === chosen?.id),
                    number(amount(turn), { size: 'footnote', mono: true }),
                ], { justifyContent: 'space-between', gap: 'md' })),
                row([
                    view.page > 0 ? control('newer', '较新') : null,
                    (view.page + 1) * view.pageSize < turns.length ? control('older', '更早') : null,
                    view.selectedTurn && chosen !== turns.at(-1) ? control('latest', '最近一轮') : null,
                ], { gap: 'sm', flexWrap: 'wrap' }),
            ]) : null,
        ];
    }

    const accountTabs = [['overview', '概览'], ['details', '明细'], ['analysis', '分析']];
    const conversationTabs = [['turn', '轮次'], ['total', '累计'], ['trend', '趋势']];
    const subNav = view.tab === 'account' ? tabs(accountTabs, view.accountTab) : tabs(conversationTabs, view.conversationTab);
    const content = view.tab === 'conversation' ? conversationView() : {
        overview: accountOverview, details: accountDetails, analysis: accountAnalysis,
    }[view.accountTab]();
    return column([nav, rule(), subNav, ...content], { padding: compact ? 'md' : 'lg', gap: 'sm' });
}
