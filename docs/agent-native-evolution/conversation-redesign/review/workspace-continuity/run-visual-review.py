"""One Read-only visual discussion; keep image bytes and thinking out of public evidence."""
import datetime
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

base = Path(__file__).resolve().parent
round_name = sys.argv[1]
sources = [Path(p).resolve() for p in sys.argv[2:]]
assert sources and all(p.is_file() and p.suffix.lower() in ('.png', '.jpg', '.jpeg') for p in sources)
prompt_path = base / f'{round_name}-input.md'
prompt = prompt_path.read_text()
cli = '/Users/amos/.local/node/bin/claude'
args = [cli, '--print', '--output-format', 'stream-json', '--verbose', '--safe-mode',
        '--tools', 'Read', '--allowedTools', 'Read',
        '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
        '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
        '--disable-slash-commands', '--no-session-persistence', '--no-chrome',
        '--system-prompt', 'You are Claude Code, the independent product design lead. You may only use Read to inspect the exact synthetic prototype screenshot files named in the user prompt, all copied into the isolated current directory. Do not read any other path or private data. Use Read on every supplied screenshot before giving a visual review. Do not claim to have clicked the UI or run tests. The supplied action results are Codex observations. Reply in Chinese with concrete visual judgments, and distinguish visible evidence from inferred behavior.']
started = time.monotonic()
meta = {'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'cliVersion': subprocess.check_output([cli, '--version'], text=True).strip(),
        'input': prompt_path.name, 'inputCharacters': len(prompt),
        'inputSha256': hashlib.sha256(prompt.encode()).hexdigest(),
        'toolsEnabled': ['Read'], 'allowedTools': ['Read'], 'restrictedMode': False,
        'mcpServers': [], 'safeMode': True, 'sessionPersistence': False, 'modelOverride': None,
        'scope': 'Exact synthetic prototype screenshots only; all screenshot copies reside in an isolated temporary cwd. No research materials or secrets.',
        'arguments': args[1:],
        'screenshots': [{'source': str(p), 'copyName': f'screenshot-{i+1:02d}{p.suffix.lower()}',
                         'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for i,p in enumerate(sources)]}
status_path = base / f'{round_name}-status.json'
status_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2))
raw = ''

def count_images(value):
    if isinstance(value, dict):
        return int(value.get('type') == 'image') + sum(count_images(v) for v in value.values())
    if isinstance(value, list):
        return sum(count_images(v) for v in value)
    return 0

def summarize_trace(stdout):
    trace, final, reads, results = [], None, [], []
    for line in stdout.splitlines():
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        summary = {'type': item.get('type')}
        if item.get('subtype'):
            summary['subtype'] = item['subtype']
        message = item.get('message', {})
        if isinstance(message, dict):
            if message.get('model'):
                summary['model'] = message['model']
            blocks = message.get('content', [])
            if isinstance(blocks, list):
                summary['blockTypes'] = [b.get('type') for b in blocks if isinstance(b, dict) and b.get('type') not in ('thinking', 'redacted_thinking')]
                for block in blocks:
                    if not isinstance(block, dict):
                        continue
                    if block.get('type') == 'tool_use':
                        use = {'name': block.get('name'), 'id': block.get('id')}
                        if use['name'] == 'Read':
                            use['fileName'] = Path(block.get('input', {}).get('file_path', '')).name
                            reads.append(use)
                        summary.setdefault('toolUses', []).append(use)
                    elif block.get('type') == 'tool_result':
                        result = {'toolUseId': block.get('tool_use_id'), 'isError': block.get('is_error', False), 'imageBlocks': count_images(block.get('content'))}
                        results.append(result)
                        summary.setdefault('toolResults', []).append(result)
        if item.get('type') == 'result':
            final = item
            summary.update({k:item.get(k) for k in ('subtype', 'is_error', 'num_turns', 'duration_ms')})
        trace.append(summary)
    meta['readCalls'] = reads
    meta['readCallCount'] = len(reads)
    meta['toolResultCount'] = len(results)
    meta['imageToolResultCount'] = sum(r['imageBlocks'] > 0 for r in results)
    meta['imageBlockCount'] = sum(r['imageBlocks'] for r in results)
    meta['traceSanitization'] = 'Only event types, model, tool names, screenshot basenames and result image counts retained; no thinking, signatures, image/base64 data or raw stream stored.'
    (base / f'{round_name}-trace.json').write_text(json.dumps(trace, ensure_ascii=False, indent=2))
    if final:
        safe = {k:final.get(k) for k in ('type', 'subtype', 'is_error', 'duration_ms', 'duration_api_ms', 'num_turns', 'result', 'total_cost_usd', 'usage', 'modelUsage', 'permission_denials')}
        (base / f'{round_name}-result.json').write_text(json.dumps(safe, ensure_ascii=False, indent=2))
        response = final.get('result', '')
        (base / f'{round_name}-response.md').write_text(response)
        meta.update({'subtype': final.get('subtype'), 'isError': final.get('is_error'), 'models': list(final.get('modelUsage', {})), 'turns': final.get('num_turns'), 'responseCharacters': len(response)})

try:
    with tempfile.TemporaryDirectory(prefix='papertrail-claude-visual-') as isolated:
        for source, info in zip(sources, meta['screenshots']):
            shutil.copyfile(source, Path(isolated) / info['copyName'])
        result = subprocess.run(args, input=prompt, text=True, capture_output=True, cwd=isolated, timeout=240)
    raw = result.stdout
    meta['exitCode'] = result.returncode
    (base / f'{round_name}-stderr.txt').write_text(result.stderr)
except subprocess.TimeoutExpired as problem:
    raw = problem.stdout.decode() if isinstance(problem.stdout, bytes) else problem.stdout or ''
    meta['exitCode'] = None
    meta['error'] = 'timeout after 240 seconds; not a completed discussion'
    stderr = problem.stderr.decode() if isinstance(problem.stderr, bytes) else problem.stderr or ''
    (base / f'{round_name}-stderr.txt').write_text(stderr)
except Exception as problem:
    meta['error'] = str(problem)
finally:
    summarize_trace(raw)
    meta['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    meta['elapsedSeconds'] = round(time.monotonic() - started, 3)
    status_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2))
    print(json.dumps(meta, ensure_ascii=False))
sys.exit(0 if meta.get('exitCode') == 0 and meta.get('subtype') == 'success' and meta.get('isError') is False and meta.get('readCallCount', 0) >= len(sources) and meta.get('imageToolResultCount', 0) >= len(sources) else 1)
