import base64, json, os, socket, struct, sys, urllib.parse


def http_get(url):
    u = urllib.parse.urlsplit(url)
    s = socket.create_connection((u.hostname, u.port or 80))
    path = u.path + ('?' + u.query if u.query else '')
    s.sendall(f'GET {path} HTTP/1.1\r\nHost: {u.netloc}\r\n\r\n'.encode())
    data = b''
    while True:
        chunk = s.recv(65536)
        if not chunk:
            break
        data += chunk
    s.close()
    head, _, body = data.partition(b'\r\n\r\n')
    return int(head.split()[1]), body.decode()


def ws_connect(url):
    u = urllib.parse.urlsplit(url)
    s = socket.create_connection((u.hostname, u.port or 80))
    key = base64.b64encode(os.urandom(16)).decode()
    path = u.path + ('?' + u.query if u.query else '')
    s.sendall((f'GET {path} HTTP/1.1\r\nHost: {u.netloc}\r\nUpgrade: websocket\r\n'
               f'Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n').encode())
    f = s.makefile('rb')
    status = f.readline().decode().strip()
    while f.readline() not in (b'\r\n', b''):
        pass
    if ' 101 ' not in status:
        print('handshake', status, f.read().decode().strip())
        sys.exit(2)
    return s, f


def ws_send(s, text, opcode=1):
    data = text.encode() if isinstance(text, str) else text
    mask = os.urandom(4)
    n = len(data)
    head = bytes([0x80 | opcode])
    if n < 126:
        head += bytes([0x80 | n])
    elif n < 65536:
        head += bytes([0x80 | 126]) + struct.pack('>H', n)
    else:
        head += bytes([0x80 | 127]) + struct.pack('>Q', n)
    s.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))


def ws_recv(f):
    b0, b1 = f.read(2)
    n = b1 & 0x7f
    if n == 126:
        n = struct.unpack('>H', f.read(2))[0]
    elif n == 127:
        n = struct.unpack('>Q', f.read(8))[0]
    return b0 & 0x0f, f.read(n)


class Cdp:
    def __init__(self, url):
        self.s, self.f = ws_connect(url)
        self.next = 0
        self.events = []

    def wait(self, method, session):
        while True:
            for event in self.events:
                if event.get('method') == method and event.get('sessionId') == session:
                    self.events.remove(event)
                    return event
            self.events.append(self.read())

    def read(self):
        op, payload = ws_recv(self.f)
        if op == 8:
            raise SystemExit('closed ' + str(struct.unpack('>H', payload[:2])[0]) + ' ' + payload[2:].decode())
        return json.loads(payload)

    def call(self, method, params=None, session=None):
        self.next += 1
        msg = {'id': self.next, 'method': method, 'params': params or {}}
        if session:
            msg['sessionId'] = session
        ws_send(self.s, json.dumps(msg))
        while True:
            reply = self.read()
            if 'method' in reply:
                self.events.append(reply)
            elif reply.get('id') == self.next:
                if 'error' in reply:
                    raise SystemExit('error ' + json.dumps(reply['error']))
                return reply['result']


def main():
    mode = sys.argv[1]
    base = os.environ['SLICC_CDP_URL']
    if mode == 'env':
        print(base)
    elif mode == 'version':
        query = sys.argv[2] if len(sys.argv) > 2 else ''
        status, body = http_get('http://127.0.0.1:9222/json/version' + query)
        print(status, body.strip())
    elif mode == 'get':
        status, body = http_get('http://127.0.0.1:9222' + sys.argv[2])
        print(status, body.strip())
    elif mode == 'ws':
        ws_connect(sys.argv[2])
        print('open')
    elif mode == 'drive':
        status, body = http_get('http://127.0.0.1:9222/json/version')
        url = json.loads(body)['webSocketDebuggerUrl']
        if len(sys.argv) > 3:
            url += ('&' if '?' in url else '?') + 'runtime=' + sys.argv[3]
        cdp = Cdp(url)
        targets = cdp.call('Target.getTargets')['targetInfos']
        print('targets', len(targets))
        target = cdp.call('Target.createTarget', {'url': 'about:blank'})['targetId']
        session = cdp.call('Target.attachToTarget', {'targetId': target, 'flatten': True})['sessionId']
        cdp.call('Page.enable', {}, session)
        nav = cdp.call('Page.navigate', {'url': sys.argv[2]}, session)
        cdp.wait('Page.loadEventFired', session)
        print('navigated', 'frameId' in nav, 'errorText' in nav)
        shot = cdp.call('Page.captureScreenshot', {}, session)
        print('screenshot', base64.b64decode(shot['data'])[:8].hex())
        cdp.call('Target.closeTarget', {'targetId': target})
        print('done')
    elif mode == 'hold':
        cdp = Cdp(base)
        print('held', flush=True)
        op, payload = ws_recv(cdp.f)
        print('closed', op, struct.unpack('>H', payload[:2])[0], payload[2:].decode())


main()
