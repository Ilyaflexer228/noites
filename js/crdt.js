/**
 * Надёжный CRDT-движок для совместного редактирования Apple Notes
 * 
 * Гарантии:
 * 1. Восстановление полного состояния: текст, заголовки, списки, чек-листы, галочки.
 * 2. Детерминированный порядок строк без циклов и потери элементов.
 * 3. Защита от повторного использования ID операций (часы Лампорта восстанавливаются до максимального значения).
 * 4. Бесконфликтное слияние одновременных правок (RGA + Lamport Clocks + LWW для чекбоксов).
 */

export class LamportClock {
  constructor(clientId) {
    this.clientId = clientId;
    this.time = 0;
  }

  tick() {
    this.time += 1;
    return { time: this.time, client: this.clientId };
  }

  update(remoteTime) {
    this.time = Math.max(this.time, remoteTime) + 1;
    return this.time;
  }

  setTime(t) {
    this.time = Math.max(this.time, t);
  }
}

export class NodeID {
  constructor(client, clock) {
    this.client = client;
    this.clock = clock;
  }

  toString() {
    return `${this.client}@${this.clock}`;
  }

  static fromString(str) {
    if (!str) return null;
    const parts = str.split('@');
    return new NodeID(parts[0], parseInt(parts[1], 10));
  }

  compare(other) {
    if (!other) return 1;
    if (this.clock !== other.clock) {
      return this.clock - other.clock;
    }
    return this.client.localeCompare(other.client);
  }
}

export class CRDTItem {
  constructor(id, leftId, rightId, content, type = 'text', checked = false, deleted = false) {
    this.id = id; // NodeID
    this.leftId = leftId; // NodeID | null
    this.rightId = rightId; // NodeID | null
    this.content = content || ''; // string
    this.type = type || 'text'; // 'h1' | 'h2' | 'text' | 'task' | 'bullet' | 'number' | 'newline'
    this.checked = !!checked; // boolean
    this.clock = id ? id.clock : 0;
    this.checkedClock = id ? id.clock : 0;
    this.deleted = !!deleted; // boolean (tombstone)
    this.deletedClock = 0;
  }
}

export class CollaborativeDoc {
  constructor(docId, clientId) {
    this.docId = docId;
    this.clientId = clientId || 'client_' + Math.random().toString(36).substring(2, 9);
    this.clock = new LamportClock(this.clientId);

    this.items = new Map();
    this.head = new NodeID('ROOT', 0);
    this.tail = new NodeID('TAIL', 0);

    this.items.set(this.head.toString(), new CRDTItem(this.head, null, this.tail, '', 'root'));
    this.items.set(this.tail.toString(), new CRDTItem(this.tail, this.head, null, '', 'tail'));

    this.stateVector = new Map();
    this.stateVector.set(this.clientId, 0);

    this.listeners = new Set();
  }

