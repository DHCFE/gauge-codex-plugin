import { drawPanel, filteredSessions, sessionsCsv, weeklyWindow } from './panel.js';

const PANE = 'gauge-claude-usage';
const PAGE_SIZE = 8;
const view = {
    tab: 'conversation',
    conversationTab: 'turn',
    accountTab: 'overview',
    selectedTurn: null,
    accountSelection: null,
    filters: { range: 'all', model: '', query: '' },
    page: 0,
    accountPage: 0,
    pageSize: PAGE_SIZE,
    conversation: null,
    account: null,
    rates: [],
    error: '',
};

let sessionId;
let timer;
let pending;
let signature = '';
let visible = false;
let dismissedSession;
let lastScan = 0;
let lastAccount = 0;

function normalizeRates(windows) {
    return ['five_hour', 'seven_day'].map(kind => (windows ?? []).find(
        window => window.kind === kind && Number.isFinite(window.percentUsed)
    ));
}

async function readReport($, scope, id, range) {
    const command = [
        '/usr/bin/python3', '-I', '-B', $.plugin.root + '/hooks/usage.py', scope, id,
        view.conversation?.path ?? '', ...range.map(String),
    ];
    const result = await $.process.run(command, { cwd: $.plugin.root, timeoutMs: 8000 });
    if (result.exitCode !== 0) throw new Error('usage reader failed');
    return JSON.parse(result.stdout);
}

async function update($, force) {
    if (!visible) return;
    if (pending) return pending;
    pending = (async () => {
        const id = await $.session.id();
        const changedSession = id !== sessionId;
        if (changedSession) {
            sessionId = id;
            view.selectedTurn = null;
            view.conversation = null;
            signature = '';
            lastScan = 0;
            view.page = 0;
        }

        const now = Date.now();
        const official = await $.session.usage().catch(() => null);
        const rates = normalizeRates(official?.rateLimits);
        const ratesChanged = JSON.stringify(rates) !== JSON.stringify(view.rates);
        view.rates = rates;
        const range = weeklyWindow(view.rates[1], now);

        const stat = view.tab === 'conversation' && view.conversation?.path
            ? await $.fs.stat(view.conversation.path).catch(() => null)
            : null;
        const key = stat ? stat.size + ':' + stat.mtimeMs : '';
        const readCurrent = view.tab === 'conversation' &&
            (force || key !== signature || now - lastScan >= 6000);
        const readAccount = view.tab === 'account' &&
            (force || (view.account && view.account.weekEnd !== range[1]) || now - lastAccount >= 15000);

        if (readCurrent || readAccount) {
            try {
                if (readCurrent) {
                    view.conversation = await readReport($, 'session', id, range);
                    signature = key;
                    lastScan = now;
                }
                if (readAccount) {
                    view.account = await readReport($, 'account', id, range);
                    lastAccount = now;
                }
                view.error = '';
            } catch {
                if (readCurrent) lastScan = now;
                if (readAccount) lastAccount = now;
                view.error = '本机日志暂时无法读取';
            }
        }
        if (visible && (ratesChanged || readCurrent || readAccount || force || changedSession)) {
            $.ui.invalidate('ui.render');
        }
    })().finally(() => { pending = null; });
    return pending;
}

function refresh($, force = false) {
    void update($, force).catch(() => {});
}

function stop() {
    visible = false;
    timer?.cancel();
    timer = null;
}

function startRefresh($) {
    if (!visible || timer) return;
    refresh($, true);
    timer = $.clock.every(1100, () => refresh($));
}

async function openPane($) {
    if (visible) {
        refresh($, true);
        return;
    }
    visible = true;
    try {
        await $.ui.open({ id: PANE, title: 'Gauge', columns: 46 });
        startRefresh($);
        $.ui.invalidate('ui.render');
    } catch (error) {
        stop();
        throw error;
    }
}

async function activatePane($) {
    dismissedSession = undefined;
    const id = await $.session.id();
    await $.store.delete('closed:' + id);
    await $.store.set('open-in-desktop', true);
    await openPane($);
}

async function restorePane($) {
    try {
        const id = await $.session.id();
        if (dismissedSession === id || await $.store.get('closed:' + id) === true) return;
        if (await $.store.get('open-in-desktop') === true && dismissedSession !== id) await openPane($);
    } catch {
        // A surface may detach before the pane opens. The next attach retries.
    }
}

async function launch($) {
    try {
        await activatePane($);
    } catch {
        if (!visible) $.ui.toast('Gauge 暂时无法打开');
    }
}

function filter($, field, value) {
    view.filters[field] = value;
    view.accountPage = 0;
    view.accountSelection = null;
    $.ui.invalidate('ui.render');
}

