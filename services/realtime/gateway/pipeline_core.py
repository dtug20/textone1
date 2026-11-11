"""Bounded QThread stages. All callbacks execute in worker threads, never Qt GUI slots."""
import queue
import threading
import time
from PySide6.QtCore import QThread


class Stage(QThread):
    def __init__(self, owner, inbox, outbox, function):
        super().__init__()
        self.owner, self.inbox, self.outbox, self.function = owner, inbox, outbox, function

    def run(self):
        while not self.owner.closed.is_set():
            try:
                item = self.inbox.get(timeout=0.1)
            except queue.Empty:
                continue
            if item['generation'] != self.owner.generation:
                continue
            try:
                result = self.function(item)
                if result is not None and item['generation'] == self.owner.generation:
                    if self.outbox is None:
                        self.owner.emit(result)
                    else:
                        self.owner.put(self.outbox, result)
            except Exception as exc:
                if item['generation'] == self.owner.generation:
                    self.owner.emit({'type': 'error', 'error': str(exc), 'generation': item['generation']})
                    self.owner.closed.set()


class Pipeline:
    def __init__(self, recognize, synthesize, emit):
        self.closed = threading.Event()
        self.generation = 0
        self.audio = queue.Queue(maxsize=2)
        self.text = queue.Queue(maxsize=2)
        self.emit = emit
        self.stages = [Stage(self, self.audio, self.text, recognize), Stage(self, self.text, None, synthesize)]
        for stage in self.stages:
            stage.start()

    def put(self, inbox, item):
        while not self.closed.is_set() and item['generation'] == self.generation:
            try:
                inbox.put(item, timeout=0.1)
                return True
            except queue.Full:
                continue
        return False

    def submit(self, item):
        # Live mode keeps latency bounded, with an explicit dropped notification.
        try:
            self.audio.put_nowait(item)
        except queue.Full:
            try:
                dropped = self.audio.get_nowait()
                self.emit({'type': 'dropped', 'generation': dropped['generation']})
            except queue.Empty:
                pass
            self.audio.put_nowait(item)

    def reset(self, generation):
        self.generation = generation
        for inbox in (self.audio, self.text):
            while True:
                try:
                    inbox.get_nowait()
                except queue.Empty:
                    break

    def close(self):
        self.closed.set()
        # Requests have bounded timeouts. Keep QThread objects alive until run exits.
        for stage in self.stages:
            stage.wait()
