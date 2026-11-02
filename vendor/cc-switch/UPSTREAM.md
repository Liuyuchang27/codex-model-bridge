# Upstream source record

Repository: https://github.com/farion1231/cc-switch

Pinned commit: `1cc2c7321395acff94afd00e126804b82dfa534e`

License: MIT. The unmodified upstream [LICENSE](LICENSE), including its copyright notice, is included alongside these files.

These are upstream Rust reference sources, copied without modification. They are not currently linked into the JavaScript gateway and cannot be compiled as a standalone crate: they import other CC Switch modules and dependencies.

| Local copy | Original path | Purpose |
| --- | --- | --- |
| `proxy/providers/codex_compaction.rs` | `src-tauri/src/proxy/providers/codex_compaction.rs` | Adapt third-party task summaries to Codex compaction items and replay those summaries as messages. |
| `proxy/opaque_state_rectifier.rs` | `src-tauri/src/proxy/opaque_state_rectifier.rs` | Recognize rejected opaque state and make bounded, explicitly signaled repairs; preserve encrypted subagent tasks rather than silently deleting them. |
| `mode/stack.rs` | `src-tauri/src/mode/stack.rs` | Encode and resolve provider-qualified model IDs; reject unresolved IDs rather than fall back to another provider. |
| `codex_deepseek_catalog_template.json` | `src-tauri/src/resources/codex_deepseek_catalog_template.json` | Native DeepSeek Responses API model metadata; its instructions are catalog data for the child Codex client. |

Important invariants to retain when adapting:

- A provider-qualified model ID keeps its provider identity; deleted or unknown routes fail explicitly.
- Removing incompatible reasoning after an explicit rejection does not recover its hidden information.
- The `ccswitch-compaction-v1:` wrapper is a recognizable Base64 envelope for an ordinary task summary, not decrypted OpenAI state and not encrypted storage.
- An unreadable current subagent task must not be silently erased.
- Provider responses and promotional-credit billing must be verified separately.

Adapted files should identify their original path and retain the applicable upstream copyright and license notice. Record behavior changes and run integration tests before claiming compatibility.

The JavaScript function `repairRejectedReasoning` in `scripts/bridge.mjs` now adapts the explicit encrypted/plaintext-reasoning rejection checks and foreign ID-prefix cleanup from these sources. Unlike the full upstream implementation, it refuses compaction blocks, agent messages and item references, does not replace encrypted task content, and permits only one same-route retry. Its source comment preserves the upstream copyright and MIT reference. The three Rust reference files remain unmodified.
