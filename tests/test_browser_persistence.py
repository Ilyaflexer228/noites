"""
Автоматизированный комплекс тестов сохранения и совместной работы (Тесты A, B, C, D, E)
с использованием реального headless браузера (Chrome / Edge) через Chrome DevTools Protocol (CDP).
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
    """Минимальный клиент WebSocket поверх стандартного socket для CDP."""
    def __init__(self, ws_url):
        # ws_url = ws://127.0.0.1:9222/devtools/page/...
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
        # Ждём завершения загрузки DOM
        time.sleep(0.4)
        for _ in range(50):
            ready = self.eval("document.readyState === 'complete' && !!window.appleNotesApp && !!window.appleNotesApp.crdtDoc")
            if ready:
                time.sleep(0.15)
                return True
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
            "about:blank"
        ]
        self.proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        
        # Ждём готовности CDP
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
            tab.wait_for("document.readyState === 'complete' && !!window.appleNotesApp && !!window.appleNotesApp.crdtDoc", timeout=12)
            time.sleep(0.2)
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

def start_ws_server_process(port, data_dir, invite_secret='ny2027-friends'):
    server_script = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'server', 'server_py.py'))
    env = os.environ.copy()
    env['PORT'] = str(port)
    env['DATA_DIR'] = data_dir
    env['INVITE_SECRET'] = invite_secret
    proc = subprocess.Popen(
        [sys.executable, server_script],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )
    for _ in range(50):
        try:
            with socket.create_connection(('127.0.0.1', port), timeout=0.2):
                break
        except Exception:
            time.sleep(0.1)
    return proc

def run_tests():
    print("=" * 70)
    print("🚀 ЗАПУСК ОБЯЗАТЕЛЬНЫХ АВТОМАТИЧЕСКИХ ТЕСТОВ (A, B, C, D, E) В CHROME")
    print("=" * 70)

    browser_exe = find_browser()
    print(f"Используемый браузер: {browser_exe}")

    # Запускаем локальный веб-сервер для статических файлов на порту HTTP_PORT
    web_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
    http_proc = subprocess.Popen([
        sys.executable, "-m", "http.server", str(HTTP_PORT), "--directory", web_dir
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print(f"Статический веб-сервер запущен: http://127.0.0.1:{HTTP_PORT}")

    browser = BrowserController(browser_exe, CDP_PORT)
    browser.start()
    print("Headless-браузер успешно запущен по протоколу CDP")

    ws_proc = None
    server_data_dir = tempfile.mkdtemp(prefix="noites_server_data_")

    try:
        # -------------------------------------------------------------
        # ТЕСТ A: F5 Persistence (Перезагрузка 5 раз подряд)
        # -------------------------------------------------------------
        print("\n▶ [ТЕСТ A]: F5 Persistence (Перезагрузка страницы 5 раз подряд)")
        doc_id_a = f"test-f5-{secrets.token_hex(4)}"
        test_url_a = f"http://127.0.0.1:{HTTP_PORT}/index.html?doc={doc_id_a}&key=ny2027-friends"
        
        tab_a = browser.open_tab(test_url_a)
        
        # Вводим уникальный текст
        unique_text = f"ТЕСТ_СОХРАНЕНИЯ_12345_{secrets.token_hex(3)}"
        tab_a.eval(f"""
            (() => {{
                const app = window.appleNotesApp;
                const items = app.crdtDoc.getVisibleItems();
                const lastItem = items[items.length - 1];
                app.crdtDoc.insertAfter(lastItem ? lastItem.id : 'ROOT@0', {json.dumps(unique_text)}, 'paragraph');
            }})()
        """)
        
        # Даём сохранить в IndexedDB
        time.sleep(0.3)
        assert unique_text in tab_a.get_text_content(), "Текст не отобразился в DOM до перезагрузки"

        # Перезагружаем 5 раз подряд (F5 / reload)
        for i in range(1, 6):
            tab_a.reload()
            dom_text = tab_a.get_text_content()
            assert unique_text in dom_text, f"Ошибка на шаге {i}: текст '{unique_text}' потерялся после {i}-го обновления F5!"
            print(f"  ✓ Обновление #{i}/5 успешно: текст сохранён в DOM")
        
        tab_a.close()
        print("✅ ТЕСТ A ПРОЙДЕН: Данные гарантированно сохраняются после 5 обновлений F5!")

        # -------------------------------------------------------------
        # ТЕСТ B: Offline Mode (Без WebSocket-сервера)
        # -------------------------------------------------------------
        print("\n▶ [ТЕСТ B]: Offline Mode (Локальное сохранение без облачного сервера)")
        doc_id_b = f"test-offline-{secrets.token_hex(4)}"
        # Сервер ws://127.0.0.1:9999 намеренно не запущен
        test_url_b = f"http://127.0.0.1:{HTTP_PORT}/index.html?doc={doc_id_b}&ws=ws://127.0.0.1:9999"
        
        tab_b = browser.open_tab(test_url_b)
        offline_text = f"ОФЛАЙН_ТЕКСТ_{secrets.token_hex(4)}"
        tab_b.eval(f"""
            (() => {{
                const app = window.appleNotesApp;
                const items = app.crdtDoc.getVisibleItems();
                const lastItem = items[items.length - 1];
                app.crdtDoc.insertAfter(lastItem ? lastItem.id : 'ROOT@0', {json.dumps(offline_text)}, 'paragraph');
            }})()
        """)
        time.sleep(0.3)

        # Перезагружаем страницу в офлайне
        tab_b.reload()
        dom_text_b = tab_b.get_text_content()
        assert offline_text in dom_text_b, "Офлайн-текст не сохранился после перезагрузки!"
        print(f"  ✓ Текст '{offline_text}' успешно восстановлен из IndexedDB без подключения к серверу")
        tab_b.close()
        print("✅ ТЕСТ B ПРОЙДЕН: Автономное локальное сохранение работает на 100%!")

        # -------------------------------------------------------------
        # ТЕСТ C: Чек-листы (Сохранение галочек и пунктов)
        # -------------------------------------------------------------
        print("\n▶ [ТЕСТ C]: Чек-листы (Создание 3 пунктов и сохранение отметки галочки)")
        doc_id_c = f"test-checklist-{secrets.token_hex(4)}"
        test_url_c = f"http://127.0.0.1:{HTTP_PORT}/index.html?doc={doc_id_c}&key=ny2027-friends"

        tab_c = browser.open_tab(test_url_c)
        tab_c.eval("""
            const app = window.appleNotesApp;
            const items = app.crdtDoc.getVisibleItems();
            const last = items[items.length - 1];
            const p1 = app.crdtDoc.insertAfter(last ? last.id : 'ROOT@0', '1. Купить мандарины', 'task');
            const p2 = app.crdtDoc.insertAfter(p1.id, '2. Нарядить ёлку', 'task');
            const p3 = app.crdtDoc.insertAfter(p2.id, '3. Запустить фейерверк', 'task');
            // Отмечаем пункт 2 выполненным
            app.crdtDoc.toggleTaskChecked(p2.id, true);
        """)
        time.sleep(0.3)

        tab_c.reload()
        
        # Проверяем в DOM наличие пунктов и состояние чекбокса
        checklist_state = tab_c.eval("""
            (() => {
                const tasks = Array.from(document.querySelectorAll('.note-task-row'));
                const mand = tasks.find(t => t.innerText.includes('Купить мандарины'));
                const tree = tasks.find(t => t.innerText.includes('Нарядить ёлку'));
                const fire = tasks.find(t => t.innerText.includes('Запустить фейерверк'));
                
                const treeCb = tree ? tree.querySelector('.apple-checkbox-input') : null;
                const mandCb = mand ? mand.querySelector('.apple-checkbox-input') : null;
                
                return {
                    count: tasks.length,
                    hasTree: !!tree,
                    treeChecked: treeCb ? treeCb.checked : false,
                    hasMand: !!mand,
                    mandChecked: mandCb ? mandCb.checked : false,
                    hasFire: !!fire
                };
            })()
        """)
        assert checklist_state["hasMand"], "Пункт 1 чек-листа отсутствует"
        assert checklist_state["hasTree"], "Пункт 2 чек-листа отсутствует"
        assert checklist_state["hasFire"], "Пункт 3 чек-листа отсутствует"
        assert checklist_state["treeChecked"] is True, "Пункт 2 должен остаться отмеченным (checked = true)!"
        assert checklist_state["mandChecked"] is False, "Пункт 1 должен остаться неотмеченным!"
        print("  ✓ Все 3 пункта чек-листа на месте, пункт 2 корректно отмечен выполненным")
        tab_c.close()
        print("✅ ТЕСТ C ПРОЙДЕН: Чек-листы и их состояния надёжно сохраняются!")

        # -------------------------------------------------------------
        # Запускаем настоящий WebSocket-сервер для тестов D и E
        # -------------------------------------------------------------
        ws_proc = start_ws_server_process(WS_PORT, server_data_dir)
        print(f"\nСинхронизационный WebSocket-сервер запущен: ws://127.0.0.1:{WS_PORT}")

        # -------------------------------------------------------------
        # ТЕСТ D: 2 пользователя (Синхронизация в реальном времени)
        # -------------------------------------------------------------
        print("\n▶ [ТЕСТ D]: 2 пользователя (Синхронизация между двумя клиентами в реальном времени)")
        doc_id_d = f"test-collab-{secrets.token_hex(4)}"
        test_url_d = f"http://127.0.0.1:{HTTP_PORT}/index.html?doc={doc_id_d}&key=ny2027-friends&ws=ws://127.0.0.1:{WS_PORT}"

        tab_user1 = browser.open_tab(test_url_d)
        tab_user2 = browser.open_tab(test_url_d)

        # Ждём пока оба подключатся
        tab_user1.wait_for("window.appleNotesApp.syncClient && window.appleNotesApp.syncClient.status === 'synced'", timeout=10)
        tab_user2.wait_for("window.appleNotesApp.syncClient && window.appleNotesApp.syncClient.status === 'synced'", timeout=10)

        # Пользователь 1 пишет текст
        shared_text = f"Совместное предложение от Ильи {secrets.token_hex(3)}"
        tab_user1.eval(f"""
            (() => {{
                const app = window.appleNotesApp;
                const items = app.crdtDoc.getVisibleItems();
                const last = items[items.length - 1];
                app.crdtDoc.insertAfter(last ? last.id : 'ROOT@0', {json.dumps(shared_text)}, 'paragraph');
            }})()
        """)

        # Пользователь 2 должен мгновенно получить этот текст
        tab_user2.wait_for(f"document.getElementById('editor').innerText.includes({json.dumps(shared_text)})", timeout=5)
        print("  ✓ Текст Пользователя 1 появился на экране Пользователя 2 в реальном времени")

        # Пользователь 2 добавляет чек-лист и отмечает его
        tab_user2.eval("""
            (() => {
                const app = window.appleNotesApp;
                const items = app.crdtDoc.getVisibleItems();
                const last = items[items.length - 1];
                const task = app.crdtDoc.insertAfter(last.id, 'Купить бенгальские огни', 'task');
                app.crdtDoc.toggleTaskChecked(task.id, true);
            })()
        """)

        # Пользователь 1 должен получить этот чек-лист с активной галочкой
        tab_user1.wait_for("""
            (() => {
                const row = Array.from(document.querySelectorAll('.note-task-row')).find(r => r.innerText.includes('Купить бенгальские огни'));
                const cb = row ? row.querySelector('.apple-checkbox-input') : null;
                return cb && cb.checked;
            })()
        """, timeout=5)
        print("  ✓ Чек-лист Пользователя 2 с отметкой выполнен отобразился у Пользователя 1")
        
        tab_user1.close()
        tab_user2.close()
        print("✅ ТЕСТ D ПРОЙДЕН: Двусторонняя совместная работа работает безупречно!")

        # -------------------------------------------------------------
        # ТЕСТ E: Перезапуск сервера (Постоянство данных на диске)
        # -------------------------------------------------------------
        print("\n▶ [ТЕСТ E]: Перезапуск сервера (Постоянство на диске и продолжение работы)")
        doc_id_e = f"test-server-restart-{secrets.token_hex(4)}"
        test_url_e = f"http://127.0.0.1:{HTTP_PORT}/index.html?doc={doc_id_e}&key=ny2027-friends&ws=ws://127.0.0.1:{WS_PORT}"

        tab_e = browser.open_tab(test_url_e)
        tab_e.wait_for("window.appleNotesApp.syncClient && window.appleNotesApp.syncClient.status === 'synced'", timeout=10)

        restart_text = f"Важный текст до падения сервера {secrets.token_hex(3)}"
        tab_e.eval(f"""
            (() => {{
                const app = window.appleNotesApp;
                const items = app.crdtDoc.getVisibleItems();
                const last = items[items.length - 1];
                app.crdtDoc.insertAfter(last ? last.id : 'ROOT@0', {json.dumps(restart_text)}, 'paragraph');
            }})()
        """)
        time.sleep(0.5)

        # Перезапускаем сервер (останавливаем и поднимаем заново с тем же DB_FILE)
        print("  ... Перезапуск WebSocket-сервера ...")
        ws_proc.terminate()
        try:
            ws_proc.wait(timeout=3)
        except Exception:
            ws_proc.kill()
        time.sleep(0.4)

        # Поднимаем сервер снова на том же порту и каталоге
        ws_proc = start_ws_server_process(WS_PORT, server_data_dir)
        print("  ... Сервер успешно перезапущен ...")

        # Ждём автоматического переподключения исходного клиента к перезапущенному серверу
        tab_e.wait_for("window.appleNotesApp.syncClient && window.appleNotesApp.syncClient.status === 'synced'", timeout=12)
        print("  ✓ Исходный клиент успешно переподключился к перезапущенному серверу")

        # Открываем нового клиента на чистой вкладке
        tab_new_client = browser.open_tab(test_url_e)
        tab_new_client.wait_for("window.appleNotesApp.syncClient && window.appleNotesApp.syncClient.status === 'synced'", timeout=10)
        tab_new_client.wait_for(f"document.getElementById('editor').innerText.includes({json.dumps(restart_text)})", timeout=5)
        print("  ✓ Новый клиент получил сохранённый документ с перезапущенного сервера")

        # Проверяем, что синхронизация продолжается после перезапуска
        after_restart_text = f"Текст после перезапуска сервера {secrets.token_hex(3)}"
        
        state_e = tab_e.eval("({ status: window.appleNotesApp.syncClient?.status, wsReady: window.appleNotesApp.syncClient?.ws?.readyState, unacked: window.appleNotesApp.syncClient?.unacknowledgedOps?.size })")
        state_new = tab_new_client.eval("({ status: window.appleNotesApp.syncClient?.status, wsReady: window.appleNotesApp.syncClient?.ws?.readyState })")
        print(f"  [Debug] State before insert: tab_e={state_e}, tab_new={state_new}")

        tab_e.eval(f"""
            (() => {{
                const app = window.appleNotesApp;
                const items = app.crdtDoc.getVisibleItems();
                const last = items[items.length - 1];
                app.crdtDoc.insertAfter(last ? last.id : 'ROOT@0', {json.dumps(after_restart_text)}, 'paragraph');
            }})()
        """)

        time.sleep(1.0)
        print("  [Debug] tab_e visible items:", tab_e.eval("window.appleNotesApp.crdtDoc.getVisibleItems().map(i => i.content)"))
        print("  [Debug] tab_new visible items:", tab_new_client.eval("window.appleNotesApp.crdtDoc.getVisibleItems().map(i => i.content)"))
        print("  [Debug] tab_new DOM text:", tab_new_client.eval("document.getElementById('editor').innerText"))

        tab_new_client.wait_for(f"document.getElementById('editor').innerText.includes({json.dumps(after_restart_text)})", timeout=8)
        print("  ✓ Синхронизация между клиентами продолжается после перезапуска сервера")

        tab_e.close()
        tab_new_client.close()
        print("✅ ТЕСТ E ПРОЙДЕН: Постоянство данных при перезапуске сервера подтверждено!")

        print("\n" + "=" * 70)
        print("🎉 ВСЕ 5 ОБЯЗАТЕЛЬНЫХ ТЕСТОВ (A, B, C, D, E) УСПЕШНО ПРОЙДЕНЫ В РЕАЛЬНОМ БРАУЗЕРЕ!")
        print("=" * 70)

    finally:
        browser.stop()
        http_proc.terminate()
        try:
            http_proc.wait(timeout=2)
        except Exception:
            pass
        if ws_proc:
            try:
                ws_proc.terminate()
                ws_proc.wait(timeout=2)
            except Exception:
                pass
        import shutil
        shutil.rmtree(server_data_dir, ignore_errors=True)

if __name__ == '__main__':
    run_tests()
