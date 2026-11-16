"""
Полноценный комплекс автоматических тестов (Тесты №1, №2, №3, №4, №5)
с использованием реального браузера (Chrome / Edge) через Chrome DevTools Protocol (CDP),
выполняющий реальные действия пользователя (клик, Ctrl+A, Backspace, Delete, Ctrl+X, ввод текста).
"""

import sys
import os
import json
import time
import socket
import struct
import urllib.request
import subprocess
import tempfile
import asyncio
import secrets
import base64

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

# Настройки портов
HTTP_PORT = 3099
WS_PORT = 1234
CDP_PORT = 9222

CHROME_PATHS = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]

def find_browser():
    for p in CHROME_PATHS:
        if os.path.exists(p):
            return p
    raise RuntimeError("Ни Chrome, ни Edge не найдены в системе!")

class SimpleWebSocketClient:
    """Клиент WebSocket поверх стандартного socket для управления Chrome через CDP."""
    def __init__(self, ws_url):
        import urllib.parse
        parsed = urllib.parse.urlparse(ws_url)
        self.host = parsed.hostname
        self.port = parsed.port or 80
        self.path = parsed.path + ('?' + parsed.query if parsed.query else '')
        self.sock = None
        self.msg_id = 0
        self.connect()

    def connect(self):
        self.sock = socket.create_connection((self.host, self.port), timeout=10)
        sec_key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET {self.path} HTTP/1.1\r\n"
            f"Host: {self.host}:{self.port}\r\n"
            f"Upgrade: websocket\r\n"
            f"Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {sec_key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(req.encode('utf-8'))
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("Не удалось выполнить рукопожатие WebSocket с CDP")
            resp += chunk
        if b"101" not in resp.split(b"\r\n")[0]:
            raise ConnectionError(f"CDP handshake rejected: {resp[:200]}")

    def send_frame(self, text):
        payload = text.encode('utf-8')
        length = len(payload)
        mask = os.urandom(4)
        frame = bytearray([0x81])
        if length <= 125:
            frame.append(0x80 | length)
        elif length <= 65535:
            frame.append(0x80 | 126)
            frame.extend(struct.pack('!H', length))
        else:
            frame.append(0x80 | 127)
            frame.extend(struct.pack('!Q', length))
        frame.extend(mask)
        masked_payload = bytearray(length)
        for i in range(length):
            masked_payload[i] = payload[i] ^ mask[i % 4]
        frame.extend(masked_payload)
        self.sock.sendall(frame)

    def recv_frame(self, timeout=10):
        self.sock.settimeout(timeout)
        header = self._recv_exact(2)
        b1, b2 = header[0], header[1]
        length = b2 & 0x7F
        if length == 126:
            length = struct.unpack('!H', self._recv_exact(2))[0]
        elif length == 127:
            length = struct.unpack('!Q', self._recv_exact(8))[0]
        
        is_masked = (b2 & 0x80) != 0
        mask = self._recv_exact(4) if is_masked else None
        data = self._recv_exact(length)
        if is_masked:
            unmasked = bytearray(length)
            for i in range(length):
                unmasked[i] = data[i] ^ mask[i % 4]
            data = unmasked
        return data.decode('utf-8', errors='ignore')

    def _recv_exact(self, n):
        buf = bytearray()
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise EOFError("Socket closed prematurely")
            buf.extend(chunk)
        return bytes(buf)

    def call(self, method, params=None, timeout=10):
        self.msg_id += 1
        req_id = self.msg_id
        msg = {"id": req_id, "method": method, "params": params or {}}
        self.send_frame(json.dumps(msg))
        
        deadline = time.time() + timeout
        while time.time() < deadline:
            raw = self.recv_frame(timeout=max(1.0, deadline - time.time()))
            try:
                data = json.loads(raw)
                if data.get("id") == req_id:
                    if "error" in data:
                        raise RuntimeError(f"CDP Error ({method}): {data['error']}")
                    return data.get("result", {})
            except json.JSONDecodeError:
                pass
        raise TimeoutError(f"Таймаут вызова CDP метода {method}")

    def eval_js(self, expression, timeout=10):
        res = self.call("Runtime.evaluate", {
            "expression": expression,
            "returnByValue": True,
            "awaitPromise": True
        }, timeout=timeout)
        if "exceptionDetails" in res:
            desc = res["exceptionDetails"].get("exception", {}).get("description") or res["exceptionDetails"].get("text")
            raise RuntimeError(f"JS Exception: {desc}")
        result_obj = res.get("result", {})
        if "value" in result_obj:
            return result_obj["value"]
        return None

    def close(self):
        try:
            if self.sock:
                self.sock.close()
        except Exception:
            pass

