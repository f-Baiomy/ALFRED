import os, time, datetime
p = '/home/mitmproxy/interception/relive/inflight.json'
last = None; end = time.time() + 60
while time.time() < end:
    try:
        st = os.stat(p); v = open(p).read()
    except OSError:
        v = 'MISSING'
    if v != last:
        print(datetime.datetime.utcnow().strftime('%H:%M:%S.%f')[:-3], v[:300], flush=True); last = v
    time.sleep(0.003)
