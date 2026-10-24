"""Exercise the image's listener guard with real sockets and no VPN state."""
import argparse
import json
from pathlib import Path
import subprocess
import time
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('--image', required=True)
parser.add_argument('--helper-image', default='node:22.23.4-alpine3.24')
parser.add_argument('--output')
args = parser.parse_args()
name = 'wireguard-port-check-' + uuid.uuid4().hex[:10]
holder = name + '-udp'

def docker(*cmd, check=True):
    result = subprocess.run(['docker', *cmd], capture_output=True, text=True, timeout=30)
    if check and result.returncode:
        raise RuntimeError('Docker ' + cmd[0] + ' failed: ' + result.stderr[-500:])
    return result

try:
    docker('run', '-d', '--name', name, '--network', 'none', '--cpus', '1', '--memory', '256m',
           '--entrypoint', 'sh', args.image, '-c', 'sleep infinity')
    script = docker('exec', name, 'cat', '/etc/s6-overlay/s6-rc.d/svc-coredns/run').stdout
    line = next(line.strip() for line in script.splitlines() if line.startswith('if netstat '))
    guard = line.removeprefix('if ').split(' && [[', 1)[0]
    docker('run', '-d', '--name', holder, '--network', 'container:' + name, '--cpus', '1', '--memory', '128m',
           '--entrypoint', 'node', args.helper_image, '-e',
           "const s=require('dgram').createSocket('udp4');s.connect(53,'127.0.0.1',()=>console.log('connected'));setInterval(()=>{},10000)")
    for _ in range(30):
        if 'connected' in docker('logs', holder).stdout:
            break
        time.sleep(.1)
    else:
        raise RuntimeError('UDP fixture did not become ready')
    # Reproduce the original false positive while there is no listening server.
    assert docker('exec', name, 'sh', '-c', 'netstat -apn | grep -q ":53 "', check=False).returncode == 0
    assert docker('exec', name, 'sh', '-c', guard, check=False).returncode == 1, 'Outgoing DNS socket was mistaken for a listener'
    # Then start a real listener. The same image-provided guard must detect it.
    docker('exec', name, 'sh', '-c', "printf '.:53 {\\n    errors\\n}\\n' > /tmp/port-check-Corefile")
    docker('exec', '-d', name, '/usr/bin/coredns', '-conf', '/tmp/port-check-Corefile')
    for _ in range(30):
        if docker('exec', name, 'sh', '-c', guard, check=False).returncode == 0:
            break
        time.sleep(.1)
    else:
        raise AssertionError('Actual DNS listener was not detected')
    result = {'success': True, 'oldCheckFalsePositiveReproduced': True,
              'outgoingDnsSocketIgnored': True, 'actualDnsListenerDetected': True,
              'productionStateMounted': False, 'network': 'none'}
finally:
    docker('rm', '-f', '-v', holder, check=False)
    docker('rm', '-f', '-v', name, check=False)

if args.output:
    Path(args.output).write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
