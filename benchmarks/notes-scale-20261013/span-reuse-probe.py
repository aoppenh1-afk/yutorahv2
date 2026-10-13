"""Offline size experiment for returning source references instead of copied text.

The encoder sees already-generated notes. This does not test whether a model can
produce references correctly, and it does not measure tokens or generation speed.
No model, network, database, or production calls.
"""
from pathlib import Path
import hashlib
import json
import re


class SubstringIndex:
    def __init__(self, source):
        self.states = [{"next": {}, "link": -1, "length": 0, "position": -1}]
        last = 0
        for position, char in enumerate(source):
            current = len(self.states)
            self.states.append({"next": {}, "link": 0, "length": self.states[last]["length"] + 1, "position": position})
            state = last
            while state >= 0 and char not in self.states[state]["next"]:
                self.states[state]["next"][char] = current
                state = self.states[state]["link"]
            if state >= 0:
                target = self.states[state]["next"][char]
                if self.states[state]["length"] + 1 == self.states[target]["length"]:
                    self.states[current]["link"] = target
                else:
                    clone = len(self.states)
                    self.states.append({"next": dict(self.states[target]["next"]), "link": self.states[target]["link"], "length": self.states[state]["length"] + 1, "position": self.states[target]["position"]})
                    while state >= 0 and self.states[state]["next"].get(char) == target:
                        self.states[state]["next"][char] = clone
                        state = self.states[state]["link"]
                    self.states[target]["link"] = self.states[current]["link"] = clone
            last = current

    def match(self, text, start):
        state = 0
        end = start
        while end < len(text) and text[end] in self.states[state]["next"]:
            state = self.states[state]["next"][text[end]]
            end += 1
        length = end - start
        return self.states[state]["position"] - length + 1, length


root = Path(__file__).resolve().parents[2]
corpus = root / "benchmarks/opencode-notes-20261008"
results = []
for filename in sorted(corpus.glob("*-opencode-1-notes.md")):
    if not re.fullmatch(r"[0-9]+-opencode-1-notes\.md", filename.name):
        continue
    shiur_id = filename.name.split("-")[0]
    source = (corpus / f"{shiur_id}-transcript.md").read_text()
    note = filename.read_text()
    index = SubstringIndex(source)
    segments, literal, position, copied = [], [], 0, 0
    while position < len(note):
        offset, length = index.match(note, position)
        if length >= 64:
            if literal:
                segments.append(["t", "".join(literal)])
                literal = []
            segments.append(["s", offset, length])
            copied += len(source[offset:offset + length].encode())
            position += length
        else:
            literal.append(note[position])
            position += 1
    if literal:
        segments.append(["t", "".join(literal)])
    expanded = "".join(segment[1] if segment[0] == "t" else source[segment[1]:segment[1] + segment[2]] for segment in segments)
    assert expanded == note, "Expansion changed the note"
    raw_bytes = len(note.encode())
    encoded_bytes = len(json.dumps(segments, ensure_ascii=False, separators=(",", ":")).encode())
    results.append({"id": shiur_id, "noteBytes": raw_bytes, "encodedBytes": encoded_bytes,
                    "copiedSourceBytes": copied, "reductionPercent": round(100 * (1 - encoded_bytes / raw_bytes), 1),
                    "references": sum(segment[0] == "s" for segment in segments), "roundTripExact": True,
                    "sourceHash": hashlib.sha256(source.encode()).hexdigest(), "noteHash": hashlib.sha256(note.encode()).hexdigest()})

artifact = {
    "method": "Greedy exact substring references of at least 64 Unicode code points, mixed with literal text in compact JSON. Encoded offsets use Python Unicode positions. Original eight Muse benchmark notes, no pilot files. Every expansion asserted identical to the saved note. Encoder knows the completed note. Model selection accuracy, added input labeling, tokenizer effects, and speed unmeasured; this is not a bound on all possible reference encodings.",
    "noteBytes": sum(item["noteBytes"] for item in results),
    "encodedBytes": sum(item["encodedBytes"] for item in results),
    "results": results,
}
artifact["reductionPercent"] = round(100 * (1 - artifact["encodedBytes"] / artifact["noteBytes"]), 1)
(Path(__file__).parent / "span-reuse-probe.json").write_text(json.dumps(artifact, indent=2) + "\n")
print(json.dumps(artifact, indent=2))
