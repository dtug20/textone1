# TexTone LAN GPU

Target: `atin-tts@192.168.1.198:/home/atin-tts/dang/tung/textone-lan`.
The deployment is isolated from existing containers. GPU is shared; CPU/RAM limits
are not GPU/VRAM reservations. Do not stop unrelated workloads.

Build context (reuses the current Modal implementation without importing Modal):

```sh
python3 deploy/lan/build_context.py /tmp/textone-lan-build
```

Copy that directory to the target. `.env` must be mode 0600 and contain only:

```
CHATTERBOX_API_KEY=<existing service key matching web and TTS>
PIPELINE_APP_URL=https://textone.id.vn
VITERBOX_API_URL=<existing Vietnamese TTS endpoint>
CHATTERBOX_API_URL=<existing English TTS endpoint>
```

Do not copy the full web `.env`, database credentials or session signing key.
Run `docker compose build && docker compose up -d`. Speech loads Whisper
large-v3-turbo and EnViT5 Translation (FP16) once and warms up before accepting requests.
Model cache persists under `models/`. Run one speech process to avoid duplicating
GPU models. A separate CPU container keeps Piper and the Vietnamese
`vi_VN-vais1000-medium` voice resident. The gateway overlaps recognition of the
next segment with synthesis of the preceding segment via QThread.
The initial model download/load can take minutes; this is not playback latency.

The Piper voice dataset is CC BY 4.0; retain attribution to VAIS-1000 and its
model card. Piper 1.8.0 is GPL-3.0-or-later. See `/voices/MODEL_CARD` in the image.

The English/Vietnamese translator is `VietAI/envit5-translation`, whose model card
lists the OpenRAIL license and describes training on MTet and PhoMT:
https://huggingface.co/VietAI/envit5-translation

## Extension connection

The gateway stays on server loopback. Piper also listens on `192.168.1.198:18803`
so a web process on this LAN can synthesize Vietnamese speech. Keep this command running on the viewing
computer (SSH authenticates normally; never put a password in the command):

```sh
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
  -L 18802:127.0.0.1:18802 -L 18803:127.0.0.1:18803 \
  atin-tts@192.168.1.198
```

Reload extension **0.8.3** and YouTube. Create a fresh session on `/realtime` and
press **Bắt đầu thuyết minh**. There is no pipeline selector: the extension detects
the loopback gateway automatically and otherwise uses the WSS endpoint returned by
the web API. Close popup: audio should continue. Pause/seek: old audio must stop and
be discarded. This is computer-specific; other viewers need their own tunnel or a
properly authenticated public TLS endpoint.

## Limits and operations

For YouTube, extension 0.8.3 first uses publisher-supplied timestamped English
captions and falls back to YouTube English ASR only when an authored track is absent.
It groups rolling ASR fragments into grammatical sentences of up to 18 seconds.
A target-language track is used directly when available; otherwise EnViT5 translates
the complete sentence without calling Whisper. Pause stops narration; seek resets queued work and
continues at the matching cue. Videos without usable captions and other HTTP(S)
pages automatically use bounded tab capture. This does not guarantee lip sync.

Caption mode prepares up to 60 seconds beyond the playhead. Playback waits for 15
continuous seconds once at startup or after a seek, while twelve nearby utterances
are preloaded in the tab. Translation still receives a complete sentence; the
sentence is synthesized before its first subtitle timestamp instead of waiting for
the speaker to finish it during playback.

Piper uses `FAST_TTS_LENGTH_SCALE=0.76`, about eight percent faster than the prior
0.82 setting. The gateway still time-fits any overlong WAV and the browser stops it
at the caption boundary, so narration cannot continue into the following cue.

Inspect: `docker compose ps`, `docker compose logs --tail 60 speech fast-tts gateway`.
Stop only this deployment: `docker compose down` (model cache remains).
Never expose unauthenticated GPU inference ports or publish the service key.

## Verified deployment — 2026-10-03

Both containers started successfully on the requested RTX 3090 server. Authenticated
speech health returns 200; missing service key returns 403. Gateway WebSocket
produced Vietnamese text and nonempty WAV through the SSH tunnel.

Benchmark input: first 3 seconds of whisper.cpp samples/jfk.wav, repeated, EN→VI
with voice Lan. This is a short smoke benchmark, not a general latency SLA.

- Five STT+translation calls: 588, 884, 925, 629, 548 ms client wall time.
- Full pipeline first request: 25,167 ms; TTS accounted for 24,506 ms.
- Four following requests: 2,866 / 2,690 / 2,572 / 2,263 ms.
- Above timings begin **after** the 3-second input has been collected; add capture
  time and playback buffer to compare with the start of source speech.
- Model server is warm/persistent. TTS remains remote and can still cold start.

Commands for reproducing (temporary diagnostic session must be cleaned up):

```sh
node scripts/benchmark-lan-speech.mjs /path/to/3-second-16k-mono-pcm16.wav
node --import tsx scripts/verify-pipeline-session.ts
node scripts/benchmark-lan-pipeline.mjs /path/to/3-second-16k-mono-pcm16.wav
node scripts/benchmark-lan-context.mjs /path/to/at-least-3.68-second-16k-mono-pcm16.wav
node --import tsx scripts/verify-pipeline-session.ts cleanup
```

A follow-up full-pipeline request took 4,395 ms (TTS 3,829 ms), demonstrating
load/network variability beyond the initial warm range. A reset to generation 1
returned a valid WAV with the new sequence; browser pause/seek is still a separate
manual acceptance check. Temporary diagnostic DB session was removed after tests.

## Verified low-latency TTS — 2026-10-10

The Docker deployment now uses the resident Piper Vietnamese service with a
16-vCPU quota. Direct TTS generated roughly 2.7–2.8 seconds of narration in
0.37–0.52 seconds during the full-pipeline run. Five sequential EN→VI requests
completed inside the gateway in 0.924–1.042 seconds after upload; client wall time
was 1.095–1.321 seconds. A six-segment cadence test at one upload every three
seconds returned all six WAVs with no dropped segment; gateway totals were
0.905–1.012 seconds. Startup warmup took 7.5–9.0 seconds and occurs before `ready`.

These measurements use one repeated 3.71-second test utterance on a shared RTX 3090
host. They prove steady-state throughput for that sample, not zero delay: live audio
must first reach a pause or the two-second segment limit. CPU quota matters on this
host; reducing `fast-tts.cpus` from 16 made the same synthesis substantially slower.

## Verified context-aware boundaries — 2026-10-10

Protocol v2 was tested with one 3.68-second utterance split at 2 seconds and the
same 320 ms overlap used by AudioWorklet. The first forced window was emitted only
as a partial transcript. The second window produced one committed sentence and one
WAV; the incomplete `s-` at the first boundary was replaced by `stay`, yielding
`Real-time speech translation should stay synchronized with the video.` Backend
processing after the second upload was 0.919 seconds (ASR+translation 0.560 seconds,
TTS 0.359 seconds). A separate six-window cadence run returned 6/6 WAVs with zero
drops and gateway totals of 1.045–1.214 seconds. These figures are a warm, single
sample check on the current shared host, not a general latency guarantee.
