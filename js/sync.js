/**
 * Сетевой клиент синхронизации (WebSocket CRDT Sync Protocol)
 * 
 * Особенности:
 * 1. Автономный режим: если wsUrl не задан, не делает лишних сетевых вызовов.
 * 2. Честные статусы: чёткое разделение между «Сохранено на устройстве» и «Синхронизировано онлайн».
 * 3. Гарантированная очередь: unacknowledged операции хранятся в IndexedDB до получения op_ack.
 * 4. Безопасное переподключение с экспоненциальной задержкой.
 */

import { docStorage } from './storage.js';

export const SyncStatus = {
  CONNECTING: 'connecting',
  SYNCED: 'synced',
  SYNCING: 'syncing',
  OFFLINE: 'offline',
  ERROR: 'error',
};

export class SyncClient {
  constructor(crdtDoc, awareness, config) {
    this.crdtDoc = crdtDoc;
    this.awareness = awareness;
    this.config = config; // { wsUrl, docId, inviteKey }

    this.ws = null;
    this.status = this.config.wsUrl ? SyncStatus.CONNECTING : SyncStatus.OFFLINE;
    this.statusListeners = new Set();
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.heartbeatInterval = null;
    this.unacknowledgedOps = new Set();

    // Слушаем локальные изменения документа
    this.crdtDoc.subscribe((origin, op) => {
      if (origin === 'local' && op) {
        this.sendOp(op);
      }
    });

    if (this.config.wsUrl) {
      this.connect();
    }
  }

  onStatusChange(callback) {
    this.statusListeners.add(callback);
    callback(this.status);
    return () => this.statusListeners.delete(callback);
  }

  setStatus(newStatus) {
    if (this.status !== newStatus) {
      this.status = newStatus;
      for (const cb of this.statusListeners) {
        try {
          cb(newStatus);
        } catch (e) {
          console.error('[Sync] Status listener error:', e);
        }
      }
    }
  }

  connect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    clearInterval(this.heartbeatInterval);

