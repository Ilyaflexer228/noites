/**
 * Главный координатор приложения «Наши планы 🎄»
 * Гарантирует сохранение данных при любых обстоятельствах: F5, закрытие вкладки, офлайн.
 */

import { CONFIG, getUrlParams } from '../config.js';
import { CollaborativeDoc } from './crdt.js';
import { docStorage } from './storage.js';
import { AwarenessManager } from './awareness.js';
import { SyncClient, SyncStatus } from './sync.js';
import { AppleNotesEditor } from './editor.js';

class App {
  constructor() {
    this.user = this.loadUserProfile();
    this.urlParams = getUrlParams();
    this.crdtDoc = null;
    this.awareness = null;
    this.syncClient = null;
    this.editor = null;
    this._localSaveTimer = null;

    this.init();
  }

  loadUserProfile() {
    try {
      const saved = localStorage.getItem('apple_notes_user');
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (e) {
      console.warn('Could not read user profile:', e);
    }

    const randomColor = CONFIG.USER_COLORS[Math.floor(Math.random() * CONFIG.USER_COLORS.length)];
    const randomEmoji = CONFIG.EMOJI_PRESETS[Math.floor(Math.random() * CONFIG.EMOJI_PRESETS.length)];

    return {
      id: 'usr_' + Math.random().toString(36).substring(2, 10),
      name: '',
      emoji: randomEmoji,
      color: randomColor,
      isConfigured: false,
    };
  }

  saveUserProfile(profile) {
    this.user = { ...this.user, ...profile, isConfigured: true };
    try {
      localStorage.setItem('apple_notes_user', JSON.stringify(this.user));
    } catch (e) {}

    if (this.awareness) {
      this.awareness.updateLocalUser(this.user);
    }

    this.renderHeaderProfile();
  }

  async init() {
    this.initTheme();
    this.bindHeaderActions();

    if (!this.user.isConfigured || !this.user.name) {
      this.showProfileModal(true);
    } else {
      this.renderHeaderProfile();
    }

    // Инициализация CRDT-документа с устойчивым идентификатором пользователя
    this.crdtDoc = new CollaborativeDoc(this.urlParams.docId, this.user.id);

    // 1. НАДЁЖНОЕ ВОССТАНОВЛЕНИЕ: Чтение из IndexedDB и localStorage
    const cached = await docStorage.loadDocument(this.urlParams.docId);

    if (cached) {
      // Документ уже существовал и был сохранён ранее (включая намеренно пустые заметки)
      const savedSnapshot = cached.snapshot || cached.data || (cached.items ? cached : null);
      if (savedSnapshot) {
        this.crdtDoc.loadSnapshot(savedSnapshot);
      }
    } else {
      // Стартовый шаблон создаётся ТОЛЬКО при самом первом создании нового документа
      this.crdtDoc.initializeWithTemplate();
      await this.saveDocumentLocally();
    }

    // Подписываемся на любые изменения CRDT для немедленного локального сохранения
    this.crdtDoc.subscribe(async (origin) => {
      if (origin === 'local' || origin === 'remote') {
        await this.saveDocumentLocally();
      }
    });

    // Экстренное синхронное сохранение при F5, закрытии вкладки или сворачивании на смартфоне
    const emergencySave = () => {
      const snapshot = this.crdtDoc.exportSnapshot();
      const text = this.crdtDoc.toPlainText();
      docStorage.saveDocumentSyncFallback(this.urlParams.docId, snapshot, text);
    };
    window.addEventListener('beforeunload', emergencySave);
    window.addEventListener('pagehide', emergencySave);

    // Инициализация Awareness (присутствие)
    this.awareness = new AwarenessManager(this.crdtDoc, this.user);
    this.awareness.setCursorContainer(document.getElementById('cursor-container'));
    this.awareness.subscribe((peers) => this.renderActivePeers(peers));

    // Инициализация визуального редактора
    const editorEl = document.getElementById('editor');
    this.editor = new AppleNotesEditor(editorEl, this.crdtDoc, this.awareness);

    // Инициализация сетевой синхронизации (WebSocket)
    this.syncClient = new SyncClient(this.crdtDoc, this.awareness, this.urlParams);
    this.syncClient.onStatusChange((status) => this.updateSyncStatusBadge(status));

    // Обновляем статус первоначального сохранения
    if (!this.urlParams.wsUrl) {
      this.updateSyncStatusBadge('local_saved');
    }

    // Привязка панели форматирования
    this.bindToolbar();
    this.updateNoteDate();
  }

  /**
   * Локальное сохранение документа в IndexedDB и localStorage
   */
  async saveDocumentLocally() {
    clearTimeout(this._localSaveTimer);
    return new Promise((resolve) => {
      this._localSaveTimer = setTimeout(async () => {
        try {
          const snapshot = this.crdtDoc.exportSnapshot();
          const text = this.crdtDoc.toPlainText();
          const ok = await docStorage.saveDocument(this.urlParams.docId, snapshot, text);

          if (ok) {
            // Если сокет не подключён, отображаем честный статус локального сохранения
            if (!this.syncClient || this.syncClient.status === SyncStatus.OFFLINE) {
              this.updateSyncStatusBadge('local_saved');
            }
          } else {
            this.updateSyncStatusBadge('local_error');
          }
          resolve(ok);
        } catch (err) {
          console.error('[App] Save locally failed:', err);
          this.updateSyncStatusBadge('local_error');
          resolve(false);
        }
      }, 40);
    });
  }

  initTheme() {
    const savedTheme = localStorage.getItem('apple_notes_theme');
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = savedTheme || (prefersDark ? 'dark' : 'light');

    document.documentElement.setAttribute('data-theme', theme);
    this.updateThemeButton(theme);

    const themeBtn = document.getElementById('theme-toggle-btn');
    if (themeBtn) {
      themeBtn.addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme') || 'light';
        const next = current === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('apple_notes_theme', next);
        this.updateThemeButton(next);
      });
    }
  }

  updateThemeButton(theme) {
    const icon = document.getElementById('theme-icon');
    if (icon) {
      icon.textContent = theme === 'dark' ? '☀️' : '🌙';
    }
  }

  /**
   * Индикатор синхронизации с честным разделением онлайн/офлайн
   */
  updateSyncStatusBadge(status) {
    const pill = document.getElementById('sync-status-pill');
    const text = document.getElementById('sync-status-text');
    if (!pill || !text) return;

    switch (status) {
      case SyncStatus.SYNCED:
        text.textContent = 'Синхронизировано';
        pill.className = 'sync-status-pill status-synced';
        break;
      case SyncStatus.SYNCING:
        text.textContent = 'Синхронизация…';
        pill.className = 'sync-status-pill status-syncing';
        break;
      case SyncStatus.CONNECTING:
        text.textContent = 'Подключение…';
        pill.className = 'sync-status-pill status-connecting';
        break;
      case SyncStatus.OFFLINE:
        text.textContent = 'Нет соединения';
        pill.className = 'sync-status-pill status-offline';
        break;
      case 'local_saved':
        text.textContent = 'Сохранено только на устройстве';
        pill.className = 'sync-status-pill status-offline';
        break;
      case 'local_error':
      case SyncStatus.ERROR:
        text.textContent = 'Ошибка сохранения';
        pill.className = 'sync-status-pill status-error';
        break;
      default:
        text.textContent = 'Сохранено';
        pill.className = 'sync-status-pill status-offline';
        break;
    }
  }

  renderActivePeers(peers) {
    const container = document.getElementById('active-peers-container');
    if (!container) return;

    container.innerHTML = '';
    const maxVisible = 4;
    const visiblePeers = peers.slice(0, maxVisible);

    for (const peer of visiblePeers) {
      const avatarEl = document.createElement('div');
      avatarEl.className = 'peer-avatar';
      const color = peer.user.color ? (peer.user.color.bg || peer.user.color) : '#007aff';
      avatarEl.style.borderColor = color;
      avatarEl.title = `${peer.user.name || 'Друг'} ${peer.isLocal ? '(Вы)' : ''}`;
      avatarEl.innerHTML = `<span class="peer-avatar-emoji">${peer.user.emoji || '👤'}</span>`;
      container.appendChild(avatarEl);
    }

    if (peers.length > maxVisible) {
      const moreEl = document.createElement('div');
      moreEl.className = 'peer-avatar peer-avatar-more';
      moreEl.textContent = `+${peers.length - maxVisible}`;
      container.appendChild(moreEl);
    }
  }

  renderHeaderProfile() {
    const btn = document.getElementById('user-profile-btn');
    if (!btn) return;
    btn.innerHTML = `
      <span class="user-emoji">${this.user.emoji || '😎'}</span>
      <span class="user-name">${escapeHTML(this.user.name || 'Профиль')}</span>
    `;
  }

  updateNoteDate() {
    const dateEl = document.getElementById('note-meta-date');
    if (!dateEl) return;
    const now = new Date();
    const options = { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' };
    dateEl.textContent = now.toLocaleDateString('ru-RU', options);
  }

  bindToolbar() {
    const bindBtn = (id, action) => {
      const btn = document.getElementById(id);
      if (btn) {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          action();
        });
      }
    };

    bindBtn('tb-h1', () => this.editor.formatCurrentBlock('h1'));
    bindBtn('tb-h2', () => this.editor.formatCurrentBlock('h2'));
    bindBtn('tb-task', () => this.editor.formatCurrentBlock('task'));
    bindBtn('tb-bullet', () => this.editor.formatCurrentBlock('bullet'));
    bindBtn('tb-number', () => this.editor.formatCurrentBlock('number'));
    bindBtn('tb-text', () => this.editor.formatCurrentBlock('text'));

    bindBtn('tb-bold', () => document.execCommand('bold', false, null));
    bindBtn('tb-italic', () => document.execCommand('italic', false, null));
    bindBtn('tb-strike', () => document.execCommand('strikeThrough', false, null));

    bindBtn('tb-undo', () => document.execCommand('undo', false, null));
    bindBtn('tb-redo', () => document.execCommand('redo', false, null));

    const exportBtn = document.getElementById('tb-export');
    const exportMenu = document.getElementById('export-dropdown-menu');
    if (exportBtn && exportMenu) {
      exportBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        exportMenu.classList.toggle('show');
      });

      document.addEventListener('click', () => {
        exportMenu.classList.remove('show');
      });

      document.getElementById('export-md')?.addEventListener('click', () => this.exportMarkdown());
      document.getElementById('export-html')?.addEventListener('click', () => this.exportHTML());
      document.getElementById('export-txt')?.addEventListener('click', () => this.exportTxt());
    }
  }

  bindHeaderActions() {
    const profileBtn = document.getElementById('user-profile-btn');
    if (profileBtn) {
      profileBtn.addEventListener('click', () => this.showProfileModal(false));
    }

    const shareBtn = document.getElementById('share-btn');
    if (shareBtn) {
      shareBtn.addEventListener('click', () => this.showShareModal());
    }
  }

  showProfileModal(isFirstTime = false) {
    const modal = document.getElementById('profile-modal');
    const input = document.getElementById('profile-name-input');
    const emojiGrid = document.getElementById('emoji-grid');
    const saveBtn = document.getElementById('profile-save-btn');
    const customEmojiInput = document.getElementById('custom-emoji-input');

    if (!modal || !input || !emojiGrid || !saveBtn) return;

    input.value = this.user.name || '';
    let selectedEmoji = this.user.emoji || '😎';

    emojiGrid.innerHTML = '';
    CONFIG.EMOJI_PRESETS.forEach((em) => {
      const emBtn = document.createElement('button');
      emBtn.type = 'button';
      emBtn.className = 'emoji-picker-btn' + (em === selectedEmoji ? ' selected' : '');
      emBtn.textContent = em;
      emBtn.addEventListener('click', () => {
        emojiGrid.querySelectorAll('.emoji-picker-btn').forEach((b) => b.classList.remove('selected'));
        emBtn.classList.add('selected');
        selectedEmoji = em;
        if (customEmojiInput) customEmojiInput.value = '';
      });
      emojiGrid.appendChild(emBtn);
    });

    if (customEmojiInput) {
      customEmojiInput.addEventListener('input', () => {
        if (customEmojiInput.value.trim()) {
          emojiGrid.querySelectorAll('.emoji-picker-btn').forEach((b) => b.classList.remove('selected'));
          selectedEmoji = customEmojiInput.value.trim();
        }
      });
    }

    modal.classList.add('show');
    setTimeout(() => input.focus(), 100);

    const onSave = () => {
      const name = input.value.trim();
      if (!name) {
        input.classList.add('shake');
        setTimeout(() => input.classList.remove('shake'), 400);
        return;
      }

      this.saveUserProfile({
        name,
        emoji: selectedEmoji,
      });

      modal.classList.remove('show');
      saveBtn.removeEventListener('click', onSave);
    };

    saveBtn.onclick = onSave;
    input.onkeydown = (e) => {
      if (e.key === 'Enter') onSave();
    };
  }

  showShareModal() {
    const modal = document.getElementById('share-modal');
    const linkInput = document.getElementById('share-link-input');
    const copyBtn = document.getElementById('copy-share-link-btn');
    const closeBtn = document.getElementById('share-modal-close-btn');

    if (!modal || !linkInput || !copyBtn) return;

    const shareUrl = new URL(window.location.origin + window.location.pathname);
    shareUrl.searchParams.set('doc', this.urlParams.docId);
    if (this.urlParams.inviteKey) {
      shareUrl.searchParams.set('key', this.urlParams.inviteKey);
    }
    if (this.urlParams.wsUrl) {
      shareUrl.searchParams.set('ws', this.urlParams.wsUrl);
    }
    linkInput.value = shareUrl.toString();

    modal.classList.add('show');

    copyBtn.onclick = () => {
      navigator.clipboard.writeText(shareUrl.toString()).then(() => {
        this.showToast('Ссылка скопирована в буфер обмена! 📋');
        copyBtn.textContent = 'Скопировано! ✓';
        setTimeout(() => {
          copyBtn.textContent = 'Копировать ссылку';
          modal.classList.remove('show');
        }, 1200);
      });
    };

    if (closeBtn) {
      closeBtn.onclick = () => modal.classList.remove('show');
    }
  }

  showToast(message, duration = 2500) {
    let toast = document.getElementById('apple-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'apple-toast';
      toast.className = 'apple-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('show');

    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      toast.classList.remove('show');
    }, duration);
  }

  exportMarkdown() {
    const md = this.crdtDoc.toMarkdown();
    this.downloadFile('Наши_планы_на_Новый_год_2027.md', md, 'text/markdown;charset=utf-8');
    this.showToast('Заметка экспортирована в Markdown! 📝');
  }

  exportHTML() {
    const html = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <title>Наши планы на Новый год 2027</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 680px; margin: 40px auto; padding: 20px; line-height: 1.6; }
    h1 { font-size: 28px; }
    h2 { font-size: 22px; margin-top: 24px; }
    .checked { text-decoration: line-through; opacity: 0.6; }
  </style>
</head>
<body>
${this.crdtDoc.toHTML()}
</body>
</html>`;
    this.downloadFile('Наши_планы_на_Новый_год_2027.html', html, 'text/html;charset=utf-8');
    this.showToast('Заметка экспортирована в HTML! 🌐');
  }

  exportTxt() {
    const txt = this.crdtDoc.toPlainText();
    this.downloadFile('Наши_планы_на_Новый_год_2027.txt', txt, 'text/plain;charset=utf-8');
    this.showToast('Заметка экспортирована в TXT! 📄');
  }

  downloadFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
  }
}

function escapeHTML(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, '');
}

document.addEventListener('DOMContentLoaded', () => {
  window.appleNotesApp = new App();
});
