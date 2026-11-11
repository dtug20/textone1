"""Small, deterministic helpers for joining overlapping streaming ASR text."""
import re
import unicodedata


def _word_key(word: str) -> str:
    normalized = unicodedata.normalize("NFKC", word).casefold()
    return re.sub(r"(^\W+|\W+$)", "", normalized, flags=re.UNICODE)


def merge_context(prefix: str, current: str, max_overlap: int = 16) -> tuple[str, str]:
    """Remove repeated words produced by overlapping audio and join the phrase."""
    prefix_words = prefix.strip().split()
    current_words = current.strip().split()
    if prefix_words and current_words:
        fragment = _word_key(prefix_words[-1])
        next_word = _word_key(current_words[0])
        visibly_cut = prefix_words[-1].endswith(("-", "–", "—"))
        short_cut = len(fragment) <= 2
        if fragment and next_word.startswith(fragment) and (visibly_cut or short_cut):
            prefix_words.pop()
    overlap = 0
    limit = min(max_overlap, len(prefix_words), len(current_words))
    for size in range(1, limit + 1):
        left = [_word_key(word) for word in prefix_words[-size:]]
        right = [_word_key(word) for word in current_words[:size]]
        if all(left) and left == right:
            overlap = size
    unique = " ".join(current_words[overlap:]).strip()
    clean_prefix = " ".join(prefix_words)
    combined = " ".join(part for part in (clean_prefix, unique) if part)
    return unique, combined
