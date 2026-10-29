export default async function check(page) {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const trigger = page.locator('#roundSelect'), list = page.locator('#roundOptions');
  await page.setViewportSize({ width: 480, height: 900 });
  await trigger.click();
  assert(await list.isVisible(), 'Picker opens');
  assert(await list.locator('[role=option]').count() === 63, 'All historical rounds accessible');
  assert(await page.evaluate(() => document.activeElement.dataset.id) === 't63', 'Open focuses selection');
  assert(await list.locator('[aria-selected=true]').getAttribute('data-id') === 't63', 'Selection announced');
  await page.keyboard.press('Home');
  assert(await page.evaluate(() => document.activeElement.dataset.id) === 't1', 'Home reaches first round');
  await page.keyboard.press('ArrowDown');
  assert(await page.evaluate(() => document.activeElement.dataset.id) === 't2', 'Arrow moves focus');
  await page.keyboard.press('End');
  assert(await page.evaluate(() => document.activeElement.dataset.id) === 't63', 'End reaches final round');
  await page.keyboard.press('8');
  await page.keyboard.press('Enter');
  assert(await trigger.getAttribute('data-value') === 't8', 'Number search and Enter select round');
  assert((await page.locator('#breakdown').textContent()).includes('8,000 tokens'), 'Selection updates actual breakdown');
  assert(!await list.isVisible(), 'Selection dismisses list');
  assert(await trigger.evaluate(el => el === document.activeElement), 'Selection restores trigger focus');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await page.evaluate(() => {
    window.pickerFocused = document.activeElement;
    window.pickerScroll = document.querySelector('#roundOptions').scrollTop;
    window.testReceive({ _meta: { usage: { ...window.testUsage, observedAt: Date.now() } } });
  });
  assert(await list.isVisible(), 'Refresh keeps picker open');
  assert(await page.evaluate(() => window.pickerFocused === document.activeElement), 'Refresh preserves option focus');
  assert(await page.evaluate(() => window.pickerScroll === document.querySelector('#roundOptions').scrollTop), 'Refresh preserves list scroll');
  await page.keyboard.press('Escape');
  assert(await trigger.getAttribute('data-value') === 't8', 'Escape cancels without changing selection');
  assert(!await list.isVisible(), 'Escape dismisses');
  await trigger.click();
  await page.keyboard.press('Tab');
  assert(!await list.isVisible(), 'Tab dismisses without trapping focus');
  await trigger.click();
  await page.locator('#accountTab').click();
  assert(!await list.isVisible(), 'Outside click dismisses');
  await page.locator('#conversationTab').click();
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 390, height: 844 });
    await trigger.click();
    const bounds = await list.boundingBox();
    assert(bounds.x >= 0 && bounds.x + bounds.width <= 390 && bounds.height <= 282, 'List stays inside narrow viewport');
    const neutral = await list.locator('[aria-selected=true]').evaluate(el => {
      const values = getComputedStyle(el).backgroundColor.match(/\d+/g).slice(0, 3);
      return values.every(value => value === values[0]);
    });
    assert(neutral, 'No blue selected state');
    await page.screenshot({ path: `output/playwright/round-picker-${colorScheme}.png` });
    await page.keyboard.press('Escape');
  }
  await page.evaluate(() => window.testReceive({ _meta: { usage: { ...window.testUsage, usageStatus: 'waiting', turns: [] } } }));
  assert(await trigger.isDisabled() && !await list.isVisible(), 'New chat clears and disables picker');
  assert(await list.locator('[role=option]').count() === 0, 'No previous-chat options remain');
  await page.evaluate(() => window.testReceive({ _meta: { usage: window.testUsage } }));
  assert(await page.evaluate(() => !window.calls.some(call => ['set_conversation_budget', 'get_budget_context'].includes(call.name)) && window.sentMessages.length === 0), 'Picker makes no model or budget calls');
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  return 'PASS: custom picker mouse/keyboard/numeric search, cancel/Tab/outside close, 63 rounds, stable refresh focus/scroll, new-chat clearing, narrow neutral light/dark.';
}
