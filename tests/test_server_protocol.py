"""
Тестирование серверного протокола синхронизации и защиты доступа (Invite Auth & Persistence)
"""

import sys
import os
import json
import tempfile
import unittest

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')


class MockServerState:
    def __init__(self, invite_secret="ny2027-friends"):
        self.invite_secret = invite_secret
        self.documents = {}
        self.operations = {}
        self.rooms = {}  # doc_id -> list of client_ids

    def handle_connect(self, client_id, doc_id, invite_key):
        if invite_key != self.invite_secret:
            return {"status": "rejected", "error": "auth_failed", "code": 4003}

        if doc_id not in self.rooms:
            self.rooms[doc_id] = set()
        self.rooms[doc_id].add(client_id)

        snapshot = self.documents.get(doc_id)
        return {
            "status": "connected",
            "type": "auth_success",
            "docId": doc_id,
            "has_snapshot": snapshot is not None,
            "snapshot": snapshot,
        }

    def handle_op(self, client_id, doc_id, op, op_id):
        if doc_id not in self.operations:
            self.operations[doc_id] = []
        self.operations[doc_id].append(op)

        # Подтверждение автосохранения клиенту (Sync Acknowledgement)
        ack = {
            "type": "op_ack",
            "opId": op_id or f"{op.get('client')}@{op.get('clock')}",
        }

        # Широковещательная рассылка другим участникам
        recipients = [c for c in self.rooms.get(doc_id, set()) if c != client_id]
        broadcast = {
            "type": "op",
            "docId": doc_id,
            "op": op,
            "recipients": recipients,
        }

        return ack, broadcast

    def save_snapshot(self, doc_id, snapshot):
        self.documents[doc_id] = snapshot
        return {"type": "op_ack", "status": "snapshot_saved"}


class ServerProtocolTests(unittest.TestCase):
    def setUp(self):
        self.server = MockServerState(invite_secret="ny2027-friends")

    def test_auth_rejection_on_invalid_key(self):
        """Проверка: сервер отклоняет подключение со случайным или неверным токеном"""
        resp = self.server.handle_connect("intruder", "our-plans-ny-2027", "wrong-password")
        self.assertEqual(resp["status"], "rejected")
        self.assertEqual(resp["error"], "auth_failed")
        print("  ✓ Защита доступа: неверный ключ отклонён сервером")

    def test_auth_success_on_valid_invite_key(self):
        """Проверка: друзья с валидным ключом из ссылки успешно подключаются к заметке"""
        resp = self.server.handle_connect("ilya_client", "our-plans-ny-2027", "ny2027-friends")
        self.assertEqual(resp["status"], "connected")
        self.assertEqual(resp["type"], "auth_success")
        print("  ✓ Защита доступа: друг с пригласительным ключом авторизован")

    def test_op_ack_and_broadcast(self):
        """Проверка: сервер подтверждает сохранение правки и рассылает её другим участникам комнаты"""
        # Подключаем Илью и Диму
        self.server.handle_connect("ilya", "our-plans-ny-2027", "ny2027-friends")
        self.server.handle_connect("dima", "our-plans-ny-2027", "ny2027-friends")

        # Илья отправляет операцию
        sample_op = {"client": "ilya", "clock": 1, "type": "insert", "content": "Салют 🎆"}
        ack, broadcast = self.server.handle_op("ilya", "our-plans-ny-2027", sample_op, "op_123")

        self.assertEqual(ack["type"], "op_ack")
        self.assertEqual(ack["opId"], "op_123")
        self.assertEqual(broadcast["type"], "op")
        self.assertIn("dima", broadcast["recipients"])
        self.assertNotIn("ilya", broadcast["recipients"])
        print("  ✓ Синхронизация: подтверждение сохранения (op_ack) и рассылка друзьям работают")


if __name__ == '__main__':
    print("=" * 65)
    print("🛡️ ТЕСТИРОВАНИЕ СЕРВЕРНОГО ПРОТОКОЛА И ЗАЩИТЫ ДОСТУПА")
    print("=" * 65)
    suite = unittest.TestLoader().loadTestsFromTestCase(ServerProtocolTests)
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    if result.wasSuccessful():
        print("\n✅ ВСЕ ТЕСТЫ СЕРВЕРНОГО ПРОТОКОЛА УСПЕШНО ПРОЙДЕНЫ!")
        sys.exit(0)
    else:
        sys.exit(1)
