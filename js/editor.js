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

    this.container.addEventListener('beforeinput', (e) => {
      if (this.isComposing || this.isRenderingRemote) return;

      // Мобильные виртуальные клавиатуры (Android Gboard, iOS Safari) генерируют insertParagraph
      if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') {
        const now = Date.now();
        if (now - (this._lastKeydownEnter || 0) < 150) {
          // Уже обработано в keydown Enter, предотвращаем дублирование
          e.preventDefault();
          return;
        }
        this._lastBeforeInputEnter = now;
        e.preventDefault();
        this.handleEnterKey(e.inputType === 'insertLineBreak');
        return;
      }

      if (
        e.inputType === 'deleteContentBackward' ||
        e.inputType === 'deleteContentForward' ||
        e.inputType === 'deleteByCut'
      ) {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
          if (this.isAllSelected(sel)) {
            e.preventDefault();
            this.clearEntireDocument();
          }
        }
      }
    });

    this.container.addEventListener('cut', (e) => {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
        if (this.isAllSelected(sel)) {
          if (e.clipboardData) {
            e.clipboardData.setData('text/plain', this.container.innerText);
          }
          e.preventDefault();
          this.clearEntireDocument();
          return;
        }
      }
      setTimeout(() => {
        this.reconcileDOMWithCRDT();
      }, 0);
    });

    this.container.addEventListener('paste', () => {
      setTimeout(() => {
        this.reconcileDOMWithCRDT();
      }, 0);
    });

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
    this.reconcileDOMWithCRDT();
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

    // Ctrl+A — выделение всей заметки
    if (modKey && e.key.toLowerCase() === 'a') {
      return;
    }

    if (e.key === 'Enter') {
      const now = Date.now();
      if (now - (this._lastBeforeInputEnter || 0) < 150) {
        e.preventDefault();
        return;
      }
      this._lastKeydownEnter = now;
      e.preventDefault();
      this.handleEnterKey(e.shiftKey);
      return;
    }

    if (e.key === 'Backspace' || e.key === 'Delete') {
      this.handleDeleteKey(e);
      return;
    }
  }

  handleEnterKey(isShift = false) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;

    // 1. Если выделен диапазон текста, удаляем выделенное содержимое перед созданием новой строки
    if (!sel.isCollapsed) {
      const range = sel.getRangeAt(0);
      try {
        range.deleteContents();
      } catch (e) {}
    }

    const block = this.findEnclosingBlock(sel.anchorNode);

    // Если курсор не внутри конкретного блока (например, пустой контейнер)
    if (!block || !block.dataset.crdtId) {
      const newItem = this.crdtDoc.insertAfter(this.crdtDoc.head, '', 'text');
      const newId = newItem.id.toString();
      let p = this.container.querySelector(`[data-crdt-id="${newId}"]`);
      if (!p) {
        p = document.createElement('p');
        p.className = 'note-paragraph';
        p.dataset.crdtId = newId;
        p.innerHTML = '<br>';
        this.container.appendChild(p);
      }
      this.focusElement(p, false);
      return;
    }

    const crdtId = block.dataset.crdtId;
    const item = this.crdtDoc.items.get(crdtId);
    const currentType = item ? item.type : 'text';
    const isTask = block.classList.contains('note-task-row') || currentType === 'task';
    const target = isTask ? (block.querySelector('.note-task-text') || block) : block;
    const fullText = this.getBlockText(block);

    // СЛУЧАЙ А: Shift+Enter — мягкий перенос строки внутри текущего блока
    if (isShift) {
      try {
        document.execCommand('insertLineBreak');
      } catch (err) {
        const range = sel.getRangeAt(0);
        const br = document.createElement('br');
        range.insertNode(br);
        range.setStartAfter(br);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      const newText = this.getBlockText(block);
      this.crdtDoc.updateText(crdtId, newText);
      return;
    }

    // СЛУЧАЙ Б: Пустой пункт списка (чек-лист, маркированный или нумерованный список)
    // В Apple Notes нажатие Enter на пустом пункте завершает список и превращает его в обычный абзац!
    if (fullText.trim() === '' && (isTask || currentType === 'bullet' || currentType === 'number')) {
      this.crdtDoc.updateItemType(crdtId, 'text');
      const newEl = this.createDOMElementForOp({
        id: crdtId,
        content: '',
        itemType: 'text',
        checked: false,
      });
      block.replaceWith(newEl);
      this.focusElement(newEl, false);
      this.reconcileDOMWithCRDT();
      return;
    }

    // СЛУЧАЙ В: Определение типа следующего блока
    let nextType = 'text';
    if (isTask) {
      nextType = 'task'; // В чек-листе Enter создаёт следующий чек-бокс
    } else if (currentType === 'bullet') {
      nextType = 'bullet';
    } else if (currentType === 'number') {
      nextType = 'number';
    } else {
      // Для заголовков H1, H2 и обычного текста следующий блок — всегда обычный абзац
      nextType = 'text';
    }

    // СЛУЧАЙ Г: Вычисление смещения курсора и разделение строки на две
    const caretOffset = this.getCaretOffset(target);
    const beforeText = fullText.slice(0, caretOffset);
    const afterText = fullText.slice(caretOffset);

    // 1. Обновляем текущий блок (остаётся текст до курсора)
    this.crdtDoc.updateText(crdtId, beforeText);
    if (isTask) {
      target.textContent = beforeText;
      if (!beforeText) target.innerHTML = '<br>';
    } else {
      block.textContent = beforeText;
      if (!beforeText) block.innerHTML = '<br>';
    }

    // 2. Создаём новый блок в модели CRDT сразу после текущего
    const newItem = this.crdtDoc.insertAfter(crdtId, afterText, nextType, false);
    const newId = newItem.id.toString();

    // 3. Элемент DOM создаётся автоматически через слушатель CRDT (subscribeCRDT -> applyRemoteUpdateToDOM)
    let newEl = this.container.querySelector(`[data-crdt-id="${newId}"]`);
    if (!newEl) {
      newEl = this.createDOMElementForOp({
        id: newId,
        content: afterText,
        itemType: nextType,
        checked: false,
      });
      block.after(newEl);
    }

    // 4. Фокусируем курсор в начале нового блока
    this.focusElement(newEl, false);
  }

  getCaretOffset(element) {
    let caretOffset = 0;
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      try {
        if (element.contains(range.startContainer)) {
          const preCaretRange = range.cloneRange();
          preCaretRange.selectNodeContents(element);
          preCaretRange.setEnd(range.startContainer, range.startOffset);
          caretOffset = preCaretRange.toString().length;
        } else {
          caretOffset = this.getBlockText(element).length;
        }
      } catch (e) {
        caretOffset = this.getBlockText(element).length;
      }
    }
    return caretOffset;
  }

  handleDeleteKey(e) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;

    // СЛУЧАЙ 1: Пользователь выделил диапазон текста (Ctrl+A или несколько строк)
    if (!sel.isCollapsed) {
      const range = sel.getRangeAt(0);
      const allBlocks = this.getDOMBlocks();
      const selectedBlocks = allBlocks.filter((b) => range.intersectsNode(b));

      // Если выделен весь документ (Ctrl+A)
      if (allBlocks.length > 0 && (selectedBlocks.length === allBlocks.length || this.isAllSelected(sel))) {
        e.preventDefault();
        this.clearEntireDocument();
        return;
      }

      // Если выделение охватывает несколько блоков
      if (selectedBlocks.length > 1) {
        e.preventDefault();
        this.deleteSelectedBlocks(range, selectedBlocks);
        return;
      }

      // Выделение внутри одного блока: даём браузеру удалить выделенный текст,
      // а в handleInput reconcile обновит текст блока в CRDT!
      return;
    }

    // СЛУЧАЙ 2: Обычный Backspace курсором (caret) без выделения
    if (e.key === 'Backspace') {
      const block = this.findEnclosingBlock(sel.anchorNode);
      if (!block || !block.dataset.crdtId) {
        if (this.container.children.length === 0 || this.container.innerText.trim() === '') {
          e.preventDefault();
          this.clearEntireDocument();
        }
        return;
      }

      const text = this.getBlockText(block);
      // Если блок пуст — удаляем его из CRDT и DOM
      if (text === '') {
        e.preventDefault();
        const prevBlock = block.previousElementSibling;
        const itemId = block.dataset.crdtId;
        this.crdtDoc.deleteItem(itemId);
        block.remove();

        if (prevBlock) {
          this.focusElement(prevBlock, true);
        } else {
          this.container.focus();
        }
        this.reconcileDOMWithCRDT();
      }
    }
  }

  deleteSelectedBlocks(range, selectedBlocks) {
    if (!selectedBlocks || selectedBlocks.length === 0) return;

    const allBlocks = this.getDOMBlocks();
    if (selectedBlocks.length === allBlocks.length) {
      this.clearEntireDocument();
      return;
    }

    // Удаляем промежуточные блоки полностью
    const firstBlock = selectedBlocks[0];
    const lastBlock = selectedBlocks[selectedBlocks.length - 1];
    const intermediate = selectedBlocks.slice(1, -1);

    for (const block of intermediate) {
      if (block.dataset.crdtId) {
        this.crdtDoc.deleteItem(block.dataset.crdtId);
      }
      block.remove();
    }

    // Удаляем выделенный фрагмент через range.deleteContents()
    try {
      range.deleteContents();
    } catch (err) {
      console.warn('Range deleteContents warning:', err);
    }

    // Проверяем remaining firstBlock и lastBlock
    if (firstBlock && firstBlock.isConnected) {
      const remainingText = this.getBlockText(firstBlock);
      this.crdtDoc.updateText(firstBlock.dataset.crdtId, remainingText);
    }

    if (lastBlock && lastBlock.isConnected && lastBlock !== firstBlock) {
      const remainingText = this.getBlockText(lastBlock);
      if (remainingText === '') {
        this.crdtDoc.deleteItem(lastBlock.dataset.crdtId);
        lastBlock.remove();
      } else {
        this.crdtDoc.updateText(lastBlock.dataset.crdtId, remainingText);
      }
    }

    this.reconcileDOMWithCRDT();
  }

  clearEntireDocument() {
    // 1. Помечаем все видимые элементы CRDT как удалённые
    const visible = this.crdtDoc.getVisibleItems();
    for (const item of visible) {
      this.crdtDoc.deleteItem(item.id);
    }

    // 2. Очищаем DOM контейнера
    this.container.innerHTML = '';

    // 3. Устанавливаем фокус на контейнер
    this.container.focus();
  }

  reconcileDOMWithCRDT() {
    if (this.isRenderingRemote || this.isComposing) return;

    const visibleItems = this.crdtDoc.getVisibleItems();
    const crdtMap = new Map(visibleItems.map((item) => [item.id.toString(), item]));

    const domBlocks = this.getDOMBlocks();
    const domIds = new Set(domBlocks.map((b) => b.dataset.crdtId));

    // СЛУЧАЙ 1: В DOM нет блоков с data-crdt-id
    if (domBlocks.length === 0) {
      const text = this.container.innerText.trim();
      if (text.length === 0) {
        // Документ полностью пуст -> помечаем все оставшиеся элементы CRDT удалёнными
        for (const item of visibleItems) {
          this.crdtDoc.deleteItem(item.id);
        }
        return;
      } else {
        // Пользователь напечатал новый текст в пустом редакторе
        for (const item of visibleItems) {
          this.crdtDoc.deleteItem(item.id);
        }
        const cleanText = this.container.innerText.replace(/\n$/, '');
        const newItem = this.crdtDoc.insertAfter(this.crdtDoc.head, cleanText, 'text');

        const p = document.createElement('p');
        p.className = 'note-paragraph';
        p.dataset.crdtId = newItem.id.toString();
        p.textContent = cleanText;
        this.container.innerHTML = '';
        this.container.appendChild(p);
        this.focusElement(p, true);
        return;
      }
    }

    // СЛУЧАЙ 2: Некоторые элементы CRDT были удалены из DOM
    for (const item of visibleItems) {
      if (!domIds.has(item.id.toString())) {
        this.crdtDoc.deleteItem(item.id);
      }
    }

    // СЛУЧАЙ 3: Обновляем текст существующих блоков
    for (const block of domBlocks) {
      const crdtId = block.dataset.crdtId;
      const crdtItem = crdtMap.get(crdtId);
      if (crdtItem) {
        const currentText = this.getBlockText(block);
        if (currentText !== crdtItem.content) {
          this.crdtDoc.updateText(crdtId, currentText);
        }
      }
    }
  }

  getDOMBlocks() {
    return Array.from(this.container.querySelectorAll('[data-crdt-id]'));
  }

  getBlockText(block) {
    if (!block) return '';
    if (block.classList.contains('note-task-row')) {
      const textDiv = block.querySelector('.note-task-text');
      return textDiv ? textDiv.innerText.replace(/\n$/, '') : '';
    }
    return block.innerText.replace(/\n$/, '');
  }

  isAllSelected(sel) {
    if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
    const selText = sel.toString().trim();
    const docText = this.container.innerText.trim();
    if (docText.length > 0 && selText.length >= docText.length) {
      return true;
    }
    const range = sel.getRangeAt(0);
    const all = this.getDOMBlocks();
    if (all.length > 0) {
      const selected = all.filter((b) => range.intersectsNode(b));
      if (selected.length === all.length) {
        return true;
      }
    }
    if (range.startContainer === this.container && range.startOffset === 0) {
      if (range.endContainer === this.container && range.endOffset >= this.container.childNodes.length) {
        return true;
      }
    }
    return false;
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
    if (!el) {
      this.container.focus();
      return;
    }
    const target = el.querySelector('.note-task-text') || el;
    target.focus();

    try {
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
    } catch (e) {}
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