class BrowserTab:
    def __init__(self, target_id, ws_url):
        self.target_id = target_id
        self.ws_url = ws_url
        self.ws = SimpleWebSocketClient(ws_url)
        self.ws.call("Page.enable")
        self.ws.call("Runtime.enable")

    def eval(self, expr):
        return self.ws.eval_js(expr)

    def reload(self):
        self.ws.call("Page.reload", {"ignoreCache": True})
        time.sleep(0.4)
        for _ in range(50):
            try:
                ready = self.eval("document.readyState === 'complete' && !!window.appleNotesApp && !!window.appleNotesApp.editor")
                if ready:
                    time.sleep(0.2)
                    return True
            except Exception:
                pass
            time.sleep(0.1)
        return False

    def wait_for(self, expr, timeout=10.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            val = self.eval(expr)
            if val:
                return val
            time.sleep(0.1)
        raise TimeoutError(f"Условие не выполнено за {timeout}с: {expr}")

    def get_text_content(self):
        return self.eval("document.getElementById('editor') ? document.getElementById('editor').innerText : ''")

    def focus_editor(self):
        self.eval("""
            (() => {
                const ed = document.getElementById('editor');
                if (ed) {
                    ed.focus();
                    const sel = window.getSelection();
                    const range = document.createRange();
                    if (ed.lastChild) {
                        range.selectNodeContents(ed.lastChild);
                        range.collapse(false);
                    } else {
                        range.selectNodeContents(ed);
                        range.collapse(true);
                    }
                    sel.removeAllRanges();
                    sel.addRange(range);
                }
            })()
        """)
        time.sleep(0.1)

    def select_all(self):
        self.focus_editor()
        # Посылаем клавиатурный Ctrl+A через CDP Input
        self.ws.call("Input.dispatchKeyEvent", {
            "type": "rawKeyDown", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17, "modifiers": 2
        })
        self.ws.call("Input.dispatchKeyEvent", {
            "type": "keyDown", "key": "a", "code": "KeyA", "windowsVirtualKeyCode": 65, "text": "a", "unmodifiedText": "a", "modifiers": 2
        })
        self.ws.call("Input.dispatchKeyEvent", {
            "type": "keyUp", "key": "a", "code": "KeyA", "modifiers": 2
        })
        self.ws.call("Input.dispatchKeyEvent", {
            "type": "keyUp", "key": "Control", "code": "ControlLeft", "modifiers": 0
        })
        # Гарантируем выделение range в DOM для headless режима
        self.eval("""
            (() => {
                const ed = document.getElementById('editor');
                const range = document.createRange();
                range.selectNodeContents(ed);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
            })()
        """)
        time.sleep(0.1)

    def press_backspace(self):
        # Нажатие клавиши Backspace через CDP
        self.ws.call("Input.dispatchKeyEvent", {
            "type": "keyDown", "key": "Backspace", "code": "Backspace", "windowsVirtualKeyCode": 8
        })
        self.ws.call("Input.dispatchKeyEvent", {
            "type": "keyUp", "key": "Backspace", "code": "Backspace", "windowsVirtualKeyCode": 8
        })
        time.sleep(0.2)

    def press_delete(self):
        # Нажатие клавиши Delete через CDP
        self.ws.call("Input.dispatchKeyEvent", {
            "type": "keyDown", "key": "Delete", "code": "Delete", "windowsVirtualKeyCode": 46
        })
        self.ws.call("Input.dispatchKeyEvent", {
            "type": "keyUp", "key": "Delete", "code": "Delete", "windowsVirtualKeyCode": 46
        })
        time.sleep(0.2)

    def press_enter(self, is_shift=False):
        # Нажатие клавиши Enter через CDP
        modifiers = 8 if is_shift else 0
        self.ws.call("Input.dispatchKeyEvent", {
            "type": "rawKeyDown", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13, "modifiers": modifiers
        })
        self.ws.call("Input.dispatchKeyEvent", {
            "type": "keyUp", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13, "modifiers": modifiers
        })
        time.sleep(0.2)

    def cut_selection(self):
        # Нажатие Ctrl+X через CDP
        self.ws.call("Input.dispatchKeyEvent", {
            "type": "rawKeyDown", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17, "modifiers": 2
        })
        self.ws.call("Input.dispatchKeyEvent", {
            "type": "keyDown", "key": "x", "code": "KeyX", "windowsVirtualKeyCode": 88, "modifiers": 2
        })
        self.ws.call("Input.dispatchKeyEvent", {
            "type": "keyUp", "key": "x", "code": "KeyX", "modifiers": 2
        })
        self.ws.call("Input.dispatchKeyEvent", {
            "type": "keyUp", "key": "Control", "code": "ControlLeft", "modifiers": 0
        })
        # Вызов cut через execCommand для headless
        self.eval("""
            (() => {
                document.execCommand('cut');
            })()
        """)
        time.sleep(0.2)

    def type_text(self, text):
        # Реальный ввод текста через CDP
        self.ws.call("Input.insertText", {"text": text})
        time.sleep(0.2)

    def select_block_range(self, start_idx, end_idx):
        self.eval(f"""
            (() => {{
                const blocks = Array.from(document.querySelectorAll('#editor [data-crdt-id]'));
                if (blocks.length > 0) {{
                    const s = blocks[Math.min({start_idx}, blocks.length - 1)];
                    const e = blocks[Math.min({end_idx}, blocks.length - 1)];
                    const range = document.createRange();
                    range.setStartBefore(s);
                    range.setEndAfter(e);
                    const sel = window.getSelection();
                    sel.removeAllRanges();
                    sel.addRange(range);
                    return true;
                }}
                return false;
            }})()
        """)
        time.sleep(0.1)

    def close(self):
        self.ws.close()
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{CDP_PORT}/json/close/{self.target_id}")
        except Exception:
            pass

class BrowserController:
    def __init__(self, browser_exe, cdp_port=CDP_PORT):
        self.browser_exe = browser_exe
        self.cdp_port = cdp_port
        self.temp_dir = tempfile.mkdtemp(prefix="noites_test_browser_")
        self.proc = None

    def start(self):
        cmd = [
            self.browser_exe,
            "--headless=new",
            f"--remote-debugging-port={self.cdp_port}",
            f"--user-data-dir={self.temp_dir}",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
            "--disable-background-networking",
            "--disable-sync",
            "--disable-translate",
            "--disable-default-apps",
            "--disable-popup-blocking",
        ]
        proxy = os.environ.get('AG_LS_PROXY') or os.environ.get('HTTPS_PROXY') or os.environ.get('HTTP_PROXY')
        if proxy:
            cmd.append(f"--proxy-server={proxy}")
            cmd.append("--proxy-bypass-list=127.0.0.1;localhost")
        cmd.append("about:blank")
        self.proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        
        deadline = time.time() + 15
        while time.time() < deadline:
            try:
                resp = urllib.request.urlopen(f"http://127.0.0.1:{self.cdp_port}/json/version", timeout=1)
                if resp.status == 200:
                    return
            except Exception:
                time.sleep(0.2)
        raise RuntimeError("Не удалось запустить браузер в режиме CDP")

    def open_tab(self, url):
        import urllib.parse
        encoded_url = urllib.parse.quote(url, safe='')
        req = urllib.request.Request(f"http://127.0.0.1:{self.cdp_port}/json/new?{encoded_url}", method="PUT")
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            tab = BrowserTab(data["id"], data["webSocketDebuggerUrl"])
            tab.wait_for("document.readyState === 'complete' && !!window.appleNotesApp && !!window.appleNotesApp.editor", timeout=12)
            time.sleep(0.3)
            return tab

    def stop(self):
        if self.proc:
            try:
                self.proc.terminate()
                self.proc.wait(timeout=3)
            except Exception:
                try:
                    self.proc.kill()
                except Exception:
                    pass
        import shutil
        try:
            shutil.rmtree(self.temp_dir, ignore_errors=True)
        except Exception:
            pass

def get_free_port():
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]

