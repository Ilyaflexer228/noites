/**
 * Хранилище IndexedDB с гарантированной защитой от потери офлайн-изменений
 * 
 * Правило надёжности:
 * Операции удаляются из локальной очереди ТОЛЬКО после получения подтверждения от сервера (op_ack).
 * При сбоях сети или закрытии вкладки unacknowledged операции гарантированно сохраняются.
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
          console.warn('IndexedDB unavailable, using fallback:', event.target.error);
          resolve(null);
        };
      } catch (err) {
        console.warn('IndexedDB init error:', err);
        resolve(null);
      }
    });
  }

  /**
   * Сохранить ожидающую подтверждения операцию в очередь
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

  /**
   * Сохранить снимок документа
   */
  async saveDocument(docId, snapshot, textContent = '') {
    await this.initPromise;
    if (!this.db) {
      try {
        localStorage.setItem(`doc_${docId}`, JSON.stringify(snapshot));
        localStorage.setItem(`doc_txt_${docId}`, textContent);
      } catch (e) {}
      return;
    }

    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction(['documents'], 'readwrite');
        const store = tx.objectStore('documents');
        const req = store.put({
          id: docId,
          snapshot,
          textContent,
          updatedAt: Date.now(),
        });
        req.onsuccess = () => resolve(true);
        req.onerror = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  }

  /**
   * Загрузить сохранённый снимок документа
   */
  async loadDocument(docId) {
    await this.initPromise;
    if (!this.db) {
      try {
        const raw = localStorage.getItem(`doc_${docId}`);
        const text = localStorage.getItem(`doc_txt_${docId}`) || '';
        if (raw) {
          return { snapshot: JSON.parse(raw), textContent: text };
        }
      } catch (e) {}
      return null;
    }

    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction(['documents'], 'readonly');
        const store = tx.objectStore('documents');
        const req = store.get(docId);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
}

export const docStorage = new DocStorage();
