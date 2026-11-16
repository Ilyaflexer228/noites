/**
 * Конфигурация совместной заметки «Наши планы 🎄»
 * Надёжная архитектура: автономный режим по умолчанию, явный WS-сервер, безопасные токены.
 */

export const CONFIG = {
  DOCUMENT_NAME: 'our-plans-ny-2027',

  // WebSocket URL:
  // - На localhost пробуем локальный сервер ws://localhost:1234
  // - На GitHub Pages и удалённых доменах: если сервер не указан явно через параметр ?ws=
  //   или window.__SYNC_SERVER_URL__, работаем в надёжном автономном режиме без спама в сеть!
  DEFAULT_WS_URL: (function () {
    if (typeof window === 'undefined') return null;

    if (window.__SYNC_SERVER_URL__) {
      return window.__SYNC_SERVER_URL__;
    }

    const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    if (isLocal) {
      return 'ws://localhost:1234';
    }

    return null; // Автономный режим на GitHub Pages, если не передан ?ws=
  })(),

  // Имя базы данных IndexedDB
  INDEXEDDB_NAME: 'apple_notes_store_v2',

  // Цвета для курсоров друзей (iOS системные цвета)
  USER_COLORS: [
    { bg: '#007aff', text: '#ffffff' }, // Синий iOS
    { bg: '#34c759', text: '#ffffff' }, // Зелёный iOS
    { bg: '#ff9500', text: '#ffffff' }, // Оранжевый iOS
    { bg: '#af52de', text: '#ffffff' }, // Фиолетовый iOS
    { bg: '#ff2d55', text: '#ffffff' }, // Розовый iOS
    { bg: '#5856d6', text: '#ffffff' }, // Индиго iOS
    { bg: '#30b0c7', text: '#ffffff' }, // Бирюзовый iOS
    { bg: '#d48806', text: '#ffffff' }, // Тёплый жёлтый
  ],

  // Пресеты эмодзи
  EMOJI_PRESETS: ['😎', '🍻', '🚀', '🎄', '🎅', '🏂', '🍕', '🥂', '🎁', '🎉', '🌟', '🍷', '🎸', '☕', '🔥', '⛄'],
};

/**
 * Получить параметры документа, ключа и адреса сервера
 */
export function getUrlParams() {
  const url = new URL(window.location.href);
  const searchParams = url.searchParams;

  let docId = searchParams.get('doc');
  let inviteKey = searchParams.get('key');
  let wsUrl = searchParams.get('ws');

  // Читаем также параметры из URL hash (для совместимости со статическим GitHub Pages)
  if (window.location.hash) {
    try {
      const hashParams = new URLSearchParams(window.location.hash.slice(1));
      if (!docId && hashParams.get('doc')) docId = hashParams.get('doc');
      if (!inviteKey && hashParams.get('key')) inviteKey = hashParams.get('key');
      if (!wsUrl && hashParams.get('ws')) wsUrl = hashParams.get('ws');
    } catch (e) {}
  }

  // Если ключ не передан, проверяем сохранённый в sessionStorage или используем дефолтный
  if (!inviteKey) {
    const storageKey = `note_key_${docId || CONFIG.DOCUMENT_NAME}`;
    const saved = sessionStorage.getItem(storageKey) || localStorage.getItem(storageKey);
    if (saved) {
      inviteKey = saved;
    } else {
      inviteKey = 'ny2027-friends';
      try {
        sessionStorage.setItem(storageKey, inviteKey);
        localStorage.setItem(storageKey, inviteKey);
      } catch (e) {}
    }
  }

  return {
    docId: docId || CONFIG.DOCUMENT_NAME,
    inviteKey,
    wsUrl: wsUrl || CONFIG.DEFAULT_WS_URL,
  };
}

export function generateSecureToken() {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return 'key_' + Math.random().toString(36).substring(2, 10);
}
