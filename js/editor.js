/**
 * Редактор Apple Notes с точным позиционированием курсора и поддержкой text_update
 */

import { NodeID } from './crdt.js';

export class AppleNotesEditor {
  constructor(containerEl, crdtDoc, awareness) {
    this.container = containerEl;
    this.crdtDoc = crdtDoc;
    this.awareness = awareness;

    this.isComposing = false;
    this.isRenderingRemote = false;

    this.initDOM();
    this.bindEvents();
    this.subscribeCRDT();
  }

  initDOM() {
    this.container.classList.add('apple-notes-editor');
    this.container.setAttribute('contenteditable', 'true');
    this.container.setAttribute('spellcheck', 'true');
    this.container.setAttribute('role', 'textbox');
    this.container.setAttribute('aria-multiline', 'true');

    this.renderFromCRDT();
  }

  renderFromCRDT() {
    const saved = this.saveSelection();
    this.container.innerHTML = this.crdtDoc.toHTML();
    this.restoreSelection(saved);
  }

  subscribeCRDT() {
    this.crdtDoc.subscribe((origin, op) => {
      if (origin === 'snapshot') {
        this.renderFromCRDT();
      } else if (origin === 'remote') {
        this.applyRemoteUpdateToDOM(op);
      } else if (origin === 'local' && op) {
        if (op.type === 'insert') {
          const existing = this.container.querySelector(`[data-crdt-id="${op.id}"]`);
          if (!existing) {
            this.applyRemoteUpdateToDOM(op);
          }
        } else if (op.type === 'toggle_task') {
          const row = this.container.querySelector(`[data-crdt-id="${op.id}"]`);
          if (row) {
            const cb = row.querySelector('.apple-checkbox-input');
            if (cb && cb.checked !== !!op.checked) {
              cb.checked = !!op.checked;
            }
            if (op.checked) row.classList.add('checked');
            else row.classList.remove('checked');
          }
        }
      }
    });
  }

  applyRemoteUpdateToDOM(op) {
    if (!op) return;
    const saved = this.saveSelection();
    this.isRenderingRemote = true;

    try {
      if (op.type === 'text_update') {
        const block = this.container.querySelector(`[data-crdt-id="${op.id}"]`);
        if (block) {
          const target = block.querySelector('.note-task-text') || block;
          // Проверяем, редактирует ли сейчас локальный пользователь этот же узел
          const isFocused = document.activeElement === target || target.contains(document.activeElement);
          if (isFocused) {
            const currentOffset = saved ? saved.offset : 0;
            target.innerText = op.content || '';
            this.restoreSelection({ crdtId: op.id, offset: currentOffset });
          } else {
            target.innerText = op.content || '';
          }
        }
      } else if (op.type === 'insert') {
        const existing = this.container.querySelector(`[data-crdt-id="${op.id}"]`);
        if (existing) return;

        const el = this.createDOMElementForOp(op);
        let leftEl = null;

        if (op.leftId && op.leftId !== 'ROOT@0') {
          leftEl = this.container.querySelector(`[data-crdt-id="${op.leftId}"]`);
        }

        if (leftEl && leftEl.parentNode === this.container) {
          leftEl.after(el);
        } else {
          this.container.prepend(el);
        }
      } else if (op.type === 'delete') {
        const el = this.container.querySelector(`[data-crdt-id="${op.id}"]`);
        if (el) {
          el.remove();
        }
      } else if (op.type === 'toggle_task') {
        const row = this.container.querySelector(`[data-crdt-id="${op.id}"]`);
        if (row) {
          const cb = row.querySelector('.apple-checkbox-input');
          if (cb) cb.checked = !!op.checked;
          if (op.checked) row.classList.add('checked');
          else row.classList.remove('checked');
        }
      } else if (op.type === 'type_update') {
        const oldBlock = this.container.querySelector(`[data-crdt-id="${op.id}"]`);
        if (oldBlock) {
          const item = this.crdtDoc.items.get(op.id);
          if (item) {
            const newEl = this.createDOMElementForOp({
              id: op.id,
              content: item.content,
              itemType: op.itemType,
              checked: item.checked,
            });
            oldBlock.replaceWith(newEl);
          }
        }
      }
    } finally {
      this.isRenderingRemote = false;
      this.restoreSelection(saved);
    }
  }

