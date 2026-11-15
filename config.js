/**
 * Конфигурация совместной заметки «Наши планы 🎄»
 * Защищённая архитектура: без захардкоженных секретов в исходном коде.
 */

/**
 * Генерация криптографически стойкого случайного ключа доступа (16 байт / 32 hex символа)
 */
export function generateSecureToken() {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return 'key_' + Math.random().toString(36).substring(2, 12) + Math.random().toString(36).substring(2, 12);
}

export const CONFIG = {
  // Название документа по умолчанию
  DOCUMENT_NAME: 'our-plans-ny-2027',

  // Базовый адрес WebSocket сервера (может переопределяться через URL ?ws=... или #ws=...)
  // При открытии на GitHub Pages по HTTPS автоматически использует wss://
  DEFAULT_WS_URL: (function () {
    const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    if (isLocal) {
      return 'ws://localhost:1234';
    }
    // На продакшене используем защищённый wss:// (хост можно задать через URL или дефолт)
    return 'wss://' + window.location.hostname.replace('.github.io', '-sync.onrender.com');
  })(),

  // Имя базы данных IndexedDB для надёжного локального хранения
  INDEXEDDB_NAME: 'apple_notes_store_v2',

  // Палитра цветов для курсоров друзей (iOS системные цвета)
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
 * Получить параметры документа и безопасного ключа приглашения из URL
 * Если ключ отсутствует, генерируется новый и сохраняется в URL hash
 */
export function getUrlParams() {
  const url = new URL(window.location.href);
  const searchParams = url.searchParams;

  let docId = searchParams.get('doc');
  let inviteKey = searchParams.get('key');
  let wsUrl = searchParams.get('ws');

  // Проверяем также URL hash (удобно для GitHub Pages, не отправляется на статический сервер)
  if (window.location.hash) {
    try {
      const hashParams = new URLSearchParams(window.location.hash.slice(1));
      if (!docId && hashParams.get('doc')) docId = hashParams.get('doc');
      if (!inviteKey && hashParams.get('key')) inviteKey = hashParams.get('key');
      if (!wsUrl && hashParams.get('ws')) wsUrl = hashParams.get('ws');
    } catch (e) {
      console.warn('Could not parse URL hash:', e);
    }
  }

  // Если ключ не передан в URL, проверяем сохранённый в sessionStorage или генерируем новый
  if (!inviteKey) {
    const sessionKey = sessionStorage.getItem(`key_${docId || CONFIG.DOCUMENT_NAME}`);
    if (sessionKey) {
      inviteKey = sessionKey;
    } else {
      inviteKey = generateSecureToken();
      sessionStorage.setItem(`key_${docId || CONFIG.DOCUMENT_NAME}`, inviteKey);
    }

    // Сохраняем в URL hash без перезагрузки страницы
    try {
      const newHash = new URLSearchParams();
      newHash.set('doc', docId || CONFIG.DOCUMENT_NAME);
      newHash.set('key', inviteKey);
      window.history.replaceState(null, '', `#${newHash.toString()}`);
    } catch (e) {}
  }

  return {
    docId: docId || CONFIG.DOCUMENT_NAME,
    inviteKey,
    wsUrl: wsUrl || CONFIG.DEFAULT_WS_URL,
  };
}
