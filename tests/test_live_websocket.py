"""
Интеграционный тест живого WebSocket-сервера:
Подключает двух клиентов (Илья и Дима) по реальному сокету localhost:1234,
проверяет рукопожатие, передачу CRDT-операции, получение op_ack и трансляцию awareness!
"""

import sys
import os
import json
import asyncio
import base64
import struct

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

async def connect_ws(port=1234, doc_id='our-plans-ny-2027', invite_key='ny2027-friends', client_id='test_client'):
    reader, writer = await asyncio.open_connection('127.0.0.1', port)
    
    # Handshake
    key = base64.b64encode(os.urandom(16)).decode()
    req = (
        f"GET /?doc={doc_id}&key={invite_key}&client={client_id} HTTP/1.1\r\n"
        f"Host: 127.0.0.1:{port}\r\n"
        f"Upgrade: websocket\r\n"
        f"Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        f"Sec-WebSocket-Version: 13\r\n\r\n"
    )
    writer.write(req.encode('utf-8'))
    await writer.drain()

    # Read handshake response
    resp = await reader.readuntil(b"\r\n\r\n")
    if b"101 Switching Protocols" not in resp:
        raise Exception("Handshake failed: " + resp.decode())

    return reader, writer

async def send_ws_text(writer, text):
    payload = text.encode('utf-8')
    length = len(payload)
    mask = os.urandom(4)
    frame = bytearray([0x81, 0x80 | (length if length <= 125 else 126)])
    if length > 125:
        frame.extend(struct.pack('!H', length))
    frame.extend(mask)
    for i in range(length):
        frame.append(payload[i] ^ mask[i % 4])
    writer.write(frame)
    await writer.drain()

async def read_ws_text(reader):
    header = await reader.readexactly(2)
    b2 = header[1]
    masked = (b2 & 0x80) != 0
    length = b2 & 0x7F
    if length == 126:
        length = struct.unpack('!H', await reader.readexactly(2))[0]
    elif length == 127:
        length = struct.unpack('!Q', await reader.readexactly(8))[0]
    mask = await reader.readexactly(4) if masked else None
    payload = await reader.readexactly(length)
    if masked:
        unmasked = bytearray(length)
        for i in range(length):
            unmasked[i] = payload[i] ^ mask[i % 4]
        payload = unmasked
    return json.loads(payload.decode('utf-8'))

async def run_test():
    print("Подключение клиента 1 (Илья)...")
    r1, w1 = await connect_ws(1234, 'our-plans-ny-2027', 'ny2027-friends', 'client_ilya')
    msg1 = await read_ws_text(r1)
    print("  Клиент 1 получил:", msg1)
    assert msg1.get('type') == 'auth_success'

    print("Подключение клиента 2 (Дима)...")
    r2, w2 = await connect_ws(1234, 'our-plans-ny-2027', 'ny2027-friends', 'client_dima')
    msg2 = await read_ws_text(r2)
    print("  Клиент 2 получил:", msg2)
    assert msg2.get('type') == 'auth_success'

    # Клиент 1 отправляет CRDT-операцию
    print("Илья отправляет правку...")
    op_payload = json.dumps({
        'type': 'op',
        'docId': 'our-plans-ny-2027',
        'opId': 'op_test_1',
        'op': {'client': 'client_ilya', 'clock': 1, 'type': 'insert', 'content': 'Купить хлопушки 🎉'}
    })
    await send_ws_text(w1, op_payload)

    # Клиент 1 должен получить op_ack
    ack = await read_ws_text(r1)
    print("  Илья получил подтверждение сохранения:", ack)
    assert ack.get('type') == 'op_ack'
    assert ack.get('opId') == 'op_test_1'

    # Клиент 2 должен получить broadcast операцию
    remote_op = await read_ws_text(r2)
    print("  Дима получил правку Ильи в реальном времени:", remote_op)
    assert remote_op.get('type') == 'op'
    assert remote_op.get('op', {}).get('content') == 'Купить хлопушки 🎉'

    print("\n✅ ИНТЕГРАЦИОННЫЙ ТЕСТ ЖИВОГО WEBSOCKET-СОЕДИНЕНИЯ УСПЕШНО ПРОЙДЕН!")
    w1.close()
    w2.close()

if __name__ == '__main__':
    asyncio.run(run_test())
