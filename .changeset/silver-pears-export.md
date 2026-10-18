---
"@spice-ts/core": patch
---

Define control-language `$inputdir` when a source path is supplied and export two-port S vectors with `wrs2p` in Touchstone v1 RI format. Output is retained in `control.files` and may be persisted through a caller-owned `writeControlFile` sink without granting the core filesystem access.