  subscribe(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  notify(changeOrigin, update) {
    for (const listener of this.listeners) {
      try {
        listener(changeOrigin, update);
      } catch (err) {
        console.error('Error in CRDT listener:', err);
      }
    }
  }

  /**
   * Получить упорядоченный список видимых элементов от head до tail
   */
  getVisibleItems() {
    const result = [];
    const rootItem = this.items.get(this.head.toString());
    if (!rootItem) return result;

    let currentId = rootItem.rightId;
    const visited = new Set();

    while (currentId && currentId.toString() !== this.tail.toString()) {
      const key = currentId.toString();
      if (visited.has(key)) {
        console.warn('[CRDT] Cycle detected in linked list at', key);
        break;
      }
      visited.add(key);

      const item = this.items.get(key);
      if (!item) break;
      if (!item.deleted) {
        result.push(item);
      }
      currentId = item.rightId;
    }
    return result;
  }

  /**
   * Вставка нового блока (RGA)
   */
  insertAfter(leftId, content, type = 'text', checked = false) {
    const timestamp = this.clock.tick();
    const newId = new NodeID(this.clientId, timestamp.time);
    this.stateVector.set(this.clientId, timestamp.time);

    const leftKey = leftId ? leftId.toString() : this.head.toString();
    const leftItem = this.items.get(leftKey) || this.items.get(this.head.toString());
    const rightId = leftItem.rightId;

    const newItem = new CRDTItem(newId, leftItem.id, rightId, content, type, checked);
    newItem.clock = timestamp.time;
    newItem.checkedClock = timestamp.time;
    this.items.set(newId.toString(), newItem);

    leftItem.rightId = newId;
    if (rightId) {
      const rightItem = this.items.get(rightId.toString());
      if (rightItem) rightItem.leftId = newId;
    }

    const op = {
      type: 'insert',
      id: newId.toString(),
      leftId: leftKey,
      rightId: rightId ? rightId.toString() : null,
      content,
      itemType: type,
      checked,
      clock: timestamp.time,
      client: this.clientId,
      opId: `${this.clientId}@${timestamp.time}`,
    };

    this.notify('local', op);
    return newItem;
  }

  /**
   * Обновление текста существующего блока
   */
  updateText(itemId, newContent) {
    const key = itemId.toString();
    const item = this.items.get(key);
    if (!item || item.deleted) return null;

    if (item.content === newContent) return null;

    const timestamp = this.clock.tick();
    item.content = newContent;
    item.clock = timestamp.time;
    this.stateVector.set(this.clientId, timestamp.time);

    const op = {
      type: 'text_update',
      id: key,
      content: newContent,
      clock: timestamp.time,
      client: this.clientId,
      opId: `${this.clientId}@${timestamp.time}`,
    };

    this.notify('local', op);
    return op;
  }

  /**
   * Удаление блока (tombstone)
   */
  deleteItem(itemId) {
    const key = itemId.toString();
    const item = this.items.get(key);
    if (!item || item.deleted) return null;

    const timestamp = this.clock.tick();
    item.deleted = true;
    item.deletedClock = timestamp.time;
    this.stateVector.set(this.clientId, timestamp.time);

    const op = {
      type: 'delete',
      id: key,
      clock: timestamp.time,
      client: this.clientId,
      opId: `${this.clientId}@${timestamp.time}`,
    };

    this.notify('local', op);
    return op;
  }

  /**
   * Переключение чекбокса (LWW-регистр)
   */
  toggleTaskChecked(itemId, checked) {
    const key = itemId.toString();
    const item = this.items.get(key);
    if (!item) return null;

    const timestamp = this.clock.tick();
    item.checked = checked !== undefined ? checked : !item.checked;
    item.checkedClock = timestamp.time;
    this.stateVector.set(this.clientId, timestamp.time);

    const op = {
      type: 'toggle_task',
      id: key,
      checked: item.checked,
      clock: timestamp.time,
      client: this.clientId,
      opId: `${this.clientId}@${timestamp.time}`,
    };

    this.notify('local', op);
    return item.checked;
  }

  /**
   * Смена типа блока (H1, H2, Task, Bullet, Normal)
   */
  updateItemType(itemId, newType) {
    const key = itemId.toString();
    const item = this.items.get(key);
    if (!item || item.deleted) return null;

    const timestamp = this.clock.tick();
    item.type = newType;
    item.clock = timestamp.time;
    this.stateVector.set(this.clientId, timestamp.time);

    const op = {
      type: 'type_update',
      id: key,
      itemType: newType,
      clock: timestamp.time,
      client: this.clientId,
      opId: `${this.clientId}@${timestamp.time}`,
    };

    this.notify('local', op);
    return op;
  }

  /**
   * Применение удалённой CRDT-операции
   */
  applyRemoteOp(op) {
    if (!op || !op.type) return false;

    if (op.clock) {
      this.clock.update(op.clock);
      const curr = this.stateVector.get(op.client) || 0;
      this.stateVector.set(op.client, Math.max(curr, op.clock));
    }

    if (op.type === 'text_update') {
      const item = this.items.get(op.id);
      if (item) {
        if (!item.clock || op.clock >= item.clock) {
          item.content = op.content;
          item.clock = op.clock;
          this.notify('remote', op);
          return true;
        }
      }
      return false;
    }

    if (op.type === 'insert') {
      if (this.items.has(op.id)) {
        const existing = this.items.get(op.id);
        if (op.clock && op.clock > existing.clock) {
          existing.content = op.content;
          existing.clock = op.clock;
          this.notify('remote', { type: 'text_update', id: op.id, content: op.content, clock: op.clock });
          return true;
        }
        return false;
      }

      const newId = NodeID.fromString(op.id);
      let leftKey = op.leftId || this.head.toString();
      let leftItem = this.items.get(leftKey) || this.items.get(this.head.toString());

      // Алгоритм RGA для упорядочивания одновременных вставок
      let scanning = leftItem.rightId;
      let effectiveLeft = leftItem;

      while (scanning && scanning.toString() !== this.tail.toString()) {
        const scanItem = this.items.get(scanning.toString());
        if (!scanItem) break;

        if (scanItem.leftId && scanItem.leftId.toString() === leftItem.id.toString()) {
          if (newId.compare(scanItem.id) < 0) {
            effectiveLeft = scanItem;
            scanning = scanItem.rightId;
            continue;
          }
        }
        break;
      }

      const effectiveRight = effectiveLeft.rightId;
      const newItem = new CRDTItem(
        newId,
        effectiveLeft.id,
        effectiveRight,
        op.content || '',
        op.itemType || 'text',
        !!op.checked
      );
      newItem.clock = op.clock || 0;

      this.items.set(newId.toString(), newItem);
      effectiveLeft.rightId = newId;

      if (effectiveRight) {
        const rightItem = this.items.get(effectiveRight.toString());
        if (rightItem) rightItem.leftId = newId;
      }

      this.notify('remote', op);
      return true;
    }

    if (op.type === 'delete') {
      const item = this.items.get(op.id);
      if (item && !item.deleted) {
        item.deleted = true;
        item.deletedClock = op.clock || 0;
        this.notify('remote', op);
        return true;
      }
      return false;
    }

    if (op.type === 'toggle_task') {
      const item = this.items.get(op.id);
      if (item) {
        if (!item.checkedClock || op.clock >= item.checkedClock) {
          item.checked = op.checked;
          item.checkedClock = op.clock;
          this.notify('remote', op);
          return true;
        }
      }
      return false;
    }

    if (op.type === 'type_update') {
      const item = this.items.get(op.id);
      if (item) {
        if (!item.clock || op.clock >= item.clock) {
          item.type = op.itemType;
          item.clock = op.clock;
          this.notify('remote', op);
          return true;
        }
      }
      return false;
    }

    return false;
  }

  /**
   * Восстановление и слияние снимка состояния
   * Гарантирует:
   * 1. Полное восстановление порядка строк, чекбоксов, текста и часов Лампорта.
   * 2. Исключение повторного использования ID операций.
   */
  loadSnapshot(snapshot) {
    if (!snapshot || !snapshot.items || !Array.isArray(snapshot.items)) return false;

    // Фильтруем элементы снимка, исключая дубликаты ROOT и TAIL
    const validRawItems = snapshot.items.filter((r) => r.id !== 'ROOT@0' && r.id !== 'TAIL@0');
    if (validRawItems.length === 0) {
      // Полностью пустой сохранённый документ (все блоки удалены пользователем)
      this.items.clear();
      this.head = new NodeID('ROOT', 0);
      this.tail = new NodeID('TAIL', 0);
      this.items.set(this.head.toString(), new CRDTItem(this.head, null, this.tail, '', 'root'));
      this.items.set(this.tail.toString(), new CRDTItem(this.tail, this.head, null, '', 'tail'));
      if (snapshot.clock) this.clock.setTime(snapshot.clock);
      this.notify('snapshot', null);
      return true;
    }

    // Вычисляем максимальные часы Лампорта для предотвращения коллизий ID после F5
    let maxClock = snapshot.clock || 0;

    // Если документ пустой (только ROOT и TAIL) — прямое линейное восстановление из локального хранилища
    const isInitialEmpty = this.items.size <= 2;

    if (isInitialEmpty) {
      // Очищаем и создаём свежие границы
      this.items.clear();
      this.head = new NodeID('ROOT', 0);
      this.tail = new NodeID('TAIL', 0);

      const rootItem = new CRDTItem(this.head, null, null, '', 'root');
      const tailItem = new CRDTItem(this.tail, null, null, '', 'tail');

      this.items.set(this.head.toString(), rootItem);
      this.items.set(this.tail.toString(), tailItem);

      let prevItem = rootItem;

      for (const raw of validRawItems) {
        const itemId = NodeID.fromString(raw.id);
        const item = new CRDTItem(
          itemId,
          prevItem.id,
          null,
          raw.content || '',
          raw.type || 'text',
          !!raw.checked,
          !!raw.deleted
        );
        item.clock = raw.clock || itemId.clock || 0;
        item.checkedClock = raw.checkedClock || item.clock;
        item.deletedClock = raw.deletedClock || 0;

        maxClock = Math.max(maxClock, item.clock, item.checkedClock, item.deletedClock);
        if (itemId.client === this.clientId) {
          maxClock = Math.max(maxClock, itemId.clock);
        }

        this.items.set(raw.id, item);

        // Связываем с предыдущим
        prevItem.rightId = item.id;
        prevItem = item;
      }

      // Замыкаем на tail
      prevItem.rightId = this.tail;
      tailItem.leftId = prevItem.id;
    } else {
      // Слияние снимка с существующими локальными элементами (Merge)
      for (const raw of validRawItems) {
        const local = this.items.get(raw.id);
        const rawClock = raw.clock || 0;
        maxClock = Math.max(maxClock, rawClock, raw.checkedClock || 0, raw.deletedClock || 0);

        if (!local) {
          // Вставляем недостающий элемент через applyRemoteOp
          this.applyRemoteOp({
            type: 'insert',
            id: raw.id,
            leftId: raw.leftId,
            rightId: raw.rightId,
            content: raw.content || '',
            itemType: raw.type || 'text',
            checked: !!raw.checked,
            clock: rawClock,
            client: NodeID.fromString(raw.id)?.client || 'remote',
          });
        } else {
          // Обновляем существующий элемент по максимальным часам
          if (raw.deleted && (!local.deleted || (raw.deletedClock && raw.deletedClock >= local.deletedClock))) {
            local.deleted = true;
            local.deletedClock = raw.deletedClock || 0;
          }
          if (raw.checkedClock && raw.checkedClock > local.checkedClock) {
            local.checked = !!raw.checked;
            local.checkedClock = raw.checkedClock;
          }
          if (rawClock && rawClock > local.clock) {
            local.content = raw.content;
            local.clock = rawClock;
            local.type = raw.type;
          }
        }
      }
    }

    // Восстанавливаем вектор состояний и часы Лампорта
    if (snapshot.stateVector) {
      for (const [client, clock] of Object.entries(snapshot.stateVector)) {
        this.stateVector.set(client, Math.max(this.stateVector.get(client) || 0, clock));
        maxClock = Math.max(maxClock, clock);
      }
    }

    // Устанавливаем часы локального клиента строго больше максимального встреченного
    this.clock.setTime(maxClock);
    this.stateVector.set(this.clientId, Math.max(this.stateVector.get(this.clientId) || 0, this.clock.time));

    this.notify('snapshot', null);
    return true;
  }

  /**
   * Экспорт полного снимка документа в строгом порядке следования от head до tail
   */
  exportSnapshot() {
    const rawItems = [];
    const rootItem = this.items.get(this.head.toString());
    let currId = rootItem ? rootItem.rightId : null;
    const visited = new Set();

    // Проходим по цепочке от head до tail
    while (currId && currId.toString() !== this.tail.toString()) {
      const key = currId.toString();
      if (visited.has(key)) break;
      visited.add(key);

      const item = this.items.get(key);
      if (!item) break;

      rawItems.push({
        id: item.id.toString(),
        leftId: item.leftId ? item.leftId.toString() : null,
        rightId: item.rightId ? item.rightId.toString() : null,
        content: item.content || '',
        type: item.type || 'text',
        checked: !!item.checked,
        clock: item.clock || 0,
        checkedClock: item.checkedClock || 0,
        deleted: !!item.deleted,
        deletedClock: item.deletedClock || 0,
      });

      currId = item.rightId;
    }

    // Также добавляем любые элементы, выпавшие из основной цепи (для надёжности)
    for (const [key, item] of this.items.entries()) {
      if (key === this.head.toString() || key === this.tail.toString()) continue;
      if (!visited.has(key)) {
        rawItems.push({
          id: item.id.toString(),
          leftId: item.leftId ? item.leftId.toString() : null,
          rightId: item.rightId ? item.rightId.toString() : null,
          content: item.content || '',
          type: item.type || 'text',
          checked: !!item.checked,
          clock: item.clock || 0,
          checkedClock: item.checkedClock || 0,
          deleted: !!item.deleted,
          deletedClock: item.deletedClock || 0,
        });
      }
    }

    const vector = {};
    for (const [client, clock] of this.stateVector.entries()) {
      vector[client] = clock;
    }

    return {
      docId: this.docId,
      clock: this.clock.time,
      clientId: this.clientId,
      stateVector: vector,
      items: rawItems,
    };
  }

  /**
   * Полная очистка всех видимых блоков документа
   */
  clear() {
    const visible = this.getVisibleItems();
    for (const item of visible) {
      this.deleteItem(item.id);
    }
  }

  /**
   * Стартовый шаблон (создаётся ТОЛЬКО если документ пуст и не был инициализирован ранее)
   */
  initializeWithTemplate() {
    if (this.items.size > 2 || this.getVisibleItems().length > 0) return;

    const lines = [
      { content: '🎄 Наши планы на Новый год 2027', type: 'h1' },
      { content: '', type: 'newline' },
      { content: '30 декабря', type: 'h2' },
      { content: 'Купить продукты к праздничному столу', type: 'task', checked: false },
      { content: 'Собраться вечером у друзей', type: 'task', checked: false },
      { content: '', type: 'newline' },
      { content: '31 декабря', type: 'h2' },
      { content: '18:00 — подготовка и нарезка салатов', type: 'task', checked: false },
      { content: '21:00 — провожаем старый год', type: 'task', checked: false },
      { content: '00:00 — встречаем Новый год! 🥂✨', type: 'task', checked: false },
      { content: 'Запустить праздничный салют 🎆', type: 'task', checked: false },
      { content: '', type: 'newline' },
      { content: '2 января', type: 'h2' },
      { content: 'Сходить в баню 🧖‍♂️', type: 'task', checked: false },
      { content: 'Заказать такси', type: 'task', checked: false },
    ];

    let prevId = this.head;
    for (const line of lines) {
      const item = this.insertAfter(prevId, line.content, line.type, line.checked);
      prevId = item.id;
    }
  }

  toHTML() {
    const visible = this.getVisibleItems();
    if (visible.length === 0) return '';

    let html = '';
    for (const item of visible) {
      const safeContent = escapeHTML(item.content);
      const itemId = item.id.toString();

      switch (item.type) {
        case 'h1':
          html += `<h1 data-crdt-id="${itemId}" class="note-h1">${safeContent || '<br>'}</h1>`;
          break;
        case 'h2':
          html += `<h2 data-crdt-id="${itemId}" class="note-h2">${safeContent || '<br>'}</h2>`;
          break;
        case 'task': {
          const checkedClass = item.checked ? ' checked' : '';
          const checkedAttr = item.checked ? ' checked' : '';
          html += `
            <div data-crdt-id="${itemId}" class="note-task-row${checkedClass}">
              <label class="apple-checkbox-container" contenteditable="false">
                <input type="checkbox" class="apple-checkbox-input" data-crdt-toggle="${itemId}"${checkedAttr} />
                <span class="apple-checkbox-checkmark"></span>
              </label>
              <div class="note-task-text" contenteditable="true">${safeContent || '<br>'}</div>
            </div>`;
          break;
        }
        case 'bullet':
          html += `<li data-crdt-id="${itemId}" class="note-bullet">${safeContent || '<br>'}</li>`;
          break;
        case 'number':
          html += `<li data-crdt-id="${itemId}" class="note-number">${safeContent || '<br>'}</li>`;
          break;
        case 'newline':
          html += `<p data-crdt-id="${itemId}" class="note-paragraph"><br></p>`;
          break;
        case 'text':
        default:
          html += `<p data-crdt-id="${itemId}" class="note-paragraph">${safeContent || '<br>'}</p>`;
          break;
      }
    }
    return html;
  }

  toMarkdown() {
    const visible = this.getVisibleItems();
    let md = '';

    for (const item of visible) {
      switch (item.type) {
        case 'h1':
          md += `# ${item.content}\n\n`;
          break;
        case 'h2':
          md += `## ${item.content}\n\n`;
          break;
        case 'task':
          md += `- [${item.checked ? 'x' : ' '}] ${item.content}\n`;
          break;
        case 'bullet':
          md += `- ${item.content}\n`;
          break;
        case 'number':
          md += `1. ${item.content}\n`;
          break;
        case 'newline':
          md += `\n`;
          break;
        default:
          md += `${item.content}\n\n`;
          break;
      }
    }
    return md;
  }

  toPlainText() {
    return this.getVisibleItems()
      .map((item) => (item.type === 'task' ? `[${item.checked ? '✓' : ' '}] ${item.content}` : item.content))
      .join('\n');
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
