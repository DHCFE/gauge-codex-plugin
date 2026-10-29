export const $ = id => document.getElementById(id);
export const put = (id, text) => { $(id).textContent = text; };

// Preserve row identity, focus and scroll while refreshing telemetry.
export function reconcile(container, items, create, update) {
  const existing = new Map([...container.children].map(el => [el.dataset.id, el]));
  items.forEach((item, index) => {
    let el = existing.get(item.id);
    if (!el) { el = create(item); el.dataset.id = item.id; }
    update(el, item);
    existing.delete(item.id);
    if (container.children[index] !== el) container.insertBefore(el, container.children[index] || null);
  });
  for (const el of existing.values()) el.remove();
}