  createDOMElementForOp(op) {
    const id = op.id;
    const content = escapeHTML(op.content || '');

    switch (op.itemType) {
      case 'h1': {
        const h1 = document.createElement('h1');
        h1.dataset.crdtId = id;
        h1.className = 'note-h1';
        h1.innerHTML = content || '<br>';
        return h1;
      }
      case 'h2': {
        const h2 = document.createElement('h2');
        h2.dataset.crdtId = id;
        h2.className = 'note-h2';
        h2.innerHTML = content || '<br>';
        return h2;
      }
      case 'task': {
        const row = document.createElement('div');
        row.dataset.crdtId = id;
        row.className = 'note-task-row' + (op.checked ? ' checked' : '');
        row.innerHTML = `
          <label class="apple-checkbox-container" contenteditable="false">
            <input type="checkbox" class="apple-checkbox-input" data-crdt-toggle="${id}" ${op.checked ? 'checked' : ''} />
            <span class="apple-checkbox-checkmark"></span>
          </label>
          <div class="note-task-text" contenteditable="true">${content || '<br>'}</div>
        `;
        return row;
      }
      case 'bullet': {
        const li = document.createElement('li');
        li.dataset.crdtId = id;
        li.className = 'note-bullet';
        li.innerHTML = content || '<br>';
        return li;
      }
      case 'number': {
        const li = document.createElement('li');
        li.dataset.crdtId = id;
        li.className = 'note-number';
        li.innerHTML = content || '<br>';
        return li;
      }
      case 'newline': {
        const p = document.createElement('p');
        p.dataset.crdtId = id;
        p.className = 'note-paragraph';
        p.innerHTML = '<br>';
        return p;
      }
      default: {
        const p = document.createElement('p');
        p.dataset.crdtId = id;
        p.className = 'note-paragraph';
        p.innerHTML = content || '<br>';
        return p;
      }
    }
  }

  bindEvents() {
    this.container.addEventListener('input', (e) => this.handleInput(e));
    this.container.addEventListener('keydown', (e) => this.handleKeyDown(e));

    this.container.addEventListener('change', (e) => {
      const toggleTarget = e.target.closest('[data-crdt-toggle]');
      if (toggleTarget) {
        const itemId = toggleTarget.dataset.crdtToggle;
        const checked = toggleTarget.checked;
        const row = toggleTarget.closest('.note-task-row');
        if (row) {
          if (checked) row.classList.add('checked');
          else row.classList.remove('checked');
        }
        this.crdtDoc.toggleTaskChecked(itemId, checked);
      }
    });

    document.addEventListener('selectionchange', () => {
      if (this.isRenderingRemote) return;
      this.throttleAwarenessCursor();
    });

    this.container.addEventListener('compositionstart', () => {
      this.isComposing = true;
    });
    this.container.addEventListener('compositionend', (e) => {
      this.isComposing = false;
      this.handleInput(e);
    });
  }

  handleInput(e) {
    if (this.isComposing || this.isRenderingRemote) return;

    const sel = window.getSelection();
    if (!sel || !sel.anchorNode) return;

    const block = this.findEnclosingBlock(sel.anchorNode);
    if (!block || !block.dataset.crdtId) return;

    const crdtId = block.dataset.crdtId;
    let newText = '';

    if (block.classList.contains('note-task-row')) {
      const textDiv = block.querySelector('.note-task-text');
      newText = textDiv ? textDiv.innerText.replace(/\n$/, '') : '';
    } else {
      newText = block.innerText.replace(/\n$/, '');
    }

    // Отправляем text_update в CRDT
    this.crdtDoc.updateText(crdtId, newText);
  }

  handleKeyDown(e) {
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const modKey = isMac ? e.metaKey : e.ctrlKey;

    if (modKey && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      document.execCommand('bold', false, null);
      return;
    }

    if (modKey && e.key.toLowerCase() === 'i') {
      e.preventDefault();
      document.execCommand('italic', false, null);
      return;
    }

    if (modKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) {
        document.execCommand('redo', false, null);
      } else {
        document.execCommand('undo', false, null);
      }
      return;
    }

    if (modKey && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      document.execCommand('redo', false, null);
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      this.handleEnterKey();
      return;
    }

