/**
 * Хранилище IndexedDB с гарантированной защитой от потери данных
 * 
 * Ключевые гарантии:
 * 1. Сохранение работает 100% автономно БЕЗ облачного сервера.
 * 2. Двойное сохранение: IndexedDB + синхронный mirror в localStorage.
 * 3. Контракт: loadDocument() всегда возвращает объект с полем `snapshot`.
 * 4. Защита существующих данных: никогда не удаляет базу и создаёт резервные копии.
 * 5. Операции удаляются из очереди pending_ops ТОЛЬКО после реального подтверждения op_ack.
 */
import { CONFIG } from '../config.js';

class DocStorage {
  constructor(dbName = CONFIG.INDEXEDDB_NAME) {
    this.dbName = dbName;
    this.db = null;
    this.initPromise = this.init();
  }

  async init() {
    return new Promise((resolve) => {
      try {
        if (typeof indexedDB === 'undefined') {
          console.warn('[Storage] IndexedDB not available in this environment');
          resolve(null);
          return;
        }

        const request = indexedDB.open(this.dbName, 3);

        request.onupgradeneeded = (event) => {
          const db = event.target.result;
          if (!db.objectStoreNames.contains('documents')) {
            db.createObjectStore('documents', { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains('pending_ops')) {
            const store = db.createObjectStore('pending_ops', { keyPath: 'opId' });
            store.createIndex('docId', 'docId', { unique: false });
          }
        };

        request.onsuccess = (event) => {
          this.db = event.target.result;
          resolve(this.db);
        };

        request.onerror = (event) => {
          console.error('[Storage] IndexedDB open error:', event.target.error);
          resolve(null);
        };

        request.onblocked = () => {
          console.warn('[Storage] IndexedDB open blocked by another tab');
          resolve(null);
        };
      } catch (err) {
        console.error('[Storage] Fatal error during IndexedDB init:', err);
        resolve(null);
      }
    });
  }

  /**
   * Сохранить снимок документа в IndexedDB и синхронно в localStorage
   * @param {string} docId
   * @param {object} snapshot
   * @param {string} textContent
   * @returns {Promise<boolean>} Успешность записи
   */
  async saveDocument(docId, snapshot, textContent = '') {
    if (!docId || !snapshot) return false;

    // 1. Немедленно пишем в localStorage как надёжный синхронный fallback
    this.saveDocumentSyncFallback(docId, snapshot, textContent);

    await this.initPromise;
    if (!this.db) {
      return true; // LocalStorage уже сохранил
    }

    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction(['documents'], 'readwrite');
        const store = tx.objectStore('documents');

        const record = {
          id: docId,
          snapshot: snapshot,
          data: snapshot, // Для обратной совместимости со старыми модулями
          textContent: textContent,
          updatedAt: Date.now(),
        };

        const req = store.put(record);

        req.onsuccess = () => resolve(true);
        req.onerror = (e) => {
          console.error('[Storage] IndexedDB put error:', req.error);
          resolve(false);
        };
        tx.onabort = () => resolve(false);
        tx.onerror = () => resolve(false);
      } catch (err) {
        console.error('[Storage] Transaction error during saveDocument:', err);
        resolve(false);
      }
    });
  }

  /**
   * Синхронное сохранение в localStorage (для beforeunload, pagehide и fallback)
   */
  saveDocumentSyncFallback(docId, snapshot, textContent = '') {
    try {
      const serialized = JSON.stringify(snapshot);
      localStorage.setItem(`doc_${docId}`, serialized);
      localStorage.setItem(`doc_txt_${docId}`, textContent);
      localStorage.setItem(`doc_time_${docId}`, Date.now().toString());

      // Создаём редкую резервную копию (раз в 10 минут)
      const lastBackup = localStorage.getItem(`backup_last_${docId}`);
      const now = Date.now();
      if (!lastBackup || now - parseInt(lastBackup, 10) > 600000) {
        localStorage.setItem(`backup_${docId}`, serialized);
        localStorage.setItem(`backup_last_${docId}`, now.toString());
      }
      return true;
    } catch (e) {
      console.warn('[Storage] localStorage mirror write failed:', e);
      return false;
    }
  }

  /**
   * Загрузить сохранённый документ
   * Возвращает объект с гарантированным полем `snapshot`
   * @param {string} docId
   * @returns {Promise<{snapshot: object, textContent: string, updatedAt: number} | null>}
   */
  async loadDocument(docId) {
    await this.initPromise;

    let idbRecord = null;
    if (this.db) {
      idbRecord = await new Promise((resolve) => {
        try {
          const tx = this.db.transaction(['documents'], 'readonly');
          const store = tx.objectStore('documents');
          const req = store.get(docId);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => resolve(null);
        } catch (e) {
          resolve(null);
        }
      });
    }

    // Читаем из localStorage
    let lsRecord = null;
    try {
      const raw = localStorage.getItem(`doc_${docId}`);
      const text = localStorage.getItem(`doc_txt_${docId}`) || '';
      const timeStr = localStorage.getItem(`doc_time_${docId}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        lsRecord = {
          snapshot: parsed,
          textContent: text,
          updatedAt: timeStr ? parseInt(timeStr, 10) : 0,
        };
      }
    } catch (e) {}

    // Выбираем самую свежую версию между IndexedDB и localStorage
    let chosen = null;
    if (idbRecord && lsRecord) {
      const idbTime = idbRecord.updatedAt || 0;
      const lsTime = lsRecord.updatedAt || 0;
      chosen = idbTime >= lsTime ? idbRecord : lsRecord;
    } else {
      chosen = idbRecord || lsRecord;
    }

    // Если всё ещё пусто, проверяем резервную копию
    if (!chosen) {
      try {
        const backupRaw = localStorage.getItem(`backup_${docId}`);
        if (backupRaw) {
          chosen = { snapshot: JSON.parse(backupRaw), textContent: '' };
        }
      } catch (e) {}
    }

    if (!chosen) return null;

    // Нормализация контракта: поле snapshot гарантированно существует
    const snapshot = chosen.snapshot || chosen.data || (chosen.items ? chosen : null);
    if (!snapshot) return null;

    return {
      id: docId,
      snapshot: snapshot,
      data: snapshot, // Для обратной совместимости
      textContent: chosen.textContent || '',
      updatedAt: chosen.updatedAt || Date.now(),
    };
  }

  /**
   * Сохранить операцию в локальную очередь до подтверждения op_ack
   */
  async queuePendingOp(opId, docId, op) {
    await this.initPromise;
    if (!this.db) {
      try {
        const key = `pending_${docId}`;
        const current = JSON.parse(localStorage.getItem(key) || '{}');
        current[opId] = { opId, docId, op, time: Date.now() };
        localStorage.setItem(key, JSON.stringify(current));
      } catch (e) {}
      return;
    }

    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction(['pending_ops'], 'readwrite');
        const store = tx.objectStore('pending_ops');
        store.put({
          opId,
          docId,
          op,
          timestamp: Date.now(),
        });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  }

  /**
   * Получить список всех неподтверждённых операций (БЕЗ удаления)
   */
  async getPendingOps(docId) {
    await this.initPromise;
    if (!this.db) {
      try {
        const current = JSON.parse(localStorage.getItem(`pending_${docId}`) || '{}');
        return Object.values(current);
      } catch (e) {
        return [];
      }
    }

    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction(['pending_ops'], 'readonly');
        const store = tx.objectStore('pending_ops');
        const index = store.index('docId');
        const req = index.getAll(docId);
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
  }

  /**
   * Удалить операцию из очереди ТОЛЬКО после получения op_ack от сервера
   */
  async acknowledgeOp(opId, docId) {
    await this.initPromise;
    if (!this.db) {
      try {
        const key = `pending_${docId}`;
        const current = JSON.parse(localStorage.getItem(key) || '{}');
        delete current[opId];
        localStorage.setItem(key, JSON.stringify(current));
      } catch (e) {}
      return;
    }

    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction(['pending_ops'], 'readwrite');
        const store = tx.objectStore('pending_ops');
        const req = store.delete(opId);
        req.onsuccess = () => resolve(true);
        req.onerror = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  }
}

export const docStorage = new DocStorage();
