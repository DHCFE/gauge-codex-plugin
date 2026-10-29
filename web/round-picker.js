import { reconcile } from './dom.js';

// A small, keyboard-accessible listbox. Refreshing records preserves open-list focus.
export function createRoundPicker({ trigger, list, onSelect }) {
  const root = trigger.parentElement;
  let selectedId, search = '', searchAt = 0;
  const options = () => [...list.children];
  const focused = () => options().indexOf(document.activeElement);
  const focusAt = index => {
    const option = options()[index];
    option?.focus({ preventScroll: true });
    option?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };
  function close(restoreFocus = false) {
    list.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus && !trigger.disabled) trigger.focus({ preventScroll: true });
  }
  function open(index = options().findIndex(option => option.dataset.id === selectedId)) {
    if (trigger.disabled || !list.children.length) return;
    list.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    search = '';
    focusAt(Math.max(0, index));
  }
  function choose(id) {
    close(true);
    onSelect(id);
  }
  trigger.onclick = () => list.hidden ? open() : close(true);
  trigger.onkeydown = event => {
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      open(event.key === 'Home' ? 0 : event.key === 'End' ? options().length - 1 : undefined);
    } else if (event.key === 'Escape') close(true);
  };
  list.onkeydown = event => {
    const index = focused(), last = options().length - 1;
    let next;
    if (event.key === 'ArrowDown') next = Math.min(last, index + 1);
    else if (event.key === 'ArrowUp') next = Math.max(0, index - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const option = options()[index];
      if (option) choose(option.dataset.id);
      return;
    } else if (event.key === 'Escape') { event.preventDefault(); close(true); return; }
    else if (event.key === 'Tab') { close(); return; }
    else if (/^[0-9]$/.test(event.key)) {
      search = Date.now() - searchAt > 750 ? event.key : search + event.key;
      searchAt = Date.now();
      next = options().findIndex(option => option.dataset.number.startsWith(search));
      if (next < 0) return;
    } else return;
    event.preventDefault();
    focusAt(next);
  };
  document.addEventListener('pointerdown', event => { if (!root.contains(event.target)) close(); });
  root.addEventListener('focusout', event => { if (!root.contains(event.relatedTarget)) close(); });

  return {
    close,
    clear() {
      close();
      selectedId = undefined;
      list.replaceChildren();
      trigger.disabled = true;
      trigger.dataset.value = '';
      trigger.querySelector('.round-label').textContent = '选择轮次';
    },
    update(turns, selected, currentId, disabled) {
      selectedId = selected;
      trigger.disabled = disabled;
      trigger.dataset.value = selected || '';
      const current = turns.find(turn => turn.id === selected);
      trigger.querySelector('.round-label').textContent = current ? current.title + (selected === currentId ? ' · 本轮' : '') : '选择轮次';
      reconcile(list, turns, () => {
        const option = document.createElement('div');
        option.className = 'round-option';
        option.setAttribute('role', 'option');
        option.tabIndex = -1;
        option.innerHTML = '<span></span><small></small><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4 10-10"/></svg>';
        option.onclick = () => choose(option.dataset.id);
        return option;
      }, (option, turn) => {
        option.setAttribute('aria-selected', String(turn.id === selected));
        option.dataset.number = String(turns.indexOf(turn) + 1);
        option.children[0].textContent = turn.title;
        option.children[1].textContent = turn.id === currentId ? '本轮' : '';
      });
      if (disabled) close();
    }
  };
}
