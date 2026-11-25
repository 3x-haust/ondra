# One picture from a session's stream (what the app's small browser window shows): exits 0 once a frame arrives.
import base64, json, os, socket, sys

s = socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=15)
key = base64.b64encode(os.urandom(16)).decode()
s.sendall(f"GET /?maxFps=5 HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n".encode())
buf = b""
while b"\r\n\r\n" not in buf:
    buf += s.recv(4096)
head, buf = buf.split(b"\r\n\r\n", 1)
assert b" 101 " in head.split(b"\r\n")[0], head


def need(n):
    global buf
    while len(buf) < n:
        chunk = s.recv(65536)
        if not chunk:
            sys.exit("the stream closed before a frame")
        buf += chunk


for _ in range(20):
    need(2)
    size, off = buf[1] & 0x7F, 2
    if size == 126:
        need(4)
        size, off = int.from_bytes(buf[2:4], "big"), 4
    elif size == 127:
        need(10)
        size, off = int.from_bytes(buf[2:10], "big"), 10
    need(off + size)
    msg, buf = json.loads(buf[off:off + size]), buf[off + size:]
    if msg.get("type") == "frame" and msg.get("data"):
        print(f"frame {len(msg['data'])} bytes")
        sys.exit(0)
sys.exit("no frame in the stream")
