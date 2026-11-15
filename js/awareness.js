/**
 * Awareness Engine (Yjs Awareness compatible)
 * Отслеживает присутствие пользователей онлайн, их аватары и отображает цветные курсоры с именами в реальном времени.
 */
import { CONFIG } from '../config.js';

export class AwarenessManager {
  constructor(crdtDoc, localUser) {
    this.crdtDoc = crdtDoc;
    this.localUser = localUser; // { id, name, emoji, color }
    this.states = new Map(); // clientId -> { user, cursor, lastActive }
    this.listeners = new Set();
    this.cursorContainer = null;

    // Регулярная очистка неактивных пользователей (каждые 5 сек)
    this.cleanupInterval = setInterval(() => this.cleanupStalePeers(), 5000);
  }

  setCursorContainer(el) {
    this.cursorContainer = el;
  }

  subscribe(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  notify() {
    const peers = this.getActivePeers();
    for (const cb of this.listeners) {
      try {
        cb(peers);
      } catch (err) {
        console.error('Awareness listener error:', err);
      }
    }
  }

  updateLocalUser(userUpdates) {
    Object.assign(this.localUser, userUpdates);
    this.notify();
  }

  /**
   * Обновить локальное положение курсора
   */
  setLocalCursor(cursor) {
    this.localUser.cursor = cursor;
    this.localUser.lastActive = Date.now();
  }

  /**
   * Получить локальное состояние awareness для отправки на сервер
   */
  getLocalState() {
    return {
      clientId: this.crdtDoc.clientId,
      user: {
        id: this.localUser.id,
        name: this.localUser.name,
        emoji: this.localUser.emoji,
        color: this.localUser.color,
      },
      cursor: this.localUser.cursor || null,
      timestamp: Date.now(),
    };
  }

  /**
   * Применить состояние awareness от удалённого участника
   */
  applyRemoteState(clientId, state) {
    if (clientId === this.crdtDoc.clientId) return;

    if (!state || state.disconnected) {
      this.states.delete(clientId);
      this.removeCursorElement(clientId);
    } else {
      this.states.set(clientId, {
        clientId,
        user: state.user,
        cursor: state.cursor,
        lastActive: Date.now(),
      });
      this.renderRemoteCursor(clientId, state);
    }

    this.notify();
  }

  /**
   * Список всех активных пользователей онлайн (включая локального)
   */
  getActivePeers() {
    const now = Date.now();
    const result = [
      {
        isLocal: true,
        clientId: this.crdtDoc.clientId,
        user: this.localUser,
      },
    ];

    for (const [clientId, state] of this.states.entries()) {
      // Исключаем тех, от кого не было вестей больше 25 секунд
      if (now - state.lastActive < 25000) {
        result.push({
          isLocal: false,
          clientId,
          user: state.user,
          cursor: state.cursor,
        });
      }
    }

    return result;
  }

  /**
   * Удалить устаревших пользователей
   */
  cleanupStalePeers() {
    const now = Date.now();
    let changed = false;

    for (const [clientId, state] of this.states.entries()) {
      if (now - state.lastActive >= 25000) {
        this.states.delete(clientId);
        this.removeCursorElement(clientId);
        changed = true;
      }
    }

    if (changed) {
      this.notify();
    }
  }

  /**
   * Отрисовать живой курсор удалённого пользователя
   */
  renderRemoteCursor(clientId, state) {
    if (!this.cursorContainer || !state.cursor) {
      this.removeCursorElement(clientId);
      return;
    }

    const { cursor, user } = state;
    let targetEl = null;

    if (cursor.nodeId) {
      targetEl = document.querySelector(`[data-crdt-id="${cursor.nodeId}"]`);
    }

    if (!targetEl) {
      this.removeCursorElement(clientId);
      return;
    }

    let cursorEl = document.getElementById(`cursor-${clientId}`);
    if (!cursorEl) {
      cursorEl = document.createElement('div');
      cursorEl.id = `cursor-${clientId}`;
      cursorEl.className = 'remote-caret';
      this.cursorContainer.appendChild(cursorEl);
    }

    const color = user.color || '#007aff';
    cursorEl.style.setProperty('--caret-color', color.bg || color);

    // Вычисляем координаты относительно редактора
    const rect = targetEl.getBoundingClientRect();
    const containerRect = this.cursorContainer.getBoundingClientRect();

    const top = rect.top - containerRect.top + (cursor.offsetY || 0);
    const left = rect.left - containerRect.left + (cursor.offsetX || 0);

    cursorEl.style.transform = `translate3d(${left}px, ${top}px, 0)`;
    cursorEl.innerHTML = `
      <div class="remote-caret-flag" style="background-color: ${color.bg || color}; color: ${color.text || '#fff'};">
        <span class="remote-caret-emoji">${user.emoji || '👤'}</span>
        <span class="remote-caret-name">${escapeText(user.name || 'Друг')}</span>
      </div>
    `;

    // Сбрасываем таймер затухания плашки имени
    cursorEl.classList.remove('idle');
    clearTimeout(cursorEl._idleTimer);
    cursorEl._idleTimer = setTimeout(() => {
      cursorEl.classList.add('idle');
    }, 3500);
  }

  removeCursorElement(clientId) {
    const el = document.getElementById(`cursor-${clientId}`);
    if (el) {
      el.remove();
    }
  }

  destroy() {
    clearInterval(this.cleanupInterval);
    for (const clientId of this.states.keys()) {
      this.removeCursorElement(clientId);
    }
    this.states.clear();
    this.listeners.clear();
  }
}

function escapeText(str) {
  return str.replace(/[&<>"']/g, '');
}