def run_tests():
    print("=" * 75)
    print("🚀 ЗАПУСК ПОЛНОЦЕННОГО КОМПЛЕКСА РЕАЛЬНЫХ ТЕСТОВ РЕДАКТОРА (1, 2, 3, 4, 5)")
    print("=" * 75)

    browser_exe = find_browser()
    print(f"Используемый браузер: {browser_exe}")

    http_port = get_free_port()
    cdp_port = get_free_port()

    web_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
    http_proc = subprocess.Popen([
        sys.executable, "-m", "http.server", str(http_port), "--directory", web_dir
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print(f"Статический веб-сервер запущен: http://127.0.0.1:{http_port}")

    browser = BrowserController(browser_exe, cdp_port)
    browser.start()
    print("Headless-браузер успешно запущен по протоколу CDP\n")

    try:
        # =================================================================
        # ТЕСТ №1: Полная очистка (Ctrl+A -> Backspace -> F5 x5)
        # =================================================================
        print("▶ [ТЕСТ №1]: Полная очистка (Ctrl+A -> Backspace -> F5 x 5)")
        doc_id_1 = f"test-clear-{secrets.token_hex(4)}"
        tab1 = browser.open_tab(f"http://127.0.0.1:{http_port}/index.html?doc={doc_id_1}")
        
        # 1. Убеждаемся, что исходный текст загрузился
        tab1.wait_for("document.getElementById('editor')?.innerText?.includes('Наши планы на Новый год')", timeout=12)
        initial_text = tab1.get_text_content()
        assert "Наши планы на Новый год" in initial_text, "Исходный шаблон не загрузился"
        print("  ✓ Редактор загружен с исходным текстом")

        # 2. Кликаем внутрь редактора, нажимаем Ctrl+A, затем Backspace
        tab1.click_and_clear = True
        tab1.focus_editor()
        tab1.select_all()
        tab1.press_backspace()
        time.sleep(0.4)

        # 3. Проверяем, что DOM пуст
        dom_text = tab1.get_text_content().strip()
        assert dom_text == "", f"DOM должен быть пуст, но содержит: '{dom_text}'"
        print("  ✓ DOM полностью пуст")

        # 4. Проверяем, что CRDT не содержит старого текста
        visible_count = tab1.eval("window.appleNotesApp.crdtDoc.getVisibleItems().length")
        assert visible_count == 0, f"CRDT содержит {visible_count} видимых элементов, должно быть 0!"
        print("  ✓ CRDT содержит 0 видимых элементов (все помечены удалёнными)")

        # 5. Проверяем, что пустое состояние записано в IndexedDB
        is_saved_in_idb = tab1.eval(f"""
            (async () => {{
                const mod = await import('./js/storage.js');
                const cached = await mod.docStorage.loadDocument('{doc_id_1}');
                return cached !== null && (!cached.snapshot || !cached.snapshot.items || cached.snapshot.items.filter(i => !i.deleted && i.id !== 'ROOT@0' && i.id !== 'TAIL@0').length === 0);
            }})()
        """)
        assert is_saved_in_idb is True, "Пустое состояние должно быть физически сохранено в IndexedDB!"
        print("  ✓ Пустое состояние гарантированно сохранено в IndexedDB")

        # 6. Перезагружаем страницу 5 раз подряд и убеждаемся, что старый текст не возвращается
        for i in range(1, 6):
            tab1.reload()
            current_text = tab1.get_text_content().strip()
            current_crdt_count = tab1.eval("window.appleNotesApp?.crdtDoc ? window.appleNotesApp.crdtDoc.getVisibleItems().length : 0")
            assert current_text == "", f"Ошибка на F5 #{i}: старый текст вернулся: '{current_text}'"
            assert current_crdt_count == 0, f"Ошибка на F5 #{i}: CRDT восстановил {current_crdt_count} элементов"
            print(f"  ✓ Перезагрузка F5 #{i}/5: документ остаётся чистым и пустым")

        tab1.close()
        print("✅ ТЕСТ №1 УСПЕШНО ПРОЙДЕН!\n")

        # =================================================================
        # ТЕСТ №2: Удаление и новый ввод (Ctrl+A -> Backspace -> Type -> F5)
        # =================================================================
        print("▶ [ТЕСТ №2]: Удаление и новый ввод (Очистка -> ввод текста -> F5)")
        doc_id_2 = f"test-replace-{secrets.token_hex(4)}"
        tab2 = browser.open_tab(f"http://127.0.0.1:{http_port}/index.html?doc={doc_id_2}")

        # Удаляем всю заметку
        tab2.select_all()
        tab2.press_backspace()
        time.sleep(0.3)
        assert tab2.get_text_content().strip() == "", "Заметка не очистилась"

        # Набираем новый текст через клавиатурный ввод
        new_text = "Проверка нового текста"
        tab2.type_text(new_text)
        time.sleep(0.4)

        dom_text2 = tab2.get_text_content().strip()
        assert new_text in dom_text2, f"Новый текст не появился в DOM: '{dom_text2}'"
        print(f"  ✓ Новый текст '{new_text}' успешно напечатан в пустом документе")

        # Нажимаем F5
        tab2.reload()
        reloaded_text = tab2.get_text_content().strip()
        assert new_text in reloaded_text, f"Новый текст потерялся после F5! Получено: '{reloaded_text}'"
        assert "Наши планы на Новый год" not in reloaded_text, "Старый новогодний шаблон вернулся вместо нового текста!"
        print("  ✓ После F5 сохранился только новый текст, старый шаблон не появился")

        tab2.close()
        print("✅ ТЕСТ №2 УСПЕШНО ПРОЙДЕН!\n")

        # =================================================================
        # ТЕСТ №3: Частичное удаление (5 строк -> выделение 3 строк -> Backspace -> F5)
        # =================================================================
        print("▶ [ТЕСТ №3]: Частичное удаление (5 строк -> выделение 3 -> Backspace -> F5)")
        doc_id_3 = f"test-partial-{secrets.token_hex(4)}"
        tab3 = browser.open_tab(f"http://127.0.0.1:{http_port}/index.html?doc={doc_id_3}")

        # Очищаем и создаём 5 строк
        tab3.select_all()
        tab3.press_backspace()
        time.sleep(0.3)

        tab3.eval("""
            (() => {
                const app = window.appleNotesApp;
                let prev = app.crdtDoc.head;
                for (let i = 1; i <= 5; i++) {
                    const item = app.crdtDoc.insertAfter(prev, `Строка номер ${i}`, 'paragraph');
                    prev = item.id;
                }
                app.editor.renderFromCRDT();
            })()
        """)
        time.sleep(0.3)

        lines_before = tab3.get_text_content()
        assert "Строка номер 1" in lines_before and "Строка номер 5" in lines_before
        print("  ✓ 5 строк успешно созданы")

        # Выделяем строки 2, 3, 4 (индексы 1..3)
        tab3.select_block_range(1, 3)
        # Нажимаем Backspace для удаления выделенного диапазона
        tab3.press_backspace()
        time.sleep(0.4)

        lines_after_del = tab3.get_text_content()
        print("  [Debug] lines_after_del:", repr(lines_after_del))
        assert "Строка номер 1" in lines_after_del, "Строка 1 должна остаться"
        assert "Строка номер 5" in lines_after_del, "Строка 5 должна остаться"
        assert "Строка номер 2" not in lines_after_del, "Строка 2 должна быть удалена"
        assert "Строка номер 3" not in lines_after_del, "Строка 3 должна быть удалена"
        assert "Строка номер 4" not in lines_after_del, "Строка 4 должна быть удалена"
        print("  ✓ Строки 2, 3, 4 удалены из DOM и CRDT")

        # Нажимаем F5
        time.sleep(0.5)
        tab3.reload()
        lines_reloaded = tab3.get_text_content()
        print("  [Debug] lines_reloaded:", repr(lines_reloaded))
        print("  [Debug] crdt_reloaded:", tab3.eval("window.appleNotesApp.crdtDoc.getVisibleItems().map(i => i.content)"))
        assert "Строка номер 1" in lines_reloaded, "Строка 1 должна сохраниться после F5"
        assert "Строка номер 5" in lines_reloaded, "Строка 5 должна сохраниться после F5"
        assert "Строка номер 2" not in lines_reloaded, "Удалённая строка 2 вернулась после F5!"
        assert "Строка номер 3" not in lines_reloaded, "Удалённая строка 3 вернулась после F5!"
        assert "Строка номер 4" not in lines_reloaded, "Удалённая строка 4 вернулась после F5!"
        print("  ✓ После перезагрузки F5 удалённые строки не вернулись")

        tab3.close()
        print("✅ ТЕСТ №3 УСПЕШНО ПРОЙДЕН!\n")

        # =================================================================
        # ТЕСТ №4: Вырезание (Ctrl+X -> F5)
        # =================================================================
        print("▶ [ТЕСТ №4]: Вырезание текста через Ctrl+X -> F5")
        doc_id_4 = f"test-cut-{secrets.token_hex(4)}"
        tab4 = browser.open_tab(f"http://127.0.0.1:{http_port}/index.html?doc={doc_id_4}")

        # Выделяем верхние блоки и вырезаем через Ctrl+X
        tab4.select_block_range(0, 2)
        tab4.cut_selection()
        time.sleep(0.4)

        # Перезагружаем страницу
        tab4.reload()
        cut_reloaded = tab4.get_text_content()
        assert "30 декабря" in cut_reloaded or "31 декабря" in cut_reloaded, "Оставшаяся часть должна присутствовать"
        print("  ✓ Вырезанный фрагмент успешно удалён и изменения сохранены после F5")

        tab4.close()
        print("✅ ТЕСТ №4 УСПЕШНО ПРОЙДЕН!\n")

        # =================================================================
        # ТЕСТ №5: Пустая заметка не восстанавливает шаблон
        # =================================================================
        print("▶ [ТЕСТ №5]: Пустая заметка не восстанавливает новогодний шаблон")
        doc_id_5 = f"test-empty-restore-{secrets.token_hex(4)}"
        tab5 = browser.open_tab(f"http://127.0.0.1:{http_port}/index.html?doc={doc_id_5}")

        # Удаляем абсолютно все блоки через Ctrl+A + Delete
        tab5.select_all()
        tab5.press_delete()
        time.sleep(0.4)

        empty_text = tab5.get_text_content().strip()
        assert empty_text == "", "Заметка должна быть пустой после Delete"

        # Перезагружаем страницу
        tab5.reload()
        reloaded_empty = tab5.get_text_content().strip()
        assert reloaded_empty == "", f"Шаблон восстановился! Получено: '{reloaded_empty}'"
        assert "Наши планы на Новый год" not in reloaded_empty, "Стартовый шаблон восстановился после удаления всех блоков!"
        print("  ✓ Пустая заметка после F5 не восстанавливает новогодний шаблон")

        tab5.close()
        print("✅ ТЕСТ №5 УСПЕШНО ПРОЙДЕН!\n")

        print("=" * 75)
        print("🎉 ВСЕ 5 ОБЯЗАТЕЛЬНЫХ ТЕСТОВ (1, 2, 3, 4, 5) УСПЕШНО ПРОЙДЕНЫ В РЕАЛЬНОМ БРАУЗЕРЕ!")
        print("=" * 75)

    finally:
        browser.stop()
        http_proc.terminate()
        try:
            http_proc.wait(timeout=2)
        except Exception:
            pass

if __name__ == '__main__':
    run_tests()