async function copyCsv($) {
    const rows = filteredSessions(view.account, view.filters);
    if (!rows.length) return;
    try {
        const result = await $.ui.copy({ text: sessionsCsv(rows) });
        if (result.isCopied) $.ui.toast('已复制当前筛选的 CSV');
    } catch {
        $.ui.toast('CSV 暂时无法复制');
    }
}

function select($, key) {
    if (key === 'conversation' || key === 'account') {
        view.tab = key;
        refresh($, true);
    } else if (['turn', 'total', 'trend'].includes(key)) {
        view.conversationTab = key;
    } else if (['overview', 'details', 'analysis'].includes(key)) {
        view.accountTab = key;
        view.accountSelection = null;
    } else if (key === 'latest') {
        view.selectedTurn = null;
        view.page = 0;
    } else if (key === 'older') {
        view.page += 1;
    } else if (key === 'newer') {
        view.page = Math.max(0, view.page - 1);
    } else if (key.startsWith('turn-')) {
        view.selectedTurn = key.slice('turn-'.length);
    } else if (key.startsWith('session-')) {
        view.accountSelection = key.slice('session-'.length);
    } else if (key === 'back-to-sessions') {
        view.accountSelection = null;
    } else if (key === 'account-newer') {
        view.accountPage = Math.max(0, view.accountPage - 1);
    } else if (key === 'account-older') {
        view.accountPage += 1;
    } else if (key === 'export') {
        void copyCsv($);
    }
    $.ui.invalidate('ui.render');
}

export function register(on) {
    on('session.start', async ($, event, next) => {
        await $.command.register({
            name: 'gauge',
            description: '打开 Gauge 用量面板',
            argumentHint: '[account|off]',
        });
        const result = await next(event);
        if (event.surface === 'desktop') $.clock.after(250, () => { void restorePane($); });
        return result;
    });

    on('session.attach', { surface: 'desktop' }, async ($, event, next) => {
        const result = await next(event);
        $.clock.after(250, () => { void restorePane($); });
        return result;
    });

    on('session.end', ($, event, next) => {
        stop();
        return next(event);
    });

    on('command.run', { command: 'gauge' }, async ($, event) => {
        const option = (event.args ?? '').trim();
        if (option === 'off') {
            await $.store.set('open-in-desktop', false);
            await $.ui.close({ id: PANE });
            stop();
            return {};
        }
        view.tab = ['account', 'history'].includes(option) ? 'account' : 'conversation';
        view.accountTab = option === 'history' ? 'analysis' : 'overview';
        view.conversationTab = 'turn';
        view.selectedTurn = null;
        view.page = 0;
        try {
            await activatePane($);
            return {};
        } catch {
            return { text: 'Gauge 面板暂时无法打开' };
        }
    });

    on('ui.close', async ($, event, next) => {
        if (event.id !== PANE) return next(event);
        const result = await next(event);
        stop();
        $.ui.invalidate('ui.render');
        if (event.origin.kind === 'person') {
            try {
                dismissedSession = await $.session.id();
                await $.store.set('closed:' + dismissedSession, true);
            } catch {
                // The current close is already applied by Claude.
            }
        }
        return result;
    });

    on('turn.complete', ($, event, next) => {
        if (visible) $.clock.after(350, () => refresh($, true));
        return next(event);
    });

    on('session.measure', ($, event, next) => {
        view.rates = normalizeRates(event.rateLimits);
        if (visible) $.ui.invalidate('ui.render');
        return next(event);
    });

    on('ui.render', { component: 'AbovePrompt' }, async ($, event, next) => {
        const existing = await next(event);
        if (event.surface !== 'desktop' || visible || event.props.hasSurvey) return existing;
        const { Box, Button } = $.ui.resolve(event);
        const launcher = Box({
            flexDirection: 'row',
            justifyContent: 'flex-end',
            paddingX: 'sm',
            children: [Button({
                key: 'gauge-launcher',
                label: '打开 Gauge',
                variant: 'secondary',
                onPress: () => { void launch($); },
            })],
        });
        return existing ? Box({ flexDirection: 'column', children: [existing, launcher] }) : launcher;
    });

    on('ui.render', { component: 'Pane' }, ($, event, next) => {
        if (event.requestId !== PANE) return next(event);
        // Reloading a local plugin can keep its pane mounted while replacing
        // the module. Adopt that pane without making the user reopen it.
        if (!visible) {
            visible = true;
            $.clock.after(1, () => startRefresh($));
        }
        return drawPanel($.ui.resolve(event), { ...view, width: event.props.bodyColumns ?? 46 }, {
            select: key => select($, key),
            search: value => filter($, 'query', value),
            filter: (field, value) => filter($, field, value),
        });
    });
}
