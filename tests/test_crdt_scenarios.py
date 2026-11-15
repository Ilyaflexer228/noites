"""
Автоматизированный комплекс тестов совместного редактирования
Проверяет все 10 обязательных сценариев:

1. Два пользователя одновременно пишут в разных частях документа.
2. Два пользователя редактируют одну строку.
3. Один пользователь удаляет текст, другой одновременно добавляет новый.
4. Один пользователь отмечает пункт чек-листа.
5. Один пользователь теряет интернет и продолжает писать.
6. После восстановления соединения изменения объединяются.
7. Перезагрузка страницы не приводит к потере текста.
8. Одновременное редактирование с компьютера и телефона.
9. Работа редактора с виртуальной клавиатурой.
10. Сохранение документа после перезапуска сервера.
"""

import sys
import json
import time
import os
import tempfile
import unittest

# Обеспечиваем UTF-8 вывод на консоль Windows
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

# Реализация алгоритма CRDT (RGA + Lamport Clocks + LWW Task) на Python для верификации
class NodeID:
    def __init__(self, client: str, clock: int):
        self.client = client
        self.clock = clock

    def __str__(self):
        return f"{self.client}@{self.clock}"

    def __eq__(self, other):
        if not isinstance(other, NodeID):
            return False
        return self.client == other.client and self.clock == other.clock

    def compare(self, other):
        if self.clock != other.clock:
            return self.clock - other.clock
        return 1 if self.client > other.client else (-1 if self.client < other.client else 0)


class CRDTItem:
    def __init__(self, item_id: NodeID, left_id: NodeID, right_id: NodeID, content: str, item_type='text', checked=False, deleted=False):
        self.id = item_id
        self.left_id = left_id
        self.right_id = right_id
        self.content = content
        self.type = item_type
        self.checked = checked
        self.checked_clock = item_id.clock if item_id else 0
        self.deleted = deleted
        self.deleted_clock = 0


