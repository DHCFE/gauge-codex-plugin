import { pathToFileURL } from 'node:url';
import { buildFixture } from './ui-fixture.mjs';
import { data } from './ui-rework-fixture.mjs';

const assert = (value, message) => { if (!value) throw new Error(message); };
const { chromium } = await import(pathToFileURL(process.env.TOKENLENS_PLAYWRIGHT_MODULE).href);
const fixture = await buildFixture({ outputDir: 'output/playwright/shared-account', overrides: data });
const browser = await chromium.launch({ headless: true, executablePath: process.env.TOKENLENS_TEST_BROWSER });
try {
  for (const colorScheme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 480, height: 900 }, colorScheme, timezoneId: 'Asia/Shanghai' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(snapshot => { window.tokenlensSnapshot = snapshot; }, { savedAt: Date.now() - 60000, accountUsage: data.accountUsage, quota: data.quota });
    await page.goto(pathToFileURL(process.cwd() + '/' + fixture).href);
    assert((await page.locator('#windowCost').textContent()).includes('$112.35'), 'Snapshot rendered before activating account');
    assert(await page.locator('#accountRows tr').count() === 1, 'Snapshot table rendered on startup');
    await page.evaluate(() => {
      const original = window.TestApp.prototype.callServerTool;
      window.pendingReads = {};
      window.TestApp.prototype.callServerTool = async function(request) {
        if (['get_account_usage', 'get_account_quota'].includes(request.name)) {
          await new Promise(resolve => { window.pendingReads[request.name] = resolve; });
        }
        return original.call(this, request);
      };
    });
    await page.locator('#accountTab').click();
    assert((await page.locator('#windowCost').textContent()).includes('$112.35'), 'Slow reads do not erase cached metrics');
    assert(await page.locator('#accountRefresh').isDisabled(), 'Background update running');
    await page.evaluate(() => { window.fixture.accountUsage.summary.knownUsd = 25; window.pendingReads.get_account_usage(); });
    await page.locator('#accountCost').filter({ hasText: '$25.00' }).waitFor();
    assert(await page.locator('#accountRefresh').isDisabled(), 'Account updates before slower quota response finishes');
    assert(await page.locator('#weeklyUsed').textContent() === '35.0%', 'Previous quota retained independently');
    await page.evaluate(() => window.pendingReads.get_account_quota());
    await page.waitForFunction(() => !document.querySelector('#accountRefresh').disabled);
    const text = await page.locator('body').textContent();
    for (const phrase of ['正在补齐本地记录', '查看统计范围', '估算依据', 'Tokens 暂不可读', '模型与设备使用差异', '预算规则']) assert(!text.includes(phrase), 'Removed copy: ' + phrase);
    const small = await page.locator('#accountView').evaluate(root => [...root.querySelectorAll('*')].filter(el => el.getClientRects().length && [...el.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim()) && parseFloat(getComputedStyle(el).fontSize) < 13).map(el => el.id || el.className));
    assert(!small.length, 'No tiny account text: ' + small.join(','));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No page overflow');
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: `output/playwright/shared-account/account-${colorScheme}.png` });
    await page.evaluate(() => {
      window.pendingReads = {};
      window.testReceive({ _meta: { panelSnapshot: { savedAt: Date.now(), accountUsage: window.fixture.accountUsage, quota: window.fixture.quota } } });
    });
    await page.locator('#budgetTab').click();
    await page.waitForFunction(() => !document.querySelector('#budgetEnabled').disabled && window.pendingReads.get_account_quota);
    await page.locator('#budgetEnabled').check();
    await page.locator('#budgetMode').selectOption('percentage');
    await page.locator('#budgetValue').fill('10');
    assert(await page.locator('#budgetSave').isDisabled(), 'Cached capacity cannot authorize a percentage budget');
    await page.evaluate(() => window.pendingReads.get_account_quota());
    await page.waitForFunction(() => !document.querySelector('#budgetSave').disabled);
    await page.evaluate(() => window.pendingReads.get_account_usage());
    await page.waitForFunction(() => !document.querySelector('#accountRefresh').disabled);
    await page.locator('#budgetCancel').click();
    await page.locator('#accountTab').click();
    await page.evaluate(() => window.testReceive({ _meta: { panelSnapshot: null } }));
    assert(await page.locator('#accountRows tr').count() === 0, 'Invalidated login snapshot clears old rows');
    assert(await page.locator('#weeklyUsed').textContent() === '—', 'Invalidated login clears old quota');
    assert(await page.evaluate(() => window.sentMessages.length === 0 && !window.calls.some(call => ['get_budget_context', 'set_conversation_budget'].includes(call.name))), 'No model message/budget mutation');
    assert(!errors.length, errors.join('\n'));
    await page.close();
  }
  console.log('PASS: startup hydration, cached values during slow reads, independent account/quota completion, snapshot invalidation, cached quota cannot authorize percentage budget, removed copy, >=13px account text, light/dark, no model/budget calls.');
} finally { await browser.close(); }
