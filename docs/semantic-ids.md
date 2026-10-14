# Semantic IDs

`newSemanticId(kind)` returns `<kind>-<word>-<word>-<word>`, for example `agent-access-action-active`. It samples three distinct entries from a fixed, alphabetically sorted 500-word English vocabulary. Public IDs identify a kind; internal request correlations and digests need not use readable words.

| Prefix | Identifies |
| --- | --- |
| `agent` | Running agent identity |
| `tool` | Tool identity |
| `message` | Routed message |
| `process` | Background process |
| `goal` | Authorized goal |
| `wait` | Response offer |
| `artifact` | Collected workspace result |
| `task` | Task identity |

Generation does not reserve IDs globally or check against other IDs. The three words are distinct within one ID, but IDs can collide across calls. Callers needing uniqueness must use their ownership and identity context. The main agent identity is stored for resume; launched children get a new identity. Operating-system process IDs and Pi session identifiers remain separate implementation data.

Source: [generator](../packages/pi-runtime/src/semantic-id.ts), [vocabulary](../packages/pi-runtime/src/semantic-words.ts), and [tests](../packages/pi-runtime/test/semantic-id.test.ts).

## Tokenizer evidence

The delimiter contexts `-word` and ` word` matter: a spelling need not encode the same way alone. All 500 entries encode as one token in each of those contexts in OpenAI's `o200k_base`; 467 also encode as one token by themselves. A full ID is not a three-token string: `agent-access-action-active` encodes as four tokens in that encoding.

The recorded check used `tiktoken` 0.14.0 and the official [encoding definition](https://github.com/openai/tiktoken/blob/main/tiktoken_ext/openai_public.py). It pins the [BPE asset](https://openaipublic.blob.core.windows.net/encodings/o200k_base.tiktoken) to SHA-256:

```text
446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d
```

These counts concern the named tokenizer asset, ID spelling, and delimiter contexts. They are not universal request-framing counts or a claim about future tokenizer versions. DeepSeek and Claude tokenizers are not asserted or verified. The table is fixed source data and adds no runtime tokenizer or dictionary dependency.
