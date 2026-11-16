"""
Проверка опубликованной версии https://ilyaflexer228.github.io/noites/
в реальном браузере через Chrome DevTools Protocol:
1. Открытие опубликованного сайта
2. Ctrl+A -> Backspace -> проверка очистки
3. F5 -> проверка сохранения пустого состояния (шаблон не вернулся)
4. Ввод нового текста -> F5 -> проверка сохранения нового текста
"""

import os
import sys
import time
import secrets
import urllib.request
import json
import subprocess
import tempfile

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

sys.path.insert(0, os.path.dirname(__file__))
from test_browser_persistence import find_browser, BrowserController, CDP_PORT

def test_live():
    print("=" * 70)
    print("🌐 ТЕСТИРОВАНИЕ ОПУБЛИКОВАННОГО САЙТА GITHUB PAGES")
    print("=" * 70)

    browser_exe = find_browser()
    browser = BrowserController(browser_exe, CDP_PORT)
    browser.start()

    try:
        doc_id = f"live-test-{secrets.token_hex(4)}"
        live_url = f"https://ilyaflexer228.github.io/noites/?doc={doc_id}"
        print(f"Открываем URL: {live_url}")
        
        tab = browser.open_tab(live_url)
        initial_text = tab.get_text_content()
        assert "Наши планы на Новый год" in initial_text, "Шаблон должен открыться при первом визите"
        print("  ✓ Опубликованный сайт загружен, исходный шаблон отображается")

        # 1. Выделяем всё через Ctrl+A и удаляем через Backspace
        print("  ... Нажимаем Ctrl+A и Backspace ...")
        tab.focus_editor()
        tab.select_all()
        tab.press_backspace()
        time.sleep(0.4)

        # 2. Проверяем, что DOM пуст
        empty_dom = tab.get_text_content().strip()
        assert empty_dom == "", f"DOM должен быть пуст, но содержит: '{empty_dom}'"
        print("  ✓ DOM на опубликованном сайте полностью очищен")

        # 3. Перезагружаем страницу через F5
        print("  ... Перезагружаем страницу F5 ...")
        tab.reload()
        reloaded_text = tab.get_text_content().strip()
        assert reloaded_text == "", f"После F5 старый текст вернулся: '{reloaded_text}'"
        print("  ✓ После F5 старый текст и новогодний шаблон НЕ вернулись!")

        # 4. Пишем новый текст
        new_text = f"Проверка на GitHub Pages {secrets.token_hex(3)}"
        print(f"  ... Печатаем новый текст: '{new_text}' ...")
        tab.focus_editor()
        tab.type_text(new_text)
        time.sleep(0.4)
        assert new_text in tab.get_text_content(), "Новый текст не появился в DOM"

        # 5. Перезагружаем F5 и проверяем сохранение нового текста
        print("  ... Перезагружаем страницу F5 второй раз ...")
        tab.reload()
        reloaded_new = tab.get_text_content()
        assert new_text in reloaded_new, f"Новый текст потерялся после F5: '{reloaded_new}'"
        assert "Наши планы на Новый год" not in reloaded_new, "Шаблон вернулся вместо нового текста!"
        print(f"  ✓ После повторного F5 сохранился исключительно новый текст: '{new_text}'")

        tab.close()
        print("\n" + "=" * 70)
        print("🎉 ТЕСТ НА ОПУБЛИКОВАННОМ САЙТЕ GITHUB PAGES УСПЕШНО ПРОЙДЕН 100%!")
        print("=" * 70)

    finally:
        browser.stop()

if __name__ == '__main__':
    test_live()
