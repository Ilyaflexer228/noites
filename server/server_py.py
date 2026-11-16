"""
Автономный WebSocket CRDT-сервер на Python 3 с постоянным хранилищем и защитой доступа
"""

import sys
import os
import json
import base64
import hashlib
import struct
import asyncio
import secrets

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

PORT = int(os.environ.get('PORT', 1234))
DATA_DIR = os.environ.get('DATA_DIR', os.path.join(os.path.dirname(__file__), 'data'))
DB_FILE = os.path.join(DATA_DIR, 'crdt_store.sqlite.json')

os.makedirs(DATA_DIR, exist_ok=True)

class PersistentDatabase:
    def __init__(self, path):
        self.path = path
        self.state = {"metadata": {}, "documents": {}, "operations": {}}
        self.load()
        self.ensure_secret()

    def load(self):
        if os.path.exists(self.path):
            try:
                with open(self.path, 'r', encoding='utf-8') as f:
                    self.state = json.load(f)
            except Exception:
                pass

    def save(self):
        try:
            tmp = f"{self.path}.{os.getpid()}.tmp"
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(self.state, f, ensure_ascii=False, indent=2)
            os.replace(tmp, self.path)
            return True
        except Exception as e:
            print(f"[DB] Save error: {e}")
            return False

    def ensure_secret(self):
        env_secret = os.environ.get('INVITE_SECRET')
        if env_secret:
            self.invite_secret = env_secret
        elif 'invite_secret' in self.state.get("metadata", {}):
            self.invite_secret = self.state["metadata"]["invite_secret"]
        else:
            self.invite_secret = os.environ.get('DEFAULT_INVITE_SECRET', 'ny2027-friends')
            self.state.setdefault("metadata", {})["invite_secret"] = self.invite_secret
            self.save()

    def has_op(self, doc_id, op_id):
        return bool(self.state.get("operations", {}).get(doc_id, {}).get(op_id))

    def save_op_and_apply(self, doc_id, op, op_id):
        self.state.setdefault("operations", {}).setdefault(doc_id, {})[op_id] = op
        snapshot = self.state.setdefault("documents", {}).setdefault(doc_id, {"docId": doc_id, "items": [], "clock": 0})
        
        op_type = op.get('type')
        op_id_val = op.get('id')
        clock = op.get('clock', 0)

        if op_type == 'insert':
            existing = next((i for i in snapshot["items"] if i["id"] == op_id_val), None)
            if not existing:
                snapshot["items"].append({
                    "id": op_id_val,
                    "leftId": op.get("leftId"),
                    "rightId": op.get("rightId"),
                    "content": op.get("content", ""),
                    "type": op.get("itemType", "text"),
                    "checked": bool(op.get("checked", False)),
                    "clock": clock,
                    "deleted": False
                })
        elif op_type == 'text_update':
            item = next((i for i in snapshot["items"] if i["id"] == op_id_val), None)
            if item and clock >= item.get("clock", 0):
                item["content"] = op.get("content", "")
                item["clock"] = clock
        elif op_type == 'delete':
            item = next((i for i in snapshot["items"] if i["id"] == op_id_val), None)
            if item:
                item["deleted"] = True
                item["deletedClock"] = clock
        elif op_type == 'toggle_task':
            item = next((i for i in snapshot["items"] if i["id"] == op_id_val), None)
            if item:
                item["checked"] = op.get("checked", False)
                item["checkedClock"] = clock
        elif op_type == 'type_update':
            item = next((i for i in snapshot["items"] if i["id"] == op_id_val), None)
            if item:
                item["type"] = op.get("itemType", "text")
                item["clock"] = clock

        snapshot["clock"] = max(snapshot.get("clock", 0), clock)
        return self.save()

    def get_snapshot(self, doc_id):
        return self.state.get("documents", {}).get(doc_id)

db = PersistentDatabase(DB_FILE)
rooms = {}  # doc_id -> set of WebSocketClient

class WebSocketClient:
    def __init__(self, reader, writer):
        self.reader = reader
        self.writer = writer
        self.doc_id = 'our-plans-ny-2027'
        self.client_id = ''
        self.is_connected = True

    async def send_text(self, text):
        if not self.is_connected:
            return
        payload = text.encode('utf-8')
        length = len(payload)
        frame = bytearray([0x81])
        if length <= 125:
            frame.append(length)
        elif length <= 65535:
            frame.append(126)
            frame.extend(struct.pack('!H', length))
        else:
            frame.append(127)
            frame.extend(struct.pack('!Q', length))
        frame.extend(payload)
        try:
            self.writer.write(frame)
            await self.writer.drain()
        except Exception:
            self.is_connected = False

    async def read_frame(self):
        try:
            header = await self.reader.readexactly(2)
        except Exception:
            return None, None

        b1, b2 = header[0], header[1]
        opcode = b1 & 0x0F
        masked = (b2 & 0x80) != 0
        length = b2 & 0x7F

        if length == 126:
            data = await self.reader.readexactly(2)
            length = struct.unpack('!H', data)[0]
        elif length == 127:
            data = await self.reader.readexactly(8)
            length = struct.unpack('!Q', data)[0]

        mask = None
        if masked:
            mask = await self.reader.readexactly(4)

        payload = await self.reader.readexactly(length)
        if masked:
            unmasked = bytearray(length)
            for i in range(length):
                unmasked[i] = payload[i] ^ mask[i % 4]
            payload = unmasked

        return opcode, payload