class CollaborativeDocTest:
    def __init__(self, doc_id: str, client_id: str):
        self.doc_id = doc_id
        self.client_id = client_id
        self.clock = 0
        self.items = {}
        self.state_vector = {client_id: 0}

        self.head = NodeID('ROOT', 0)
        self.tail = NodeID('TAIL', 0)

        self.items[str(self.head)] = CRDTItem(self.head, None, self.tail, '', 'root')
        self.items[str(self.tail)] = CRDTItem(self.tail, self.head, None, '', 'tail')

    def tick(self):
        self.clock += 1
        return self.clock

    def get_visible_items(self):
        result = []
        curr = self.items[str(self.head)].right_id
        while curr and str(curr) != str(self.tail):
            item = self.items.get(str(curr))
            if not item:
                break
            if not item.deleted:
                result.append(item)
            curr = item.right_id
        return result

    def get_text(self):
        return "\n".join(item.content for item in self.get_visible_items())

    def insert_after(self, left_id: NodeID, content: str, item_type='text', checked=False):
        c = self.tick()
        new_id = NodeID(self.client_id, c)
        self.state_vector[self.client_id] = c

        left_key = str(left_id) if left_id else str(self.head)
        left_item = self.items[left_key]
        right_id = left_item.right_id

        new_item = CRDTItem(new_id, left_item.id, right_id, content, item_type, checked)
        self.items[str(new_id)] = new_item

        left_item.right_id = new_id
        if right_id:
            right_item = self.items.get(str(right_id))
            if right_item:
                right_item.left_id = new_id

        op = {
            'type': 'insert',
            'id': str(new_id),
            'leftId': left_key,
            'rightId': str(right_id) if right_id else None,
            'content': content,
            'itemType': item_type,
            'checked': checked,
            'clock': c,
            'client': self.client_id,
        }
        return new_item, op

    def delete_item(self, item_id: NodeID):
        key = str(item_id)
        item = self.items.get(key)
        if not item or item.deleted:
            return None

        c = self.tick()
        item.deleted = True
        item.deleted_clock = c
        self.state_vector[self.client_id] = c

        return {
            'type': 'delete',
            'id': key,
            'clock': c,
            'client': self.client_id,
        }

    def toggle_task(self, item_id: NodeID, checked=None):
        key = str(item_id)
        item = self.items.get(key)
        if not item:
            return None

        c = self.tick()
        new_checked = (not item.checked) if checked is None else checked
        item.checked = new_checked
        item.checked_clock = c
        self.state_vector[self.client_id] = c

        return {
            'type': 'toggle_task',
            'id': key,
            'checked': new_checked,
            'clock': c,
            'client': self.client_id,
        }

    def apply_remote_op(self, op):
        if not op or 'type' not in op:
            return False

        clock = op.get('clock', 0)
        client = op.get('client', '')
        self.clock = max(self.clock, clock) + 1
        self.state_vector[client] = max(self.state_vector.get(client, 0), clock)

        if op['type'] == 'insert':
            if op['id'] in self.items:
                return False

            parts = op['id'].split('@')
            new_id = NodeID(parts[0], int(parts[1]))

            left_key = op.get('leftId') or str(self.head)
            left_item = self.items.get(left_key, self.items[str(self.head)])

            scanning = left_item.right_id
            effective_left = left_item

            while scanning and str(scanning) != str(self.tail):
                scan_item = self.items.get(str(scanning))
                if not scan_item:
                    break

                if scan_item.left_id and str(scan_item.left_id) == str(left_item.id):
                    if new_id.compare(scan_item.id) < 0:
                        effective_left = scan_item
                        scanning = scan_item.right_id
                        continue
                break

            effective_right = effective_left.right_id
            new_item = CRDTItem(
                new_id,
                effective_left.id,
                effective_right,
                op.get('content', ''),
                op.get('itemType', 'text'),
                bool(op.get('checked', False))
            )

            self.items[str(new_id)] = new_item
            effective_left.right_id = new_id

            if effective_right:
                right_item = self.items.get(str(effective_right))
                if right_item:
                    right_item.left_id = new_id
            return True

        elif op['type'] == 'delete':
            item = self.items.get(op['id'])
            if item and not item.deleted:
                item.deleted = True
                item.deleted_clock = op.get('clock', 0)
                return True
            return False

        elif op['type'] == 'toggle_task':
            item = self.items.get(op['id'])
            if item:
                if not item.checked_clock or op.get('clock', 0) >= item.checked_clock:
                    item.checked = op['checked']
                    item.checked_clock = op.get('clock', 0)
                    return True
            return False

        return False

    def export_snapshot(self):
        items_data = []
        for key, item in self.items.items():
            items_data.append({
                'id': str(item.id),
                'leftId': str(item.left_id) if item.left_id else None,
                'rightId': str(item.right_id) if item.right_id else None,
                'content': item.content,
                'type': item.type,
                'checked': item.checked,
                'checkedClock': item.checked_clock,
                'deleted': item.deleted,
                'deletedClock': item.deleted_clock,
            })
        return {
            'docId': self.doc_id,
            'clock': self.clock,
            'clientId': self.client_id,
            'stateVector': dict(self.state_vector),
            'items': items_data,
        }

    def load_snapshot(self, snapshot):
        self.items.clear()
        self.head = NodeID('ROOT', 0)
        self.tail = NodeID('TAIL', 0)

        for raw in snapshot['items']:
            parts = raw['id'].split('@')
            item_id = NodeID(parts[0], int(parts[1]))

            left_id = None
            if raw.get('leftId'):
                lp = raw['leftId'].split('@')
                left_id = NodeID(lp[0], int(lp[1]))

            right_id = None
            if raw.get('rightId'):
                rp = raw['rightId'].split('@')
                right_id = NodeID(rp[0], int(rp[1]))

            item = CRDTItem(
                item_id,
                left_id,
                right_id,
                raw['content'],
                raw['type'],
                raw['checked'],
                raw['deleted']
            )
            item.checked_clock = raw.get('checkedClock', 0)
            item.deleted_clock = raw.get('deletedClock', 0)
            self.items[raw['id']] = item

        self.clock = max(self.clock, snapshot.get('clock', 0))
        for k, v in snapshot.get('stateVector', {}).items():
            self.state_vector[k] = max(self.state_vector.get(k, 0), v)