    if (!this.config.wsUrl) {
      this.setStatus(SyncStatus.OFFLINE);
      return;
    }

    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) {
        return; // Уже открыт и готов к работе
      }
      try {
        this.ws.close();
      } catch (e) {}
      this.ws = null;
    }

    this.setStatus(SyncStatus.CONNECTING);

    try {
      const url = new URL(this.config.wsUrl);
      url.searchParams.set('doc', this.config.docId);
      if (this.config.inviteKey) {
        url.searchParams.set('key', this.config.inviteKey);
      }
      url.searchParams.set('client', this.crdtDoc.clientId);

      this.ws = new WebSocket(url.toString());

      this.ws.onopen = () => this.handleOpen();
      this.ws.onmessage = (event) => this.handleMessage(event);
      this.ws.onerror = (error) => this.handleError(error);
      this.ws.onclose = (event) => this.handleClose(event);
    } catch (err) {
      console.warn('[Sync] WebSocket init error:', err.message);
      this.setStatus(SyncStatus.OFFLINE);
      this.scheduleReconnect();
    }
  }

  async handleOpen() {
    this.reconnectAttempts = 0;

    // 1. Рукопожатие авторизации
    this.sendMessage({
      type: 'auth',
      inviteKey: this.config.inviteKey,
      docId: this.config.docId,
      clientId: this.crdtDoc.clientId,
    });

    // 2. Запрос актуального состояния документа с сервера
    const stateVectorObj = {};
    for (const [k, v] of this.crdtDoc.stateVector.entries()) {
      stateVectorObj[k] = v;
    }

    this.sendMessage({
      type: 'sync_step_1',
      docId: this.config.docId,
      stateVector: stateVectorObj,
    });

    // 3. Отправка awareness (присутствие)
    this.broadcastAwareness();

    // 4. Пинг-хартбит
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.sendMessage({ type: 'ping' });
        this.broadcastAwareness();
      }
    }, 12000);

    // 5. Повторная отправка всех неподтверждённых офлайн-операций
    await this.flushPendingQueue();
  }

  async flushPendingQueue() {
    const pendingList = await docStorage.getPendingOps(this.config.docId);
    if (pendingList && pendingList.length > 0) {
      this.setStatus(SyncStatus.SYNCING);
      for (const item of pendingList) {
        this.unacknowledgedOps.add(item.opId);
        this.sendMessage({
          type: 'op',
          docId: this.config.docId,
          op: item.op,
          opId: item.opId,
        });
      }
    } else if (this.unacknowledgedOps.size === 0) {
      this.setStatus(SyncStatus.SYNCED);
    }
  }

  handleMessage(event) {
    try {
      let data = event.data;
      if (typeof data !== 'string') {
        const decoder = new TextDecoder();
        data = decoder.decode(data);
      }

      const msg = JSON.parse(data);

      switch (msg.type) {
        case 'auth_success':
          if (this.unacknowledgedOps.size === 0) {
            this.setStatus(SyncStatus.SYNCED);
          }
          break;

        case 'auth_failed':
          console.warn('[Sync] Сервер отклонил ключ доступа:', msg.reason);
          this.setStatus(SyncStatus.ERROR);
          break;

        case 'sync_step_2':
        case 'snapshot':
          if (msg.snapshot) {
            this.crdtDoc.loadSnapshot(msg.snapshot);
            docStorage.saveDocument(
              this.config.docId,
              this.crdtDoc.exportSnapshot(),
              this.crdtDoc.toPlainText()
            );
          }
          if (this.unacknowledgedOps.size === 0) {
            this.setStatus(SyncStatus.SYNCED);
          }
          break;

        case 'op':
          if (msg.op) {
            this.crdtDoc.applyRemoteOp(msg.op);
            docStorage.saveDocument(
              this.config.docId,
              this.crdtDoc.exportSnapshot(),
              this.crdtDoc.toPlainText()
            );
          }
          break;

        case 'op_ack':
          if (msg.opId) {
            this.unacknowledgedOps.delete(msg.opId);
            docStorage.acknowledgeOp(msg.opId, this.config.docId);
          }
          if (this.unacknowledgedOps.size === 0) {
            this.setStatus(SyncStatus.SYNCED);
          }
          break;

        case 'awareness':
          if (msg.clientId && msg.state) {
            this.awareness.applyRemoteState(msg.clientId, msg.state);
          }
          break;

        case 'pong':
          break;

        default:
          break;
      }
    } catch (err) {
      console.warn('[Sync] Message parse error:', err);
    }
  }

  handleError(error) {
    this.setStatus(SyncStatus.OFFLINE);
  }

  handleClose(event) {
    clearInterval(this.heartbeatInterval);
    this.setStatus(SyncStatus.OFFLINE);
    if (this.config.wsUrl) {
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    // Экспоненциальная задержка до 15 секунд
    const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 15000);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  sendMessage(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(msg));
        return true;
      } catch (e) {
        console.warn('[Sync] Failed to send message over socket:', e);
      }
    }
    return false;
  }

  async sendOp(op) {
    const opId = op.opId || `${op.client}@${op.clock}`;

    // Сохраняем в очередь офлайн-операций IndexedDB
    await docStorage.queuePendingOp(opId, this.config.docId, op);

    // Если сокет активен, отправляем на сервер
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.unacknowledgedOps.add(opId);
      this.setStatus(SyncStatus.SYNCING);
      this.sendMessage({
        type: 'op',
        docId: this.config.docId,
        op,
        opId,
      });
    }
  }

  broadcastAwareness() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const state = this.awareness.getLocalState();
      this.sendMessage({
        type: 'awareness',
        docId: this.config.docId,
        clientId: this.crdtDoc.clientId,
        state,
      });
    }
  }
}