    if (e.key === 'Backspace') {
      this.handleBackspaceKey(e);
    }
  }

  handleEnterKey() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;

    const block = this.findEnclosingBlock(sel.anchorNode);
    let leftId = null;
    let nextType = 'text';

    if (block && block.dataset.crdtId) {
      leftId = NodeID.fromString(block.dataset.crdtId);
      if (block.classList.contains('note-task-row')) {
        nextType = 'task';
      } else if (block.classList.contains('note-bullet')) {
        nextType = 'bullet';
      } else if (block.classList.contains('note-number')) {
        nextType = 'number';
      }
    } else {
      leftId = this.crdtDoc.head;
    }

    const newItem = this.crdtDoc.insertAfter(leftId, '', nextType, false);
    const newEl = this.createDOMElementForOp({
      id: newItem.id.toString(),
      content: '',
      itemType: nextType,
      checked: false,
    });

    if (block && block.parentNode === this.container) {
      block.after(newEl);
    } else {
      this.container.appendChild(newEl);
    }

    this.focusElement(newEl);
  }

  handleBackspaceKey(e) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;

    const block = this.findEnclosingBlock(sel.anchorNode);
    if (!block || !block.dataset.crdtId) return;

    const text = block.innerText.trim();
    if (text === '' && this.container.children.length > 1) {
      e.preventDefault();
      const prevBlock = block.previousElementSibling;
      const itemId = NodeID.fromString(block.dataset.crdtId);
      this.crdtDoc.deleteItem(itemId);
      block.remove();

      if (prevBlock) {
        this.focusElement(prevBlock, true);
      }
    }
  }

  formatCurrentBlock(type) {
    const sel = window.getSelection();
    if (!sel || !sel.anchorNode) return;

    const block = this.findEnclosingBlock(sel.anchorNode);
    if (!block || !block.dataset.crdtId) return;

    const crdtId = block.dataset.crdtId;
    this.crdtDoc.updateItemType(crdtId, type);

    const item = this.crdtDoc.items.get(crdtId);
    if (item) {
      const newEl = this.createDOMElementForOp({
        id: crdtId,
        content: item.content,
        itemType: type,
        checked: item.checked,
      });
      block.replaceWith(newEl);
      this.focusElement(newEl);
    }
  }

  findEnclosingBlock(node) {
    let curr = node;
    while (curr && curr !== this.container) {
      if (curr.nodeType === Node.ELEMENT_NODE && curr.dataset && curr.dataset.crdtId) {
        return curr;
      }
      curr = curr.parentNode;
    }
    return null;
  }

  focusElement(el, atEnd = false) {
    const target = el.querySelector('.note-task-text') || el;
    target.focus();

    const sel = window.getSelection();
    const range = document.createRange();

    if (atEnd && target.lastChild) {
      range.selectNodeContents(target);
      range.collapse(false);
    } else {
      range.selectNodeContents(target);
      range.collapse(true);
    }

    sel.removeAllRanges();
    sel.addRange(range);
  }

  saveSelection() {
    const sel = window.getSelection();
    if (!sel || !sel.anchorNode || !this.container.contains(sel.anchorNode)) {
      return null;
    }

    const block = this.findEnclosingBlock(sel.anchorNode);
    return {
      crdtId: block ? block.dataset.crdtId : null,
      offset: sel.anchorOffset,
    };
  }

  restoreSelection(saved) {
    if (!saved || !saved.crdtId) return;

    const block = this.container.querySelector(`[data-crdt-id="${saved.crdtId}"]`);
    if (!block) return;

    const target = block.querySelector('.note-task-text') || block;
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      const nodeToSelect = target.firstChild || target;
      const offset = Math.min(saved.offset, nodeToSelect.textContent ? nodeToSelect.textContent.length : 0);

      range.setStart(nodeToSelect, offset);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) {}
  }

  throttleAwarenessCursor() {
    clearTimeout(this._awarenessThrottle);
    this._awarenessThrottle = setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || !sel.anchorNode || !this.container.contains(sel.anchorNode)) return;

      const block = this.findEnclosingBlock(sel.anchorNode);
      if (block && block.dataset.crdtId) {
        this.awareness.setLocalCursor({
          nodeId: block.dataset.crdtId,
          offsetY: 8,
          offsetX: 16,
        });
      }
    }, 150);
  }
}

function escapeHTML(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