async def handle_connection(reader, writer):
    headers = {}
    path = '/'
    while True:
        line = await reader.readline()
        if not line or line == b'\r\n':
            break
        line_str = line.decode('utf-8', errors='ignore').strip()
        if line_str.startswith('GET'):
            parts = line_str.split(' ')
            if len(parts) > 1:
                path = parts[1]
        elif ':' in line_str:
            k, v = line_str.split(':', 1)
            headers[k.strip().lower()] = v.strip()

    sec_key = headers.get('sec-websocket-key')
    if not sec_key:
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"status\":\"ok\"}")
        await writer.drain()
        writer.close()
        return

    doc_id = 'our-plans-ny-2027'
    invite_key = ''
    client_id = 'client_' + secrets.token_hex(4)

    if '?' in path:
        query_str = path.split('?', 1)[1]
        for pair in query_str.split('&'):
            if '=' in pair:
                k, v = pair.split('=', 1)
                if k == 'doc': doc_id = v
                elif k == 'key': invite_key = v
                elif k == 'client': client_id = v

    # Проверка ключа доступа
    if not invite_key or invite_key != db.invite_secret:
        writer.write(b"HTTP/1.1 403 Forbidden\r\n\r\n")
        await writer.drain()
        writer.close()
        return

    accept_val = base64.b64encode(hashlib.sha1((sec_key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
    handshake = (
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {accept_val}\r\n\r\n"
    )
    writer.write(handshake.encode('utf-8'))
    await writer.drain()

    client = WebSocketClient(reader, writer)
    client.doc_id = doc_id
    client.client_id = client_id

    rooms.setdefault(doc_id, set()).add(client)

    await client.send_text(json.dumps({'type': 'auth_success', 'clientId': client_id, 'docId': doc_id}))

    snapshot = db.get_snapshot(doc_id)
    if snapshot:
        await client.send_text(json.dumps({'type': 'snapshot', 'docId': doc_id, 'snapshot': snapshot}))

    try:
        while client.is_connected:
            opcode, payload = await client.read_frame()
            if opcode is None or opcode == 0x8:
                break
            if opcode == 0x9:
                writer.write(bytearray([0x8A, 0x00]))
                await writer.drain()
                continue
            if opcode == 0x1:
                msg = json.loads(payload.decode('utf-8', errors='ignore'))
                msg_type = msg.get('type')

                if msg_type == 'sync_step_1':
                    sn = db.get_snapshot(doc_id)
                    if sn:
                        await client.send_text(json.dumps({'type': 'sync_step_2', 'docId': doc_id, 'snapshot': sn}))

                elif msg_type == 'op':
                    op = msg.get('op')
                    op_id = msg.get('opId') or (f"{op.get('client')}@{op.get('clock')}" if op else None)
                    if op and op_id:
                        saved = True
                        if not db.has_op(doc_id, op_id):
                            saved = db.save_op_and_apply(doc_id, op, op_id)
                        if saved:
                            await client.send_text(json.dumps({'type': 'op_ack', 'opId': op_id}))
                            broadcast_data = json.dumps({'type': 'op', 'docId': doc_id, 'op': op})
                            for peer in list(rooms.get(doc_id, [])):
                                if peer != client and peer.is_connected:
                                    asyncio.create_task(peer.send_text(broadcast_data))
                        else:
                            await client.send_text(json.dumps({'type': 'op_error', 'opId': op_id, 'error': 'Save failed'}))

                elif msg_type == 'awareness':
                    broadcast_data = json.dumps({
                        'type': 'awareness',
                        'docId': doc_id,
                        'clientId': msg.get('clientId'),
                        'state': msg.get('state'),
                    })
                    for peer in list(rooms.get(doc_id, [])):
                        if peer != client and peer.is_connected:
                            asyncio.create_task(peer.send_text(broadcast_data))

                elif msg_type == 'ping':
                    await client.send_text(json.dumps({'type': 'pong'}))

    except Exception:
        pass
    finally:
        client.is_connected = False
        if doc_id in rooms and client in rooms[doc_id]:
            rooms[doc_id].remove(client)
            disconnect_msg = json.dumps({
                'type': 'awareness',
                'docId': doc_id,
                'clientId': client_id,
                'state': {'disconnected': True},
            })
            for peer in list(rooms.get(doc_id, [])):
                if peer.is_connected:
                    asyncio.create_task(peer.send_text(disconnect_msg))
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass

async def main():
    server = await asyncio.start_server(handle_connection, '0.0.0.0', PORT)
    async with server:
        await server.serve_forever()

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
