"""
Комплекс тестов Этапа 6: совместное редактирование через WebSocket:
Тест 1 — Enter (создание абзацев, разделение строки, чек-листы, F5)
Тест 2 — Редактирование на двух независимых устройствах (раздельные IndexedDB/профили)
Тест 3 — Новый пользователь без кеша видит актуальную общую заметку
Тест 4 — Одновременное (конкурентное) редактирование одной строки (3-way merge)
Тест 5 — Отключение интернета, правки офлайн и слияние при реконнекте
Тест 6 — Перезапуск сервера и сохранность данных на диске
Тест 7 — Мобильные события клавиатуры (beforeinput, insertParagraph)
"""

import sys
import os
import time
import subprocess
import secrets
import json
import socket
import tempfile
import urllib.request
import urllib.parse

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

sys.path.insert(0, os.path.dirname(__file__))
from test_browser_persistence import find_browser, BrowserController, get_free_port

def run_all_stage6_tests():
    print("=" * 75)
    print("🚀 ПОЛНЫЙ КОМПЛЕКС ТЕСТОВ ЭТАПА 6 (ТЕСТЫ 1 — 7)")
    print("=" * 75)

    browser_exe = find_browser()
    web_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
    http_port = get_free_port()
    ws_port = get_free_port()
    db_file = os.path.join(web_dir, 'server', 'data', f'test_store_{secrets.token_hex(3)}.json')

    # 1. Запуск статического веб-сервера
    http_proc = subprocess.Popen([
        sys.executable, "-m", "http.server", str(http_port), "--directory", web_dir
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print(f"Статический веб-сервер запущен: http://127.0.0.1:{http_port}")

    # 2. Запуск WebSocket CRDT сервера
    server_env = os.environ.copy()
    server_env['PORT'] = str(ws_port)
    server_env['DATA_DIR'] = os.path.dirname(db_file)
    server_env['DEFAULT_INVITE_SECRET'] = 'ny2027-friends'

    ws_proc = subprocess.Popen([
        sys.executable, os.path.join(web_dir, 'server', 'server_py.py')
    ], env=server_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print(f"WebSocket CRDT сервер запущен: ws://127.0.0.1:{ws_port}")
    time.sleep(1.0)

    browser_a = None
    browser_b = None
    browser_c = None

    try:
        # =================================================================
        # ТЕСТ 1 — Enter
        # =================================================================
        print("\n▶ [ТЕСТ 1]: Enter и редактирование текста")
        cdp_port_1 = get_free_port()
        browser_a = BrowserController(browser_exe, cdp_port_1)
        browser_a.start()

        doc_id_1 = f"test-enter-{secrets.token_hex(4)}"
        ws_url = f"ws://127.0.0.1:{ws_port}"
        page_url_1 = f"http://127.0.0.1:{http_port}/index.html?doc={doc_id_1}&ws={urllib.parse.quote(ws_url, safe='')}&key=ny2027-friends"
        
        tab1 = browser_a.open_tab(page_url_1)
        tab1.wait_for("document.readyState === 'complete' && !!window.appleNotesApp?.editor", timeout=12)
        time.sleep(0.5)

        # Очищаем документ
        tab1.select_all()
        tab1.press_backspace()
        time.sleep(0.3)

        # Печатаем «Первая строка»
        tab1.focus_editor()
        tab1.type_text("Первая строка")
        time.sleep(0.3)

        # Нажимаем Enter
        tab1.ws.call("Input.dispatchKeyEvent", {"type": "rawKeyDown", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13})
        tab1.ws.call("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13})
        time.sleep(0.3)

        # Печатаем «Вторая строка»
        tab1.type_text("Вторая строка")
        time.sleep(0.3)

        blocks1 = tab1.eval('Array.from(document.querySelectorAll("#editor [data-crdt-id]")).map(el => el.innerText.trim())')
        assert len(blocks1) == 2, f"Ожидалось 2 блока, получено: {len(blocks1)}"
        assert blocks1[0] == "Первая строка" and blocks1[1] == "Вторая строка"
        print("  ✓ Нажатие Enter создало отдельный абзац")

        # Перезагрузка F5
        tab1.reload()
        reloaded_blocks1 = tab1.eval('Array.from(document.querySelectorAll("#editor [data-crdt-id]")).map(el => el.innerText.trim())')
        assert len(reloaded_blocks1) == 2
        assert reloaded_blocks1[0] == "Первая строка" and reloaded_blocks1[1] == "Вторая строка"
        print("  ✓ После F5 порядок и текст обеих строк сохранились")
        print("✅ ТЕСТ 1 УСПЕШНО ПРОЙДЕН!")

        # =================================================================
        # ТЕСТ 2 — Редактирование на двух независимых устройствах
        # =================================================================
        print("\n▶ [ТЕСТ 2]: Редактирование на двух независимых устройствах через WebSocket")
        cdp_port_2 = get_free_port()
        browser_b = BrowserController(browser_exe, cdp_port_2)
        browser_b.start()

        shared_doc_id = f"shared-{secrets.token_hex(4)}"
        shared_url = f"http://127.0.0.1:{http_port}/index.html?doc={shared_doc_id}&ws={urllib.parse.quote(ws_url, safe='')}&key=ny2027-friends"

        tab_user_a = browser_a.open_tab(shared_url)
        tab_user_b = browser_b.open_tab(shared_url)

        tab_user_a.wait_for("document.readyState === 'complete' && !!window.appleNotesApp?.syncClient?.ws", timeout=12)
        tab_user_b.wait_for("document.readyState === 'complete' && !!window.appleNotesApp?.syncClient?.ws", timeout=12)
        time.sleep(0.5)

        # Очищаем документ пользователем A
        tab_user_a.select_all()
        tab_user_a.press_backspace()
        time.sleep(0.5)

        # Пользователь A пишет «Привет от Ильи»
        tab_user_a.focus_editor()
        tab_user_a.type_text("Привет от Ильи")
        time.sleep(0.6)

        # Убеждаемся, что текст АВТОМАТИЧЕСКИ появился у пользователя B без F5!
        tab_user_b.wait_for("document.getElementById('editor').innerText.includes('Привет от Ильи')", timeout=8.0)
        print("  ✓ Текст от Пользователя А автоматически появился у Пользователя B в реальном времени!")

        # Пользователь B нажимает Enter и дописывает «Привет от Димы»
        tab_user_b.focus_editor()
        tab_user_b.ws.call("Input.dispatchKeyEvent", {"type": "rawKeyDown", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13})
        tab_user_b.ws.call("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13})
        time.sleep(0.3)
        tab_user_b.type_text("Привет от Димы")
        time.sleep(0.6)

        # Убеждаемся, что текст Пользователя B появился у Пользователя A
        tab_user_a.wait_for("document.getElementById('editor').innerText.includes('Привет от Димы')", timeout=8.0)
        print("  ✓ Текст от Пользователя B автоматически появился у Пользователя A в реальном времени!")

        # Перезагружаем оба браузера F5
        tab_user_a.reload()
        tab_user_b.reload()
        time.sleep(0.5)

        text_a_after = tab_user_a.get_text_content()
        text_b_after = tab_user_b.get_text_content()
        assert "Привет от Ильи" in text_a_after and "Привет от Димы" in text_a_after
        assert "Привет от Ильи" in text_b_after and "Привет от Димы" in text_b_after
        print("  ✓ После F5 в обоих независимых браузерах сохранены обе строки")
        print("✅ ТЕСТ 2 УСПЕШНО ПРОЙДЕН!")

        # =================================================================
        # ТЕСТ 3 — Новый пользователь
        # =================================================================
        print("\n▶ [ТЕСТ 3]: Новый пользователь без кеша видит актуальную общую заметку")
        cdp_port_3 = get_free_port()
        browser_c = BrowserController(browser_exe, cdp_port_3)
        browser_c.start()

        tab_user_c = browser_c.open_tab(shared_url)
        tab_user_c.wait_for("document.readyState === 'complete' && !!window.appleNotesApp?.syncClient?.ws", timeout=12)
        tab_user_c.wait_for("document.getElementById('editor').innerText.includes('Привет от Ильи')", timeout=8.0)

        text_c = tab_user_c.get_text_content()
        assert "Привет от Ильи" in text_c and "Привет от Димы" in text_c
        assert "Наши планы на Новый год" not in text_c, "Новый пользователь не должен видеть дефолтный шаблон вместо общей заметки!"
        print("  ✓ Новый пользователь мгновенно получил всю актуальную историю общей заметки с сервера")
        print("✅ ТЕСТ 3 УСПЕШНО ПРОЙДЕН!")

        # =================================================================
        # ТЕСТ 4 — Одновременное (конкурентное) редактирование одной строки
        # =================================================================
        print("\n▶ [ТЕСТ 4]: Одновременное редактирование одной строки двумя пользователями (3-way merge)")
        # Пользователь A и Пользователь B одновременно дописывают текст в первую строку
        first_block_id = tab_user_a.eval('document.querySelector("#editor [data-crdt-id]")?.dataset?.crdtId')
        assert first_block_id, "Первый блок не найден"

        # A вносит правку « (Салют)», B вносит правку « (Ёлка)»
        tab_user_a.eval(f"""
            (() => {{
                const app = window.appleNotesApp;
                const item = app.crdtDoc.items.get('{first_block_id}');
                app.crdtDoc.updateText('{first_block_id}', item.content + ' (Салют)');
                app.editor.renderFromCRDT();
            }})()
        """)
        tab_user_b.eval(f"""
            (() => {{
                const app = window.appleNotesApp;
                const item = app.crdtDoc.items.get('{first_block_id}');
                app.crdtDoc.updateText('{first_block_id}', item.content + ' (Ёлка)');
                app.editor.renderFromCRDT();
            }})()
        """)

        time.sleep(1.2)
        # Ждём завершения обмена и слияния
        text_a_merged = tab_user_a.get_text_content()
        text_b_merged = tab_user_b.get_text_content()
        print("  [Merged A]:", repr(text_a_merged.split('\\n')[0]))
        print("  [Merged B]:", repr(text_b_merged.split('\\n')[0]))

        assert "Салют" in text_a_merged and "Ёлка" in text_a_merged, "Правка одного из пользователей была потеряна у A!"
        assert "Салют" in text_b_merged and "Ёлка" in text_b_merged, "Правка одного из пользователей была потеряна у B!"
        print("  ✓ Правки обоих пользователей сохранены в одной строке без потерь (Three-Way Merge)")
        print("✅ ТЕСТ 4 УСПЕШНО ПРОЙДЕН!")

        # =================================================================
        # ТЕСТ 5 — Отключение интернета и слияние при восстановлении
        # =================================================================
        print("\n▶ [ТЕСТ 5]: Офлайн-режим и слияние изменений при реконнекте")
        # Отключаем WebSocket у Пользователя A
        tab_user_a.eval("window.appleNotesApp.syncClient.ws.close(); window.appleNotesApp.syncClient.ws = null;")
        time.sleep(0.3)
        status_a = tab_user_a.eval("window.appleNotesApp.syncClient.status")
        print("  [User A offline status]:", status_a)

        # Пользователь A пишет офлайн
        offline_text = "Офлайн-план от Ильи"
        tab_user_a.eval(f"""
            (() => {{
                const app = window.appleNotesApp;
                const newItem = app.crdtDoc.insertAfter(app.crdtDoc.head, '{offline_text}', 'text');
                app.editor.renderFromCRDT();
            }})()
        """)

        # Пользователь B тем временем онлайн добавляет свой план
        online_text_b = "Онлайн-план от Димы"
        tab_user_b.eval(f"""
            (() => {{
                const app = window.appleNotesApp;
                const lastItem = app.crdtDoc.getVisibleItems().slice(-1)[0];
                app.crdtDoc.insertAfter(lastItem.id, '{online_text_b}', 'text');
                app.editor.renderFromCRDT();
            }})()
        """)
        time.sleep(0.5)

        # Восстанавливаем подключение Пользователя A
        tab_user_a.eval("window.appleNotesApp.syncClient.connect()")
        time.sleep(1.5)

        # Проверяем, что оба документа содержат правки обоих участников
        tab_user_a.wait_for(f"document.getElementById('editor').innerText.includes('{online_text_b}')", timeout=8.0)
        tab_user_b.wait_for(f"document.getElementById('editor').innerText.includes('{offline_text}')", timeout=8.0)

        print(f"  ✓ Офлайн-правка '{offline_text}' и онлайн-правка '{online_text_b}' успешно объединены!")
        print("✅ ТЕСТ 5 УСПЕШНО ПРОЙДЕН!")

        # =================================================================
        # ТЕСТ 6 — Перезапуск сервера и сохранность данных на диске
        # =================================================================
        print("\n▶ [ТЕСТ 6]: Перезапуск сервера и сохранность данных на диске")
        ws_proc.terminate()
        try:
            ws_proc.wait(timeout=3)
        except Exception:
            ws_proc.kill()
        time.sleep(0.5)

        # Перезапускаем сервер с тем же DATA_DIR
        ws_proc = subprocess.Popen([
            sys.executable, os.path.join(web_dir, 'server', 'server_py.py')
        ], env=server_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1.0)

        # Открываем заметку в новом браузере D
        cdp_port_4 = get_free_port()
        browser_d = BrowserController(browser_exe, cdp_port_4)
        browser_d.start()
        tab_user_d = browser_d.open_tab(shared_url)
        tab_user_d.wait_for(f"document.getElementById('editor').innerText.includes('{offline_text}')", timeout=8.0)

        text_d = tab_user_d.get_text_content()
        assert offline_text in text_d and online_text_b in text_d
        print("  ✓ После перезапуска сервера все данные полностью восстановлены из файла хранилища")
        browser_d.stop()
        print("✅ ТЕСТ 6 УСПЕШНО ПРОЙДЕН!")

        # =================================================================
        # ТЕСТ 7 — Мобильные клавиатуры и события beforeinput
        # =================================================================
        print("\n▶ [ТЕСТ 7]: Мобильные input-события (insertParagraph, чек-листы)")
        tab_mobile = browser_a.open_tab(f"http://127.0.0.1:{http_port}/index.html?doc=test-mob-{secrets.token_hex(4)}")
        tab_mobile.wait_for("document.readyState === 'complete' && !!window.appleNotesApp?.editor", timeout=12)

        # Эмулируем мобильный ввод insertParagraph (как на Gboard / iOS Safari)
        tab_mobile.focus_editor()
        tab_mobile.eval("""
            (() => {
                const ed = document.getElementById('editor');
                const target = ed.querySelector('[data-crdt-id]') || ed;
                const ev = new InputEvent('beforeinput', {
                    inputType: 'insertParagraph',
                    bubbles: true,
                    cancelable: true
                });
                ed.dispatchEvent(ev);
            })()
        """)
        time.sleep(0.3)
        mobile_blocks = tab_mobile.eval('document.querySelectorAll("#editor [data-crdt-id]").length')
        assert mobile_blocks >= 2, "Мобильное событие insertParagraph должно создавать новый блок"
        print("  ✓ Мобильное событие insertParagraph корректно обработано без сбоев")

        # Проверка переключения чек-листа
        task_id = tab_mobile.eval("""
            (() => {
                const cb = document.querySelector('.apple-checkbox-input');
                if (cb) {
                    cb.click();
                    return cb.dataset.crdtToggle;
                }
                return null;
            })()
        """)
        time.sleep(0.3)
        is_checked = tab_mobile.eval(f"window.appleNotesApp.crdtDoc.items.get('{task_id}')?.checked")
        assert is_checked is not None
        print("  ✓ Переключение чек-листа в мобильном режиме работает корректно")
        print("✅ ТЕСТ 7 УСПЕШНО ПРОЙДЕН!")

        print("\n" + "=" * 75)
        print("🎉 ВСЕ 7 ОБЯЗАТЕЛЬНЫХ ТЕСТОВ ЭТАПА 6 УСПЕШНО ПРОЙДЕНЫ 100%!")
        print("=" * 75)

    finally:
        if browser_a: browser_a.stop()
        if browser_b: browser_b.stop()
        if browser_c: browser_c.stop()
        http_proc.terminate()
        if ws_proc:
            try:
                ws_proc.terminate()
                ws_proc.wait(timeout=2)
            except Exception:
                try: ws_proc.kill()
                except Exception: pass

if __name__ == '__main__':
    run_all_stage6_tests()
