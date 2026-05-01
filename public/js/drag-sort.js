/**
 * makeSortable — single-container drag-to-reorder list.
 *
 * Renders `items` into `container` as draggable `.column-row` elements.
 * Each row: drag-handle + renderRow(item, i, items) HTML.
 * Calls onReorder(newItems) after a successful drop; caller owns persist + re-render.
 * Drag state is closure-local so multiple lists on the same page are independent.
 */
export function makeSortable(container, items, { renderRow, onReorder }) {
  let dragSrcIdx = null;

  container.innerHTML = items.map((item, i) => `
    <div class="column-row" draggable="true" data-sort-idx="${i}">
      <span class="drag-handle" aria-hidden="true">⠿</span>
      ${renderRow(item, i, items)}
    </div>`).join('');

  container.querySelectorAll('.column-row').forEach((row, i) => {
    row.addEventListener('dragstart', e => {
      dragSrcIdx = i;
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => row.classList.add('dragging'), 0);
    });

    row.addEventListener('dragend', () => {
      dragSrcIdx = null;
      row.classList.remove('dragging');
      container.querySelectorAll('.drop-above, .drop-below')
               .forEach(el => el.classList.remove('drop-above', 'drop-below'));
    });

    row.addEventListener('dragover', e => {
      e.preventDefault();
      container.querySelectorAll('.column-row').forEach(r => {
        if (r !== row) r.classList.remove('drop-above', 'drop-below');
      });
      const rect  = row.getBoundingClientRect();
      const above = e.clientY < rect.top + rect.height / 2;
      row.classList.toggle('drop-above', above);
      row.classList.toggle('drop-below', !above);
    });

    row.addEventListener('dragleave', e => {
      if (!row.contains(e.relatedTarget)) row.classList.remove('drop-above', 'drop-below');
    });

    row.addEventListener('drop', e => {
      e.preventDefault();
      if (dragSrcIdx === null || dragSrcIdx === i) {
        row.classList.remove('drop-above', 'drop-below');
        return;
      }
      const position  = row.classList.contains('drop-above') ? 'before' : 'after';
      row.classList.remove('drop-above', 'drop-below');

      const reordered  = [...items];
      const [moved]    = reordered.splice(dragSrcIdx, 1);
      const targetIdx  = dragSrcIdx < i ? i - 1 : i;
      reordered.splice(position === 'before' ? targetIdx : targetIdx + 1, 0, moved);

      onReorder(reordered);
    });
  });
}
