"""Validate browser-provided caption cues and build a contiguous media timeline."""
import math


def normalize_cues(raw_cues, duration, limit=2000, max_cue_seconds=18):
    if not isinstance(raw_cues, list) or len(raw_cues) > limit:
        raise ValueError('Invalid caption batch')
    result = []
    for raw in raw_cues:
        if not isinstance(raw, dict):
            raise ValueError('Invalid caption cue')
        start = raw.get('start')
        length = raw.get('duration')
        text = raw.get('text', '')
        translated = raw.get('translatedText', '')
        needs_translation = raw.get('needsTranslation', False)
        if not all(isinstance(value, (int, float)) and math.isfinite(value) for value in (start, length)):
            raise ValueError('Invalid caption timing')
        if start < 0 or not 0.08 <= length <= max_cue_seconds or start + length > duration + 0.1:
            raise ValueError(f'Caption timing is outside the video (start {start:.3f}s, length {length:.3f}s, video {duration:.3f}s)')
        if not isinstance(text, str) or not isinstance(translated, str) or len(text) > 1000 or len(translated) > 1000:
            raise ValueError('Invalid caption text')
        if not isinstance(needs_translation, bool):
            raise ValueError('Invalid caption translation mode')
        text = ' '.join(text.split())
        translated = ' '.join(translated.split())
        if not translated:
            raise ValueError(f'Translated caption is empty (start {start:.3f}s)')
        if result and start < result[-1]['start'] + result[-1]['duration'] - 0.01:
            raise ValueError(f"Caption cues overlap ({result[-1]['start']:.3f}s+{result[-1]['duration']:.3f}s > {start:.3f}s)")
        result.append({'start': float(start), 'duration': float(length), 'text': text or translated,
                       'translatedText': translated, 'needsTranslation': needs_translation})
    return result


def caption_items(cues, position, duration, generation, silence_seconds=10):
    """Yield silent coverage and speech items from a seek position to EOF."""
    cursor = max(0.0, min(float(position), float(duration)))

    def silence(until):
        nonlocal cursor
        while until - cursor > 0.01:
            length = min(float(silence_seconds), until - cursor)
            yield {'generation': generation, 'sequence': round(cursor * 1000),
                   'sourceStart': cursor, 'duration': length, 'speechStart': None,
                   'speechEnd': None, 'text': '', 'translatedText': '', 'silent': True}
            cursor += length

    for cue in cues:
        cue_end = cue['start'] + cue['duration']
        if cue_end <= cursor + 0.01:
            continue
        if cue['start'] > cursor + 0.01:
            yield from silence(cue['start'])
        start = cue['start']
        if cue['start'] < cursor - 0.01:
            # Joined mid-sentence. Squeezing the whole translation into the
            # remainder makes it unintelligible: skip the sentence when most of
            # it is over, otherwise keep its real start so the player seeks into it.
            if cue_end - cursor < 0.6 * cue['duration']:
                yield from silence(cue_end)
                continue
        length = cue_end - start
        if length <= 0.01:
            continue
        yield {'generation': generation, 'sequence': round(start * 1000),
               'sourceStart': start, 'duration': length, 'speechStart': 0,
               'speechEnd': length, 'text': cue['text'],
               'translatedText': cue['translatedText'],
               'needsTranslation': cue.get('needsTranslation', False), 'silent': False}
        cursor = cue_end
    yield from silence(duration)
