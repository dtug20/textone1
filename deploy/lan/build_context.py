"""Package existing inference/gateway implementations for Docker without Modal decorators."""
import ast
from pathlib import Path
import shutil
import sys

root = Path(__file__).resolve().parents[2]
realtime_dir = root / 'services' / 'realtime'
out = Path(sys.argv[1]).resolve()
out.mkdir(parents=True, exist_ok=True)

tree = ast.parse((realtime_dir / 'speech' / 'realtime_speech.py').read_text())
imports = next(n for n in tree.body if isinstance(n, ast.With)).body
service = next(n for n in tree.body if isinstance(n, ast.ClassDef))
service.decorator_list = []
for method in service.body:
    if isinstance(method, (ast.FunctionDef, ast.AsyncFunctionDef)):
        method.decorator_list = []
module = ast.Module(body=imports + [service], type_ignores=[])
source = ast.unparse(module)
source = source.replace("download_root='/models'", "download_root='/models', cpu_threads=2")
source += '''\n\ndef create_app():
    if not os.environ.get('CHATTERBOX_API_KEY'):
        raise RuntimeError('CHATTERBOX_API_KEY is required')
    torch.set_num_threads(2)
    engine = SpeechService()
    engine.load()
    return engine.serve()
'''
(out / 'speech_app.py').write_text(source)

tree = ast.parse((realtime_dir / 'gateway' / 'realtime_pipeline.py').read_text())
serve = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'serve')
serve.decorator_list = []
(out / 'gateway_app.py').write_text(ast.unparse(ast.Module(body=[serve], type_ignores=[])))

module_files = [
    realtime_dir / 'gateway' / 'pipeline_core.py',
    realtime_dir / 'media' / 'youtube_source.py',
    realtime_dir / 'media' / 'narration_audio.py',
    realtime_dir / 'speech' / 'speech_context.py',
    realtime_dir / 'media' / 'caption_timeline.py',
    realtime_dir / 'tts' / 'fast_tts.py',
]
for src_file in module_files:
    shutil.copy2(src_file, out / src_file.name)

for name in ['Dockerfile', 'Dockerfile.tts', 'compose.yaml', 'requirements.txt']:
    shutil.copy2(Path(__file__).parent / name, out / name)

print(f'Created LAN build context: {out}')
