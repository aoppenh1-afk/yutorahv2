Copied byte-for-byte from Lectern main at commit
`793ede35807b02063f262592a426bd604a61ca21`, 2026-09-24:
https://github.com/aoppenh1-afk/Lectern/blob/793ede35807b02063f262592a426bd604a61ca21/.agents/skills/lectern-transcription/SKILL.md

License: ../../LECTERN-LICENSE (MIT, Copyright 2026 Lectern).

The worker reads the complete file, hashes its bytes, and snapshots it in a version
record when enqueueing. Active jobs retain their version; new skill text creates a
new version and cannot reuse old chunks. There is no installed personal-skill dependency.