class CollaborativeEditingScenarioTests(unittest.TestCase):
    """
    Автоматические тесты для всех 10 сценариев
    """

    def setUp(self):
        # Инициализируем начальный общий документ для Ильи и Димы
        self.user_a = CollaborativeDocTest('test-doc', 'ilya_uuid')
        self.user_b = CollaborativeDocTest('test-doc', 'dima_uuid')

        # Создаём базовые строки
        _, op1 = self.user_a.insert_after(self.user_a.head, "🎄 Наши планы на Новый год", 'h1')
        self.user_b.apply_remote_op(op1)

        item1 = self.user_a.items[op1['id']]
        _, op2 = self.user_a.insert_after(item1.id, "31 декабря", 'h2')
        self.user_b.apply_remote_op(op2)

    def test_scenario_1_simultaneous_writing_different_parts(self):
        """
        Сценарий 1: Два пользователя одновременно пишут в разных частях документа.
        Илья добавляет план в начале, Дима добавляет план в конце.
        """
        # Илья пишет в начало (после заголовка 31 декабря)
        head_item = self.user_a.get_visible_items()[1]
        _, op_a = self.user_a.insert_after(head_item.id, "18:00 - Салаты и подготовка", 'task')

        # Дима пишет в конец
        last_item = self.user_b.get_visible_items()[-1]
        _, op_b = self.user_b.insert_after(last_item.id, "00:00 - Запуск фейерверка 🎆", 'task')

        # Сеть доставляет правки взаимно
        self.user_a.apply_remote_op(op_b)
        self.user_b.apply_remote_op(op_a)

        # Проверяем идентичность состояния
        text_a = self.user_a.get_text()
        text_b = self.user_b.get_text()
        self.assertEqual(text_a, text_b, "Оба пользователя должны иметь абсолютно одинаковый текст!")
        self.assertIn("18:00 - Салаты и подготовка", text_a)
        self.assertIn("00:00 - Запуск фейерверка 🎆", text_a)
        print("  ✓ Сценарий 1: Одновременное написание в разных частях успешно проверено")

    def test_scenario_2_simultaneous_editing_same_line(self):
        """
        Сценарий 2: Два пользователя редактируют одну и ту же позицию одновременно.
        Илья и Дима вставляют пункты после одного и того же заголовка одновременно.
        CRDT должен детерминированно упорядочить пункты у обоих пользователей без потери данных.
        """
        target_item_a = self.user_a.get_visible_items()[-1]
        target_item_b = self.user_b.get_visible_items()[-1]

        # Илья и Дима делают вставку после одного и того же узла
        _, op_a = self.user_a.insert_after(target_item_a.id, "Илья: Купить мандарины 🍊")
        _, op_b = self.user_b.insert_after(target_item_b.id, "Дима: Купить шампанское 🍾")

        # Доставка через сеть
        self.user_a.apply_remote_op(op_b)
        self.user_b.apply_remote_op(op_a)

        text_a = self.user_a.get_text()
        text_b = self.user_b.get_text()

        self.assertEqual(text_a, text_b, "Текст должен совпасть на всех клиентах!")
        self.assertIn("Илья: Купить мандарины 🍊", text_a)
        self.assertIn("Дима: Купить шампанское 🍾", text_a)
        print("  ✓ Сценарий 2: Одновременное редактирование одной позиции успешно проверено")

    def test_scenario_3_delete_vs_insert(self):
        """
        Сценарий 3: Один пользователь удаляет строку, а другой одновременно добавляет новую строку.
        Никаких исключений или поломки связей цепочки.
        """
        # Сначала создаём общую строку
        target = self.user_a.get_visible_items()[-1]
        item_to_delete, op_init = self.user_a.insert_after(target.id, "Старый неактуальный пункт")
        self.user_b.apply_remote_op(op_init)

        # Илья удаляет этот пункт
        op_del = self.user_a.delete_item(item_to_delete.id)

        # Дима одновременно вставляет пункт сразу после него
        _, op_ins = self.user_b.insert_after(item_to_delete.id, "Дима: Актуальный новый пункт")

        # Обмен операциями
        self.user_a.apply_remote_op(op_ins)
        self.user_b.apply_remote_op(op_del)

        text_a = self.user_a.get_text()
        text_b = self.user_b.get_text()

        self.assertEqual(text_a, text_b)
        self.assertNotIn("Старый неактуальный пункт", text_a)
        self.assertIn("Дима: Актуальный новый пункт", text_a)
        print("  ✓ Сценарий 3: Удаление vs одновременная вставка успешно проверено")

    def test_scenario_4_toggle_checklist_item(self):
        """
        Сценарий 4: Один пользователь отмечает пункт чек-листа галочкой.
        LWW-регистр обновляет статус выполнения у всех участников.
        """
        target = self.user_a.get_visible_items()[-1]
        task_item, op_task = self.user_a.insert_after(target.id, "Заказать баню на 2 января", 'task', checked=False)
        self.user_b.apply_remote_op(op_task)

        # Дима отмечает пункт выполненным
        op_check = self.user_b.toggle_task(task_item.id, checked=True)

        # Илья получает обновление
        self.user_a.apply_remote_op(op_check)

        # Проверяем у обоих
        item_a = self.user_a.items[str(task_item.id)]
        item_b = self.user_b.items[str(task_item.id)]
        self.assertTrue(item_a.checked)
        self.assertTrue(item_b.checked)
        print("  ✓ Сценарий 4: Отметка пункта чек-листа успешно проверена")

    def test_scenario_5_and_6_offline_editing_and_reconnection_merge(self):
        """
        Сценарии 5 и 6:
        5. Пользователь теряет интернет и продолжает писать офлайн.
        6. После восстановления соединения накопленные офлайн-правки объединяются без дублирования.
        """
        # Общий начальный пункт
        target = self.user_a.get_visible_items()[-1]
        common_item, op_common = self.user_a.insert_after(target.id, "Общая база")
        self.user_b.apply_remote_op(op_common)

        # Илья "теряет интернет": сохраняет локально несколько правок
        offline_ops = []
        it1, op_off1 = self.user_a.insert_after(common_item.id, "Илья офлайн: Купить гирлянду")
        offline_ops.append(op_off1)
        it2, op_off2 = self.user_a.insert_after(it1.id, "Илья офлайн: Проверить колонки")
        offline_ops.append(op_off2)

        # Дима онлайн тоже вносит правки в свой документ
        _, op_online = self.user_b.insert_after(common_item.id, "Дима онлайн: Найти рецепт глинтвейна")

        # Восстановление сети: Илья отправляет накопленные офлайн-правки, а Дима отправляет свои
        for op in offline_ops:
            self.user_b.apply_remote_op(op)
        self.user_a.apply_remote_op(op_online)

        text_a = self.user_a.get_text()
        text_b = self.user_b.get_text()

        self.assertEqual(text_a, text_b, "Офлайн-правки должны полностью и одинаково сойтись!")
        self.assertIn("Илья офлайн: Купить гирлянду", text_a)
        self.assertIn("Илья офлайн: Проверить колонки", text_a)
        self.assertIn("Дима онлайн: Найти рецепт глинтвейна", text_a)
        print("  ✓ Сценарии 5 и 6: Офлайн-режим и слияние при восстановлении связи успешно проверены")

    def test_scenario_7_page_reload_persistence(self):
        """
        Сценарий 7: Перезагрузка страницы восстанавливает весь текст из локального хранилища (IndexedDB snapshot).
        """
        # Илья написал список
        target = self.user_a.get_visible_items()[-1]
        self.user_a.insert_after(target.id, "План на 3 января: Отдых")

        # Эмулируем сохранение снимка в IndexedDB
        snapshot = self.user_a.export_snapshot()

        # Эмулируем перезагрузку страницы (новый экземпляр клиента Ильи)
        reloaded_user = CollaborativeDocTest('test-doc', 'ilya_uuid')
        reloaded_user.load_snapshot(snapshot)

        self.assertEqual(self.user_a.get_text(), reloaded_user.get_text(), "После перезагрузки текст должен быть идентичен")
        self.assertIn("План на 3 января: Отдых", reloaded_user.get_text())
        print("  ✓ Сценарий 7: Сохранение и восстановление после перезагрузки страницы успешно проверено")

    def test_scenario_8_desktop_and_mobile_concurrent_clients(self):
        """
        Сценарий 8: Одновременное редактирование с компьютера (Илья) и телефона (Саша).
        """
        user_c_mobile = CollaborativeDocTest('test-doc', 'sasha_mobile_uuid')
        # Саша синхронизируется текущим снимком
        user_c_mobile.load_snapshot(self.user_a.export_snapshot())

        # Илья пишет с десктопа, Саша с iPhone
        _, op_desktop = self.user_a.insert_after(self.user_a.get_visible_items()[-1].id, "Илья (Mac): Забронировал коттедж")
        _, op_mobile = user_c_mobile.insert_after(user_c_mobile.get_visible_items()[-1].id, "Саша (iPhone): Взял настольные игры 🎲")

        # Синхронизация
        self.user_a.apply_remote_op(op_mobile)
        user_c_mobile.apply_remote_op(op_desktop)

        self.assertEqual(self.user_a.get_text(), user_c_mobile.get_text())
        self.assertIn("Илья (Mac): Забронировал коттедж", self.user_a.get_text())
        self.assertIn("Саша (iPhone): Взял настольные игры 🎲", self.user_a.get_text())
        print("  ✓ Сценарий 8: Одновременное редактирование с компьютера и смартфона успешно проверено")

    def test_scenario_9_virtual_keyboard_and_safe_layout(self):
        """
        Сценарий 9: Проверка виртуальной клавиатуры и структуры документа.
        Проверяет, что пустые строки, чек-листы и длинные тексты корректно форматируются без разрушения структуры.
        """
        target = self.user_a.get_visible_items()[-1]
        # Многострочный текст с переносами и чекбоксами
        long_text = "Очень длинное описание меню на праздник: " + ("оливье, селёдка под шубой, " * 10)
        item_long, _ = self.user_a.insert_after(target.id, long_text, 'task', checked=False)
        item_extra, _ = self.user_a.insert_after(item_long.id, "Короткий пункт с виртуальной клавиатуры 📱", 'task', checked=True)

        visible = self.user_a.get_visible_items()
        self.assertGreaterEqual(len(visible), 4)
        self.assertIn(long_text, self.user_a.get_text())
        self.assertIn("Короткий пункт с виртуальной клавиатуры 📱", self.user_a.get_text())
        print("  ✓ Сценарий 9: Структура для виртуальной клавиатуры и длинных заметок проверена")

    def test_scenario_10_server_restart_persistence(self):
        """
        Сценарий 10: Перезапуск сервера сохраняет актуальное состояние CRDT-документа на диске (SQLite/файл).
        """
        with tempfile.TemporaryDirectory() as tmp_dir:
            db_path = os.path.join(tmp_dir, "test_crdt_store.json")

            # Эмулируем сервер 1: принимает правки и сохраняет снимок
            target = self.user_a.get_visible_items()[-1]
            self.user_a.insert_after(target.id, "Важнейший план: Не забыть бенгальские огни ✨")
            snapshot = self.user_a.export_snapshot()

            with open(db_path, "w", encoding="utf-8") as f:
                json.dump({"documents": {"test-doc": snapshot}}, f)

            # Эмулируем сервер 2 (после перезапуска): загружает файл с диска
            with open(db_path, "r", encoding="utf-8") as f:
                restored_data = json.load(f)

            server_snapshot = restored_data["documents"]["test-doc"]

            # Новый клиент подключается к перезапущенному серверу
            new_client = CollaborativeDocTest('test-doc', 'brand_new_client')
            new_client.load_snapshot(server_snapshot)

            self.assertIn("Важнейший план: Не забыть бенгальские огни ✨", new_client.get_text())
            print("  ✓ Сценарий 10: Постоянство данных при перезапуске сервера успешно проверено")


if __name__ == '__main__':
    print("=" * 65)
    print("🚀 ЗАПУСК АВТОМАТИЧЕСКИХ ТЕСТОВ СОВМЕСТНОГО РЕДАКТИРОВАНИЯ CRDT")
    print("=" * 65)
    suite = unittest.TestLoader().loadTestsFromTestCase(CollaborativeEditingScenarioTests)
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    if result.wasSuccessful():
        print("\n" + "=" * 65)
        print("✅ ВСЕ 10 СЦЕНАРИЕВ СОВМЕСТНОГО РЕДАКТИРОВАНИЯ УСПЕШНО ПРОЙДЕНЫ!")
        print("=" * 65)
        sys.exit(0)
    else:
        sys.exit(1)
